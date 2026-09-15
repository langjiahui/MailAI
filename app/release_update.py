"""Cross-platform release discovery and user-confirmed installer launch."""
from __future__ import annotations

import hashlib
import json
import logging
import os
import platform
import re
import ssl
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

import certifi

from .paths import APP_DIR, FROZEN, USER_DIR

log = logging.getLogger(__name__)

DEFAULT_MANIFEST_URL = (
    "https://github.com/langjiahui/MailAI/releases/latest/download/latest.json"
)
MANIFEST_MAX_BYTES = 1024 * 1024
DOWNLOAD_MAX_BYTES = 500 * 1024 * 1024
_CACHE_SECONDS = 30 * 60
_lock = threading.Lock()
_cache: dict[str, object] = {"checked_at": 0.0, "result": None}
_install_guard = threading.Lock()
_install_state_lock = threading.Lock()
_install_state: dict[str, object] = {
    "status": "idle", "phase": "idle", "running": False, "downloaded": 0,
    "total": 0, "percent": 0, "speed_bps": 0, "message": "尚未开始下载", "error": "",
}


def _ssl_context() -> ssl.SSLContext:
    """Use the bundled CA store instead of relying on a host Python install."""
    return ssl.create_default_context(cafile=certifi.where())


def current_version() -> str:
    override = os.getenv("MAILAI_APP_VERSION", "").strip()
    if override:
        return override.lstrip("v")
    for candidate in (APP_DIR / "VERSION", Path(__file__).resolve().parent.parent / "VERSION"):
        try:
            value = candidate.read_text(encoding="utf-8").strip().lstrip("v")
            if value:
                return value
        except OSError:
            pass
    return "0.0.0"


def _version_tuple(value: str) -> tuple[int, ...]:
    match = re.fullmatch(r"v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?", str(value).strip())
    if not match:
        raise ValueError("版本号必须为数字点分格式，例如 1.2.0")
    parts = tuple(int(item or 0) for item in match.groups())
    return parts


def device_key(system: str | None = None, machine: str | None = None) -> str:
    system = (system or platform.system()).lower()
    machine = (machine or platform.machine()).lower()
    if system == "windows" and machine in {"amd64", "x86_64", "x64"}:
        return "windows-x64"
    if system == "darwin" and machine in {"arm64", "aarch64"}:
        return "macos-arm64"
    return f"{system or 'unknown'}-{machine or 'unknown'}"


def _https_url(value: object, label: str) -> str:
    url = str(value or "").strip()
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or not parsed.netloc:
        raise ValueError(f"{label}必须使用 HTTPS")
    return url


def _read_json_url(url: str) -> dict:
    request = urllib.request.Request(
        _https_url(url, "更新地址"),
        headers={"Accept": "application/json", "User-Agent": f"MailAI/{current_version()}"},
    )
    with urllib.request.urlopen(request, context=_ssl_context(), timeout=12) as response:
        content_length = int(response.headers.get("Content-Length") or 0)
        if content_length > MANIFEST_MAX_BYTES:
            raise ValueError("更新清单过大")
        raw = response.read(MANIFEST_MAX_BYTES + 1)
    if len(raw) > MANIFEST_MAX_BYTES:
        raise ValueError("更新清单过大")
    value = json.loads(raw.decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("更新清单格式错误")
    return value


def evaluate_manifest(manifest: dict, *, device: str | None = None) -> dict:
    installed = current_version()
    latest = str(manifest.get("version") or "").strip().lstrip("v")
    installed_tuple = _version_tuple(installed)
    latest_tuple = _version_tuple(latest)
    device = device or device_key()
    assets = manifest.get("assets")
    if not isinstance(assets, dict):
        raise ValueError("更新清单缺少安装包列表")
    raw_asset = assets.get(device)
    supported = isinstance(raw_asset, dict)
    asset = None
    if supported:
        url = _https_url(raw_asset.get("url"), "安装包地址")
        digest = str(raw_asset.get("sha256") or "").strip().lower()
        if not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise ValueError("安装包缺少有效 SHA-256")
        expected_suffix = ".exe" if device == "windows-x64" else ".pkg" if device == "macos-arm64" else ""
        if expected_suffix and not urllib.parse.urlparse(url).path.lower().endswith(expected_suffix):
            raise ValueError(f"{device} 安装包格式不正确")
        asset = {"url": url, "sha256": digest, "size": int(raw_asset.get("size") or 0)}
    return {
        "current_version": installed,
        "latest_version": latest,
        "device": device,
        "supported": supported,
        "available": supported and latest_tuple > installed_tuple,
        "installable": bool(FROZEN and supported),
        "notes": str(manifest.get("notes") or "").strip()[:4000],
        "release_url": _https_url(manifest.get("release_url"), "发布页地址") if manifest.get("release_url") else "",
        "published_at": str(manifest.get("published_at") or "").strip(),
        "asset": asset,
        "unsigned_warning": "当前版本未配置代码签名，安装时系统可能显示安全警告。",
    }


def check(*, force: bool = False) -> dict:
    if not FROZEN and os.getenv("MAILAI_UPDATE_ALLOW_SOURCE", "").lower() not in {"1", "true", "yes"}:
        return {
            "current_version": current_version(), "latest_version": current_version(),
            "device": device_key(), "supported": False, "available": False,
            "installable": False, "development": True,
            "message": "源码运行模式不执行在线更新",
        }
    now = time.time()
    with _lock:
        cached = _cache.get("result")
        if not force and isinstance(cached, dict) and now - float(_cache.get("checked_at") or 0) < _CACHE_SECONDS:
            return dict(cached)
    manifest_url = os.getenv("MAILAI_UPDATE_MANIFEST_URL", DEFAULT_MANIFEST_URL).strip()
    result = evaluate_manifest(_read_json_url(manifest_url))
    with _lock:
        _cache.update(checked_at=now, result=dict(result))
    return result


def _download(asset: dict, target: Path, progress=None) -> None:
    request = urllib.request.Request(
        asset["url"], headers={"Accept": "application/octet-stream", "User-Agent": f"MailAI/{current_version()}"}
    )
    digest = hashlib.sha256()
    total = 0
    started_at = time.monotonic()
    temporary = target.with_suffix(target.suffix + ".part")
    try:
        with urllib.request.urlopen(request, context=_ssl_context(), timeout=30) as response, temporary.open("wb") as output:
            declared = int(response.headers.get("Content-Length") or 0)
            if declared > DOWNLOAD_MAX_BYTES:
                raise ValueError("安装包超过允许大小")
            expected = declared or int(asset.get("size") or 0)
            if progress:
                progress(phase="downloading", downloaded=0, total=expected, speed_bps=0,
                         message="正在下载安装包")
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > DOWNLOAD_MAX_BYTES:
                    raise ValueError("安装包超过允许大小")
                digest.update(chunk)
                output.write(chunk)
                if progress:
                    elapsed = max(0.001, time.monotonic() - started_at)
                    progress(phase="downloading", downloaded=total, total=expected,
                             speed_bps=int(total / elapsed), message="正在下载安装包")
        if progress:
            progress(phase="verifying", downloaded=total, total=expected or total,
                     speed_bps=0, message="下载完成，正在校验安装包")
        if digest.hexdigest() != asset["sha256"]:
            raise ValueError("安装包 SHA-256 校验失败，已停止更新")
        temporary.replace(target)
        if progress:
            progress(phase="verified", downloaded=total, total=expected or total,
                     speed_bps=0, message="安装包校验通过")
    finally:
        if temporary.exists():
            temporary.unlink()


def download_and_launch(progress=None) -> dict:
    if progress:
        progress(phase="checking", downloaded=0, total=0, speed_bps=0,
                 message="正在确认最新版本")
    result = check(force=True)
    if not result.get("available"):
        raise ValueError("当前已经是最新版本")
    if not result.get("installable"):
        raise ValueError("当前运行方式不支持自动启动安装器")
    asset = result["asset"]
    suffix = ".exe" if result["device"] == "windows-x64" else ".pkg"
    update_dir = USER_DIR / "updates"
    update_dir.mkdir(parents=True, exist_ok=True)
    target = update_dir / f"MailAI-{result['latest_version']}-{result['device']}{suffix}"
    _download(asset, target, progress=progress)
    if progress:
        progress(phase="launching", downloaded=int(asset.get("size") or 0),
                 total=int(asset.get("size") or 0), speed_bps=0, message="正在启动安装程序")
    if sys.platform == "win32":
        subprocess.Popen(
            [str(target), "/SILENT", "/NORESTART", "/CLOSEAPPLICATIONS"],
            close_fds=True,
            creationflags=getattr(subprocess, "DETACHED_PROCESS", 0),
        )
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(target)], close_fds=True)
    else:
        raise ValueError("当前系统不支持启动安装器")
    log.info("已启动 MailAI %s 更新安装器", result["latest_version"])
    return {"ok": True, "version": result["latest_version"], "message": "安装器已启动"}


def _set_install_state(**values) -> dict:
    with _install_state_lock:
        _install_state.update(values, updated_at=time.time())
        total = max(0, int(_install_state.get("total") or 0))
        downloaded = max(0, int(_install_state.get("downloaded") or 0))
        _install_state["percent"] = min(100, round(downloaded * 100 / total)) if total else 0
        return dict(_install_state)


def install_status() -> dict:
    with _install_state_lock:
        return dict(_install_state)


def start_install() -> dict:
    """Start a single update download so the UI can poll live progress."""
    if not _install_guard.acquire(blocking=False):
        return {**install_status(), "ok": True, "already_running": True}
    _set_install_state(
        status="running", phase="queued", running=True, downloaded=0, total=0,
        percent=0, speed_bps=0, message="正在准备更新", error="",
    )

    def report(**values):
        _set_install_state(status="running", running=True, error="", **values)

    def run():
        try:
            result = download_and_launch(progress=report)
            _set_install_state(
                status="completed", phase="launched", running=False, speed_bps=0,
                message=result.get("message") or "安装器已启动", error="",
                version=result.get("version") or "",
            )
        except Exception as exc:
            log.exception("下载或启动更新失败")
            _set_install_state(
                status="failed", phase="failed", running=False, speed_bps=0,
                message="更新未完成", error=str(exc)[:240],
            )
        finally:
            _install_guard.release()

    threading.Thread(target=run, name="mailai-app-update", daemon=True).start()
    return {**install_status(), "ok": True}
