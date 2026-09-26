"""Windows shell behavior that can be checked without a Windows GUI."""
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.windows_desktop import WindowsDesktopRuntime, _asset_path, configure_windows_app_identity


class FakeWindow:
    def __init__(self):
        self.hidden = False
        self.minimized = False
        self.restored = False
        self.scripts = []

    def hide(self): self.hidden = True
    def show(self): self.hidden = False
    def minimize(self): self.minimized = True
    def restore(self): self.restored = True
    def evaluate_js(self, script): self.scripts.append(script)


class FakeTray:
    def __init__(self): self.notes = []
    def notify(self, body, title): self.notes.append((title, body))


def main():
    assert _asset_path().name == "mailai-icon-256.png"
    assert _asset_path().exists()
    assert configure_windows_app_identity() is (sys.platform == "win32")
    runtime = WindowsDesktopRuntime()
    assert runtime.test_notification()["ok"] is False
    runtime.window = FakeWindow()
    assert runtime.handle_closing() is False
    assert runtime.window.minimized and not runtime.hidden
    runtime.tray = FakeTray()
    assert runtime.handle_closing() is False
    assert runtime.hidden and runtime.window.hidden
    assert runtime.tray.notes == [("MailAI 已在后台运行", "关闭窗口后仍会在后台收取和分析邮件")]
    runtime.notify_poll_result({"ok": True, "fetched": 2, "quarantined": 1})
    assert "mailaiMailboxUpdated" in runtime.window.scripts[-1]
    assert runtime.tray.notes[-1] == ("收到 2 封新邮件", "其中 1 封需要安全关注")
    assert runtime.test_notification()["ok"] is True
    runtime.show_window()
    assert not runtime.hidden and not runtime.window.hidden and runtime.window.restored

    from app.windows_notifications import reminder_icon_class, NIN_BALLOONUSERCLICK
    clicked = threading.Event()
    original = []
    class BaseIcon:
        def _on_notify(self, wparam, lparam): original.append((wparam,lparam))
    icon = reminder_icon_class(BaseIcon, clicked.set)()
    icon._on_notify(0,NIN_BALLOONUSERCLICK)
    assert clicked.is_set() and not original
    icon._on_notify(1,0x205)
    assert original == [(1,0x205)], 'Normal tray menus must keep working'
    opened=threading.Event()
    runtime.window.evaluate_js=lambda script: (runtime.window.scripts.append(script),opened.set())
    runtime.open_reminders()
    assert opened.wait(2)
    assert 'mailaiOpenTaskReminder' in runtime.window.scripts[-1]

    # The JS bridge recursively reflects public attributes. Native runtime must
    # stay private so WebView2 properties are never read on its worker thread.
    from app.desktop import DesktopApi
    class NativeSentinel:
        @property
        def window(self):
            raise AssertionError("Native window must not be traversed by JS bridge")
    api = DesktopApi(NativeSentinel())
    public = {name: getattr(api, name) for name in dir(api) if not name.startswith('_')}
    assert public and all(callable(value) for value in public.values())
    assert 'runtime' not in public

    started, release, done = threading.Event(), threading.Event(), threading.Event()
    calls = []
    def slow_poll():
        calls.append(1)
        started.set()
        release.wait(3)
        return {"ok": True, "fetched": 0}
    polling = WindowsDesktopRuntime(slow_poll)
    polling.notify_poll_result = lambda *args, **kwargs: done.set()
    polling.poll_now()
    assert started.wait(2)
    try:
        for _ in range(10):
            polling.poll_now()
        assert len(calls) == 1
    finally:
        release.set()
    assert done.wait(2)

    root = Path(__file__).resolve().parent.parent
    build_script = root / "scripts" / "BUILD_WINDOWS_EXE.bat"
    if not build_script.exists():
        build_script = root / "BUILD_WINDOWS_EXE.bat"
    source = build_script.read_text(encoding="utf-8")
    assert '--specpath "build"' in source
    assert 'set "MAILAI_ICON=%CD%\\build\\mailai.ico"' in source
    assert '--icon "%MAILAI_ICON%"' in source
    assert '--icon "build\\mailai.ico"' not in source
    assert '--runtime-hook "%CD%\\scripts\\windows_runtime_hook.py"' in source
    assert '--hidden-import "webview.platforms.winforms"' in source
    assert '--hidden-import "webview.platforms.edgechromium"' in source
    assert '--hidden-import "pystray._win32"' in source
    assert '--add-data "%CD%\\app\\web\\static;app\\web\\static"' in source
    assert '--add-data "%CD%\\mailai.defaults.env;."' in source
    assert '--onedir --noupx' in source
    assert '--onefile' not in source
    assert '--version-file "%CD%\\build\\windows-version.txt"' in source
    assert 'MAILAI_SIGN_SHA1' in source and 'signtool.exe sign' in source
    assert 'Verifying bundled native icon' in source
    assert 'Bundled native icon is missing: build\\mailai.ico' in source
    assert 'Bundled native icon is missing: %MAILAI_ICON%' not in source
    assert 'if exist "%MAILAI_ICON%" goto :icon_ready' in source
    assert 'if not exist "%MAILAI_ICON%" (' not in source
    assert '"%PY_EXE%" scripts\\prepare_app_icon.py' not in source
    assert 'MailAI-Windows-build.log' in source
    assert 'call "%~f0"' in source
    icon_script = (root / "scripts" / "prepare_app_icon.py").read_text(encoding="utf-8")
    assert "(16, 16)" in icon_script and "(256, 256)" in icon_script
    windows_source = (root / "app" / "windows_desktop.py").read_text(encoding="utf-8")
    assert "SetCurrentProcessExplicitAppUserModelID" in windows_source
    hook = (root / "scripts" / "windows_runtime_hook.py").read_text(encoding="utf-8")
    assert 'MAILAI_DIAGNOSTIC_LOG' in hook
    assert 'sys.excepthook = _report_unhandled' in hook
    installer = (root / "scripts" / "mailai.iss").read_text(encoding="utf-8")
    assert "function PrepareToInstall" in installer
    assert "taskkill.exe" in installer and "/F /IM MailAI.exe" in installer
    assert 'dist\\windows\\MailAI\\*' in installer
    assert 'SolidCompression=no' in installer and 'lzma2/normal' in installer
    from scripts.create_windows_buildkit import INCLUDE_FILES, TEST_FILES
    for test_name in ("test_thread_guard.py", "test_campaigns.py", "test_outgoing_guard.py", "test_preflight_gate.py", "test_signatures.py"):
        assert test_name in TEST_FILES
    for required_path in (
        "scripts/build_macos.command",
        "scripts/create_windows_buildkit.py",
        "scripts/prepare_bundle_config.py",
        "build/mailai.ico",
        "docs/开发者架构与运行机制.md",
    ):
        assert required_path in INCLUDE_FILES
    print("Windows native window, tray notification and automatic refresh passed")


if __name__ == "__main__":
    main()
