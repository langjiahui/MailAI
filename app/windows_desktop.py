"""Windows desktop shell with a native window and background tray residency."""
from __future__ import annotations

import json
import os
import logging
import sys
import threading
from pathlib import Path
from typing import Callable

from .desktop import DesktopApi, notification_text, start_local_server


log = logging.getLogger(__name__)
_runtime: "WindowsDesktopRuntime | None" = None


def _asset_path() -> Path:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
    return base / "app" / "web" / "static" / "assets" / "mailai-icon-256.png"


def configure_windows_app_identity() -> bool:
    """Keep taskbar and notification icons grouped under the MailAI app."""
    if sys.platform != "win32":
        return False
    try:
        import ctypes

        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("com.langjiahui.mailai")
        return True
    except Exception:
        log.exception("设置 Windows 应用身份失败")
        return False


def notify_poll_result(result: dict) -> None:
    if _runtime is not None:
        _runtime.notify_poll_result(result)


class WindowsDesktopRuntime:
    def __init__(self, poll_callback: Callable[[], dict] | None = None):
        self.window = None
        self.poll_callback = poll_callback
        self.hidden = False
        self.quitting = False
        self.tray = None
        self.tray_notice_shown = False
        self._poll_lock = threading.Lock()

    def handle_closing(self, *_):
        if self.quitting:
            return True
        # pystray is initialized after WebView2 becomes ready. If the user closes
        # during that short interval, keep the window recoverable on the taskbar
        # instead of leaving an invisible process without a tray entry.
        if not self.tray:
            if self.window and hasattr(self.window, "minimize"):
                self.window.minimize()
            return False
        self.hidden = True
        self.window.hide()
        if not self.tray_notice_shown:
            self.tray_notice_shown = True
            try:
                self.tray.notify("关闭窗口后仍会在后台收取和分析邮件", "MailAI 已在后台运行")
            except Exception:
                log.exception("显示 Windows 托盘驻留提示失败")
        return False

    def show_window(self, *_):
        self.hidden = False
        if self.window:
            self.window.show()
            if hasattr(self.window, "restore"):
                try:
                    self.window.restore()
                except Exception:
                    log.debug("Windows 窗口无需恢复", exc_info=True)

    def quit(self, *_):
        from .draft_lifecycle import request_safe_exit
        request_safe_exit(self, self._finish_quit)

    def _finish_quit(self):
        self.quitting = True
        if self.tray:
            self.tray.stop()
        if self.window:
            self.window.destroy()

    def poll_now(self, *_):
        if not self.poll_callback or not self._poll_lock.acquire(blocking=False):
            return

        def run():
            try:
                self.notify_poll_result(self.poll_callback(), force=True)
            except Exception:
                log.exception("Windows 托盘立即收信失败")
            finally:
                self._poll_lock.release()

        threading.Thread(target=run, name="mailai-windows-poll", daemon=True).start()

    def notify_poll_result(self, result: dict, force: bool = False):
        fetched = max(0, int((result or {}).get("fetched") or 0))
        if result and result.get("ok") and fetched and self.window:
            try:
                payload = json.dumps({"fetched": fetched})
                self.window.evaluate_js(f"window.mailaiMailboxUpdated?.({payload})")
            except Exception:
                log.exception("通知 Windows 邮件列表自动刷新失败")
        content = notification_text(result)
        if content is None or (not self.hidden and not force) or not self.tray:
            return
        title, body = content
        try:
            self.tray.notify(body, title)
        except Exception:
            log.exception("发送 Windows 新邮件通知失败")

    def test_notification(self) -> dict:
        if not self.tray:
            return {"ok": False, "message": "系统托盘尚未就绪，请稍后重试"}
        try:
            self.tray.notify("收到新邮件时会通过系统通知提醒你。", "MailAI 测试通知")
            return {"ok": True, "message": "已发送测试通知；若未显示，请检查 Windows 通知设置"}
        except Exception:
            log.exception("Windows 测试通知失败")
            return {"ok": False, "message": "无法发送测试通知，请检查 Windows 通知设置"}

    def start_tray(self):
        try:
            import pystray
            from PIL import Image

            image = Image.open(_asset_path()).convert("RGBA").resize(
                (64, 64), Image.Resampling.LANCZOS
            )
            self.tray = pystray.Icon(
                "MailAI",
                image,
                "MailAI · 后台收信中",
                menu=pystray.Menu(
                    pystray.MenuItem("打开 MailAI", self.show_window, default=True),
                    pystray.MenuItem("立即收取邮件", self.poll_now),
                    pystray.Menu.SEPARATOR,
                    pystray.MenuItem("退出 MailAI", self.quit),
                ),
            )
            self.tray.run_detached()
        except Exception:
            self.tray = None
            log.exception("Windows 系统托盘初始化失败；窗口关闭时将保留在任务栏")


def run_windows_window(asgi_app, preferred_port: int = 0,
                       poll_callback: Callable[[], dict] | None = None) -> None:
    global _runtime
    configure_windows_app_identity()
    log.info("启动阶段：启动本地 HTTP 服务，首选端口 %s", preferred_port)
    local_server = start_local_server(asgi_app, preferred_port)
    log.info("启动阶段：本地 HTTP 服务已就绪，端口 %s", local_server.port)
    runtime = WindowsDesktopRuntime(poll_callback)
    _runtime = runtime
    try:
        log.info("启动阶段：加载 Windows WebView")
        import webview

        window = webview.create_window(
            "MailAI",
            url=f"http://127.0.0.1:{local_server.port}/",
            js_api=DesktopApi(runtime),
            width=1440,
            height=900,
            min_size=(900, 640),
            resizable=True,
            background_color="#edf5f2",
            text_select=True,
        )
        runtime.window = window
        window.events.closing += runtime.handle_closing
        def page_loaded():
            log.info("启动阶段：Windows 页面已加载")
            marker = os.environ.get("MAILAI_WINDOW_READY_FILE")
            if marker:
                Path(marker).write_text("loaded", encoding="utf-8")

        window.events.loaded += page_loaded
        log.info("启动阶段：启动 Windows 窗口事件循环")
        webview.start(runtime.start_tray, debug=False)
    finally:
        if runtime.tray:
            runtime.tray.stop()
        _runtime = None
        local_server.stop()
