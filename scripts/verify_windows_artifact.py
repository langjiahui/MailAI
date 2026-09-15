"""Boot the frozen Windows app in an isolated profile and verify public startup APIs."""
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
EXE = ROOT / "dist" / "windows" / "MailAI" / "MailAI.exe"

# Loopback probes must never use Windows Internet Settings or HTTP_PROXY.
LOCAL_HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def get_json(url):
    with LOCAL_HTTP.open(url, timeout=3) as response:
        return json.load(response)


def verify_startup(base_url):
    health = get_json(f"{base_url}/api/health")
    config = get_json(f"{base_url}/api/system/config")
    with LOCAL_HTTP.open(f"{base_url}/static/assets/mailai-mark.png", timeout=3) as response:
        if response.status != 200:
            raise RuntimeError("logo asset unavailable")
    # Public releases intentionally omit API keys; onboarding must work without one.
    if not health.get("llm_model"):
        raise RuntimeError("bundled model name unavailable")
    if config.get("mail", {}).get("logged_in") is not False:
        raise RuntimeError("isolated startup did not report a logged-out mailbox")


def main():
    if sys.platform != "win32":
        raise SystemExit("Windows artifact verification must run on Windows")
    if not EXE.exists() or EXE.read_bytes()[:2] != b"MZ":
        raise SystemExit(f"Invalid Windows executable: {EXE}")

    port = free_port()
    with tempfile.TemporaryDirectory(prefix="mailai-release-check-") as profile:
        diagnostic_log = Path(profile) / "startup-diagnostic.log"
        ready_file = Path(profile) / "window-ready.txt"
        env = os.environ.copy()
        env.update({
            "MAILAI_HOME": profile,
            "MAILAI_DIAGNOSTIC_LOG": str(diagnostic_log),
            "MAILAI_STARTUP_TRACE": "1",
            "MAILAI_WINDOW_READY_FILE": str(ready_file),
            "WEB_HOST": "127.0.0.1",
            "WEB_PORT": str(port),
            "AUTO_OPEN_BROWSER": "false",
            "IMAP_USER": "",
            "IMAP_PASSWORD": "",
        })
        process = subprocess.Popen([str(EXE)], env=env, cwd=EXE.parent)
        try:
            deadline = time.monotonic() + 45
            last_error = None
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    details = ""
                    if diagnostic_log.exists():
                        details = diagnostic_log.read_text(encoding="utf-8", errors="replace").strip()
                    message = f"MailAI.exe exited early with code {process.returncode}"
                    if details:
                        message += f"\n--- frozen startup diagnostic ---\n{details}"
                    raise SystemExit(message)
                try:
                    verify_startup(f"http://127.0.0.1:{port}")
                    if not ready_file.exists():
                        raise RuntimeError("HTTP APIs ready; waiting for Windows WebView page loaded event")
                    print("PASS frozen Windows startup, WebView page loaded, onboarding API and logo asset")
                    return
                except urllib.error.HTTPError as exc:
                    raise SystemExit(f"Startup probe failed: {exc.url}: HTTP {exc.code}") from exc
                except Exception as exc:
                    last_error = exc
                    time.sleep(0.5)
            raise SystemExit(f"Timed out waiting for MailAI.exe: {last_error}")
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=8)
            # TemporaryDirectory removes the profile: preserve diagnostics first.
            import shutil
            report_dir = ROOT / "build" / "windows-startup-diagnostics" / time.strftime("%Y%m%d-%H%M%S")
            report_dir.mkdir(parents=True, exist_ok=True)
            for source in (diagnostic_log, *sorted((Path(profile) / "logs").glob("*.log"))):
                if source.is_file():
                    shutil.copy2(source, report_dir / source.name)
            print(f"Startup diagnostics saved to: {report_dir}", flush=True)


if __name__ == "__main__":
    main()
