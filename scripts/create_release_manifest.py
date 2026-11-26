"""Create the update manifest from verified release assets."""
import argparse
import base64
import os
import re
import sys
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

MAX_HISTORY_VERSIONS = 15
_DOC_VERSION_RE = re.compile(r"^发布-v(\d+\.\d+\.\d+)(?:-|$)")
_METADATA_PREFIXES = ("基准版本：", "变更类型：", "目标版本：", "判断依据：", "基准版本:", "变更类型:", "目标版本:", "判断依据:")
_SKIP_SECTIONS = ("验证", "发布验证", "测试")


def offers_macos_app_update(version: str) -> bool:
    # Bridge 4.7.0–4.7.1 through Installer so their older updater cannot select ZIP.
    return version != '4.7.3'


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def release_notes_from_readme(path: Path) -> str:
    """Use README's current-update paragraph as the single release-note source."""
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith("本次更新："):
            notes = stripped.removeprefix("本次更新：").strip()
            if notes:
                return notes
    raise ValueError("README 缺少非空的“本次更新：”说明")


def _clean_summary_text(text: str) -> str:
    cleaned = re.sub(r"\s*\[发布说明\]\([^\s)]+\)\s*(?:·\s*\[完整版本历史\]\([^\s)]+\))?", "", str(text or ""))
    cleaned = re.sub(r"\[([^\]]+)\]\([^\s)]+\)", r"\1", cleaned)
    cleaned = re.sub(r"\*\*([^*]+)\*\*", r"\1", cleaned)
    cleaned = cleaned.replace("`", "")
    return re.sub(r"\s+", " ", cleaned).strip()


def _version_tuple(value: str) -> tuple[int, int, int]:
    parts = [int(item) for item in str(value).strip().lstrip("v").split(".")[:3]]
    while len(parts) < 3:
        parts.append(0)
    return (parts[0], parts[1], parts[2])


def _extract_doc_summary(path: Path) -> str:
    bullets = []
    basis = ""
    skip_section = False
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line.startswith("#"):
            title = line.lstrip("#").strip()
            skip_section = any(word in title for word in _SKIP_SECTIONS)
            continue
        if skip_section or not line.startswith("- "):
            continue
        item = line[2:].strip()
        if item.startswith("判断依据：") or item.startswith("判断依据:"):
            basis = _clean_summary_text(item.split("：", 1)[-1] if "：" in item else item.split(":", 1)[-1])
            continue
        if any(item.startswith(prefix) for prefix in _METADATA_PREFIXES):
            continue
        cleaned = _clean_summary_text(item)
        if cleaned:
            bullets.append(cleaned)
            if len(bullets) >= 3:
                break
    if bullets:
        return "；".join(item.rstrip("。；;") for item in bullets) + "。"
    return basis[:360]


def release_history_from_docs(docs_dir: Path, target_version: str, *, current_notes: str = "", limit: int = MAX_HISTORY_VERSIONS) -> list[dict]:
    """Collect up to `limit` version summaries up to `target_version` in reverse order."""
    target_version = str(target_version).strip().lstrip("v")
    target_tuple = _version_tuple(target_version)
    by_version: dict[str, str] = {}
    if docs_dir.is_dir():
        for path in docs_dir.glob("发布-v*.md"):
            match = _DOC_VERSION_RE.match(path.name)
            if not match:
                continue
            version = match.group(1)
            if _version_tuple(version) > target_tuple:
                continue
            summary = _extract_doc_summary(path)
            if summary:
                by_version[version] = summary[:500]
    cleaned_current = _clean_summary_text(current_notes)
    if cleaned_current:
        by_version[target_version] = cleaned_current[:500]
    ordered = sorted(by_version.items(), key=lambda item: _version_tuple(item[0]), reverse=True)
    return [{"version": version, "notes": summary} for version, summary in ordered[:limit]]


def release_body(version: str, notes: str) -> str:
    return f"## MailAI {version} 更新内容\n\n{notes}\n\n安装包会根据 Windows x64、macOS（Apple Silicon 或 Intel）或 Linux x64 自动匹配。\n"


def main():
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from app.update_mirror import installer_names, MAC_APP_DEVICE, MAC_APP_NAME

    parser = argparse.ArgumentParser()
    parser.add_argument("--version", required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--readme", type=Path, default=Path("README.md"))
    parser.add_argument("--docs", type=Path)
    parser.add_argument("--notes-output", type=Path)
    parser.add_argument("--notes")
    args = parser.parse_args()
    version = args.version.lstrip("v")
    tag = args.version if args.version.startswith("v") else f"v{version}"
    notes = args.notes.strip() if args.notes else release_notes_from_readme(args.readme)
    docs_dir = args.docs or (args.readme.resolve().parent / "docs")
    history = release_history_from_docs(docs_dir, version, current_notes=notes)
    names = installer_names(version)
    if (args.assets / MAC_APP_NAME).is_file():
        names[MAC_APP_DEVICE] = MAC_APP_NAME
    assets = {}
    for device, name in names.items():
        path = args.assets / name
        if not path.is_file():
            raise SystemExit(f"Missing release asset: {path}")
        assets[device] = {
            "url": f"https://github.com/{args.repository}/releases/download/{tag}/{name}",
            "sha256": digest(path),
            "size": path.stat().st_size,
        }
    manifest = {
        "version": version,
        "release_url": f"https://github.com/{args.repository}/releases/tag/{tag}",
        "published_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "notes": notes,
        "assets": assets,
    }
    if history:
        manifest["history"] = history
    args.output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    signing_key = os.getenv('UPDATE_SIGNING_KEY', '').strip()
    if signing_key:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from app.update_trust import canonical, verify
        key = Ed25519PrivateKey.from_private_bytes(base64.b64decode(signing_key, validate=True))
        envelope = {'algorithm': 'ed25519', 'manifest': manifest,
                    'signature': base64.b64encode(key.sign(canonical(manifest))).decode()}
        verify(envelope)
        args.output.with_name('latest.signed.json').write_text(
            json.dumps(envelope, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    if args.notes_output:
        args.notes_output.write_text(release_body(version, notes), encoding="utf-8")


if __name__ == "__main__":
    main()
