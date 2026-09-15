"""Desktop shell must survive a configured port being occupied."""
import socket
import sys
import tempfile
import threading
import types
from unittest.mock import patch
from email.message import EmailMessage
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.desktop import DesktopApi, DesktopRuntime, desktop_asset_path, notification_text, register_installed_application, reserve_loopback_socket
from app import config, db


def main():
    assert desktop_asset_path().name == "mailai-mark.png"
    assert desktop_asset_path().exists()
    desktop_source = (ROOT / "app" / "desktop.py").read_text(encoding="utf-8")
    assert "NSSquareStatusItemLength" in desktop_source
    assert "status_icon.setTemplate_(True)" in desktop_source
    assert 'button.setTitle_("✉︎")' not in desktop_source
    assert "window.mailaiOpenMailto?." in desktop_source
    assert register_installed_application() is False
    build_source = (ROOT / "scripts" / "build_macos.command").read_text(encoding="utf-8")
    assert 'cat > "$PKG_SCRIPTS/preinstall"' in build_source
    assert "/usr/bin/pgrep -x MailAI" in build_source
    assert "/bin/kill -TERM" in build_source and "/bin/kill -KILL" in build_source
    assert "无法退出旧版 MailAI，已停止安装" in build_source
    occupied = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    occupied.bind(("127.0.0.1", 0))
    occupied.listen(1)
    occupied_port = occupied.getsockname()[1]
    listener = None
    try:
        listener, selected_port = reserve_loopback_socket(occupied_port)
        assert selected_port != occupied_port
        assert selected_port > 0
        assert listener.getsockname()[0] == "127.0.0.1"
    finally:
        if listener is not None:
            listener.close()
        occupied.close()
    assert notification_text({"ok": True, "fetched": 2, "quarantined": 1, "errors": 0}) == (
        "收到 2 封新邮件", "其中 1 封需要安全关注"
    )
    assert notification_text({"ok": True, "fetched": 0}) is None

    class FakeWindow:
        hidden = False

        def hide(self):
            self.hidden = True

    fake = FakeWindow()
    runtime = DesktopRuntime()
    assert runtime.handle_closing(fake) is False
    assert fake.hidden and runtime.hidden
    runtime.quitting = True
    assert runtime.handle_closing(fake) is None

    desktop_api = DesktopApi(DesktopRuntime())
    with patch("app.desktop.webbrowser.open", return_value=True) as browser_open:
        assert desktop_api.open_external_url("https://example.test/payroll")["ok"]
        browser_open.assert_called_once_with("https://example.test/payroll", new=2)
    for unsafe in ("javascript:alert(1)", "file:///etc/passwd", "data:text/html,bad", "mailto:person@example.test"):
        try:
            desktop_api.open_external_url(unsafe)
        except ValueError:
            pass
        else:
            raise AssertionError(f"Unsafe mail link accepted: {unsafe}")

    # Exceptions raised after AppHelper schedules Cocoa work must be contained
    # inside the dispatched callback instead of escaping into the native loop.
    scheduled = []
    original_helper = sys.modules.get("PyObjCTools")
    sys.modules["PyObjCTools"] = types.SimpleNamespace(
        AppHelper=types.SimpleNamespace(callAfter=lambda callback: scheduled.append(callback))
    )
    try:
        safe_runtime = DesktopRuntime()
        assert safe_runtime._call_after_safely(
            "测试原生回调", lambda: (_ for _ in ()).throw(RuntimeError("native callback"))
        )
        assert len(scheduled) == 1
        scheduled.pop()()  # Must not raise.
        safe_runtime.quitting = True
        assert safe_runtime._call_after_safely("退出后回调", lambda: None) is False
    finally:
        if original_helper is None:
            sys.modules.pop("PyObjCTools", None)
        else:
            sys.modules["PyObjCTools"] = original_helper

    # pywebview's Cocoa evaluate_js implementation schedules work onto the main
    # loop and waits synchronously. Running it inside callAfter deadlocks that
    # loop, so mailbox refresh signals must always originate on a worker.
    evaluated = threading.Event()
    caller_thread = threading.get_ident()

    class ScriptWindow:
        script = ""
        thread_id = None

        def evaluate_js(self, script):
            self.script = script
            self.thread_id = threading.get_ident()
            evaluated.set()

    signal_runtime = DesktopRuntime()
    signal_runtime.window = ScriptWindow()
    signal_runtime._signal_mailbox_changed(3)
    assert evaluated.wait(2), "Mailbox refresh JavaScript was not dispatched"
    assert "mailaiMailboxUpdated" in signal_runtime.window.script
    assert signal_runtime.window.thread_id != caller_thread
    assert "_call_after_safely(\n            \"通知邮件列表自动刷新\"" not in desktop_source

    with tempfile.TemporaryDirectory() as folder:
        raw_path = Path(folder) / "message.eml"
        output_path = Path(folder) / "已下载.txt"
        message = EmailMessage()
        message.set_content("正文")
        message.add_attachment(b"desktop-download", maintype="text", subtype="plain", filename="报告.txt")
        raw_path.write_bytes(message.as_bytes())

        class DownloadWindow:
            def create_file_dialog(self, *_args, **_kwargs):
                return (str(output_path),)

        download_runtime = DesktopRuntime()
        download_runtime.window = DownloadWindow()
        original_get_email = db.get_email
        try:
            db.get_email = lambda email_id: {"id": email_id, "raw_path": str(raw_path)}
            result = DesktopApi(download_runtime).download_attachment(1, 0, "报告.txt")
        finally:
            db.get_email = original_get_email
        assert result["ok"] and output_path.read_bytes() == b"desktop-download"

        portable_source = Path(folder, "backups", "MailAI-Portable-test.mailai-backup")
        portable_target = Path(folder, "chosen", "迁移副本")
        portable_source.parent.mkdir(); portable_source.write_bytes(b"portable-package")
        class PortableWindow:
            def create_file_dialog(self, *_args, **_kwargs): return (str(portable_target),)
        portable_runtime = DesktopRuntime(); portable_runtime.window = PortableWindow()
        with patch.object(config, "DATA_DIR", folder):
            saved = DesktopApi(portable_runtime).save_portable_backup(portable_source.name)
        assert saved["ok"] and saved["path"].endswith("迁移副本.mailai-backup")
        assert Path(saved["path"]).read_bytes() == b"portable-package"

        local_source = Path(folder, "backups", "MailAI-local-test.zip")
        local_target = Path(folder, "chosen", "历史备份")
        local_source.write_bytes(b"local-package")
        class LocalBackupWindow:
            def create_file_dialog(self, *_args, **_kwargs): return str(local_target)
        local_runtime = DesktopRuntime(); local_runtime.window = LocalBackupWindow()
        with patch.object(config, "DATA_DIR", folder), \
             patch("app.system_settings._account_key", return_value="local"):
            saved = DesktopApi(local_runtime).save_local_backup(local_source.name)
        assert saved["ok"] and saved["path"].endswith("历史备份.zip")
        assert Path(saved["path"]).read_bytes() == b"local-package"
    print("Desktop shell port fallback passed")


if __name__ == "__main__":
    main()
