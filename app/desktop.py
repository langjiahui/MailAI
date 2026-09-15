"""macOS desktop shell for the local MailAI web application."""
from __future__ import annotations

import logging
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import uvicorn


log = logging.getLogger(__name__)
_runtime: "DesktopRuntime | None" = None


def desktop_asset_path(filename: str = "mailai-mark.png") -> Path:
    """Resolve a checked-in desktop asset in source and frozen builds."""
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
    return base / "app" / "web" / "static" / "assets" / filename


def register_installed_application() -> bool:
    """Register only the persistent Applications copy with LaunchServices."""
    if not (getattr(sys, "frozen", False) and sys.platform == "darwin"):
        return False
    try:
        app_path = Path(sys.executable).resolve().parents[2]
    except (IndexError, OSError):
        return False
    allowed_parents = {Path("/Applications"), Path.home() / "Applications"}
    if app_path.suffix != ".app" or app_path.parent not in allowed_parents:
        return False
    registrar = Path(
        "/System/Library/Frameworks/CoreServices.framework/Frameworks/"
        "LaunchServices.framework/Support/lsregister"
    )
    try:
        if registrar.exists():
            subprocess.run(
                [str(registrar), "-f", "-trusted", str(app_path)],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=8,
            )
        subprocess.run(
            ["/usr/bin/touch", str(app_path)],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=4,
        )
        return True
    except (OSError, subprocess.SubprocessError):
        log.exception("刷新 macOS 应用注册失败")
        return False


def notification_text(result: dict) -> tuple[str, str] | None:
    """Build a concise notification for a completed background poll."""
    if not result or not result.get("ok") or result.get("canceled"):
        return None
    fetched = max(0, int(result.get("fetched") or 0))
    if not fetched:
        return None
    quarantined = max(0, int(result.get("quarantined") or 0))
    errors = max(0, int(result.get("errors") or 0))
    title = f"收到 {fetched} 封新邮件"
    details = []
    if quarantined:
        details.append(f"其中 {quarantined} 封需要安全关注")
    if errors:
        details.append(f"{errors} 封将在下次同步时重试")
    body = "，".join(details) or "邮件已同步，请打开 MailAI 查看"
    if result.get('account_user'):
        body = str(result['account_user']) + ' · ' + body
    return title, body


def notify_poll_result(result: dict) -> None:
    """Notify the active desktop runtime after a scheduled poll."""
    if _runtime is not None:
        _runtime.notify_poll_result(result)


def reserve_loopback_socket(preferred_port: int = 0) -> tuple[socket.socket, int]:
    """Reserve a loopback listener, falling back to an OS-assigned free port."""
    candidates = [preferred_port] if preferred_port > 0 else []
    candidates.append(0)
    last_error: OSError | None = None
    for port in candidates:
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            listener.bind(("127.0.0.1", port))
            listener.listen(2048)
            return listener, int(listener.getsockname()[1])
        except OSError as exc:
            last_error = exc
            listener.close()
            if port:
                log.warning("桌面端口 %s 已被占用，将自动选择可用端口", port)
    raise RuntimeError("无法为桌面应用分配本地端口") from last_error


@dataclass
class LocalServer:
    server: uvicorn.Server
    thread: threading.Thread
    listener: socket.socket
    port: int

    def stop(self, timeout: float = 5.0) -> None:
        self.server.should_exit = True
        self.thread.join(timeout=timeout)
        try:
            self.listener.close()
        except OSError:
            pass


def start_local_server(asgi_app, preferred_port: int = 0, timeout: float = 12.0) -> LocalServer:
    listener, port = reserve_loopback_socket(preferred_port)
    server = uvicorn.Server(uvicorn.Config(
        asgi_app,
        host="127.0.0.1",
        port=port,
        log_level="warning",
        access_log=False,
    ))
    thread = threading.Thread(
        target=server.run,
        kwargs={"sockets": [listener]},
        name="mailai-local-server",
        daemon=True,
    )
    thread.start()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if server.started:
            return LocalServer(server, thread, listener, port)
        if not thread.is_alive():
            listener.close()
            raise RuntimeError("MailAI 本地服务启动失败")
        time.sleep(0.05)
    server.should_exit = True
    thread.join(timeout=2)
    listener.close()
    raise TimeoutError("MailAI 本地服务启动超时")


class DesktopRuntime:
    """Own native window lifecycle, menu-bar controls and notifications."""

    def __init__(self, poll_callback: Callable[[], dict] | None = None):
        self.window = None
        self.poll_callback = poll_callback
        self.hidden = False
        self.quitting = False
        self._status_item = None
        self._status_icon = None
        self._status_controller = None
        self._notification_delegate = None

    def handle_closing(self, window=None):
        if self.quitting:
            return None
        self.hidden = True
        try:
            target = window or self.window
            if target:
                target.hide()
        except Exception:
            log.exception("隐藏 MailAI 窗口失败")
        return False

    def show_window(self) -> None:
        if not self.window:
            return
        try:
            self.hidden = False
            self.window.show()
            self._set_dock_badge("")
        except Exception:
            log.exception("显示 MailAI 窗口失败")

    def quit(self) -> None:
        from .draft_lifecycle import request_safe_exit
        request_safe_exit(self, self._finish_quit)

    def _finish_quit(self) -> None:
        self.quitting = True
        try:
            from AppKit import NSApplication
            from PyObjCTools import AppHelper

            AppHelper.callAfter(lambda: NSApplication.sharedApplication().terminate_(None))
        except Exception:
            log.exception("退出 MailAI 失败")

    def poll_now(self) -> None:
        if not self.poll_callback:
            return

        def run():
            try:
                result = self.poll_callback()
                self.notify_poll_result(result, force=True)
            except Exception:
                log.exception("菜单栏立即收信失败")

        threading.Thread(target=run, name="mailai-menu-poll", daemon=True).start()

    def notify_poll_result(self, result: dict, force: bool = False) -> None:
        fetched = max(0, int((result or {}).get("fetched") or 0))
        if result and result.get("ok") and fetched:
            self._signal_mailbox_changed(fetched)
        content = notification_text(result)
        if content is None or (not self.hidden and not force):
            return
        title, body = content
        self._deliver_notification(title, body)
        self._set_dock_badge(str(fetched) if fetched else "")

    def _signal_mailbox_changed(self, fetched: int) -> None:
        """Tell a visible webview to refresh without changing the selected mail."""
        if not self.window:
            return
        script = f"window.mailaiMailboxUpdated?.({json.dumps({'fetched': fetched})})"
        self._evaluate_js_safely("通知邮件列表自动刷新", script)

    def _evaluate_js_safely(self, label: str, script: str) -> bool:
        """Evaluate JavaScript off the Cocoa thread to avoid pywebview deadlocks.

        pywebview's Cocoa backend schedules the actual WebKit evaluation onto the
        main loop and then synchronously waits for its completion semaphore.  If
        ``Window.evaluate_js`` itself runs inside ``AppHelper.callAfter``, the
        main loop waits for work that only that same loop can execute.
        """
        window = self.window
        if self.quitting or window is None:
            return False

        def evaluate() -> None:
            if self.quitting:
                return
            try:
                window.evaluate_js(script)
            except Exception:
                log.exception("%s失败", label)

        threading.Thread(
            target=evaluate,
            name="mailai-webview-notify",
            daemon=True,
        ).start()
        return True

    def test_notification(self) -> dict:
        self._deliver_notification("MailAI 通知已开启", "关闭窗口后，新邮件和安全提醒会继续在后台送达。")
        return {"ok": True, "message": "系统通知已开启"}

    def _set_dock_badge(self, label: str) -> None:
        try:
            from AppKit import NSApplication

            setter = NSApplication.sharedApplication().dockTile().setBadgeLabel_
            self._call_after_safely("更新 Dock 未读标记", setter, label or None)
        except Exception:
            log.exception("更新 Dock 未读标记失败")

    def _call_after_safely(self, label: str, callback, *args) -> bool:
        """Run Cocoa work on its main loop and contain errors inside the callback."""
        if self.quitting:
            return False
        try:
            from PyObjCTools import AppHelper

            def invoke():
                if self.quitting:
                    return
                try:
                    callback(*args)
                except Exception:
                    log.exception("%s失败", label)

            AppHelper.callAfter(invoke)
            return True
        except Exception:
            log.exception("调度%s失败", label)
            return False

    def _deliver_notification(self, title: str, body: str) -> None:
        try:
            from AppKit import NSUserNotification, NSUserNotificationCenter, NSUserNotificationDefaultSoundName

            def deliver():
                note = NSUserNotification.alloc().init()
                note.setTitle_(title)
                note.setInformativeText_(body)
                note.setSoundName_(NSUserNotificationDefaultSoundName)
                NSUserNotificationCenter.defaultUserNotificationCenter().deliverNotification_(note)

            self._call_after_safely("发送 macOS 通知", deliver)
        except Exception:
            log.exception("发送 macOS 通知失败")

    def install_native_controls(self) -> None:
        from AppKit import (
            NSApplication,
            NSImage,
            NSImageScaleProportionallyDown,
            NSMakeSize,
            NSMenu,
            NSMenuItem,
            NSObject,
            NSSquareStatusItemLength,
            NSStatusBar,
            NSUserNotificationCenter,
        )

        runtime = self

        class StatusController(NSObject):
            def showMailAI_(self, sender):
                runtime.show_window()

            def pollMailAI_(self, sender):
                runtime.poll_now()

            def quitMailAI_(self, sender):
                runtime.quit()

            def userNotificationCenter_shouldPresentNotification_(self, center, notification):
                return True

            def userNotificationCenter_didActivateNotification_(self, center, notification):
                runtime.show_window()

        controller = StatusController.alloc().init()
        status_item = NSStatusBar.systemStatusBar().statusItemWithLength_(NSSquareStatusItemLength)
        button = status_item.button()
        status_icon = NSImage.alloc().initWithContentsOfFile_(str(desktop_asset_path()))
        if status_icon is not None:
            status_icon.setSize_(NSMakeSize(18, 18))
            status_icon.setTemplate_(True)
            button.setImage_(status_icon)
            button.setTitle_("")
        else:
            button.setTitle_("M")
        button.setToolTip_("MailAI · 后台收信中")
        button.setImageScaling_(NSImageScaleProportionallyDown)

        menu = NSMenu.alloc().initWithTitle_("MailAI")
        open_item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_("打开 MailAI", "showMailAI:", "")
        open_item.setTarget_(controller)
        menu.addItem_(open_item)
        poll_item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_("立即收取邮件", "pollMailAI:", "")
        poll_item.setTarget_(controller)
        menu.addItem_(poll_item)
        menu.addItem_(NSMenuItem.separatorItem())
        state_item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_("✓ 后台收信已开启", None, "")
        state_item.setEnabled_(False)
        menu.addItem_(state_item)
        menu.addItem_(NSMenuItem.separatorItem())
        quit_item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_("退出 MailAI", "quitMailAI:", "q")
        quit_item.setTarget_(controller)
        menu.addItem_(quit_item)
        status_item.setMenu_(menu)

        notification_center = NSUserNotificationCenter.defaultUserNotificationCenter()
        notification_center.setDelegate_(controller)
        NSApplication.sharedApplication().setActivationPolicy_(0)
        self._status_controller = controller
        self._notification_delegate = controller
        self._status_item = status_item
        self._status_icon = status_icon


class DesktopApi:
    def __init__(self, runtime: DesktopRuntime):
        self._runtime = runtime

    def enable_notifications(self):
        return self._runtime.test_notification()

    def open_external_url(self, url: str):
        """Open a user-clicked safe web link outside the sandboxed mail view."""
        from urllib.parse import urlsplit

        value = str(url or "").strip()
        if not value or len(value) > 4096:
            raise ValueError("链接为空或过长")
        parsed = urlsplit(value)
        if parsed.scheme.lower() not in {"http", "https"}:
            raise ValueError("仅支持打开 http 或 https 链接")
        if not parsed.hostname:
            raise ValueError("链接地址无效")
        opened = bool(webbrowser.open(value, new=2))
        return {"ok": opened, "url": value}

    def _save_backup_file(self, source: Path):
        """Copy a validated backup file through the platform save dialog."""
        from webview import FileDialog
        selected = self._runtime.window.create_file_dialog(
            FileDialog.SAVE,
            save_filename=source.name,
        )
        if not selected:
            return {"ok": False, "canceled": True, "retained": True}
        target = Path(selected[0] if isinstance(selected, (tuple, list)) else selected)
        expected_suffix = ".mailai-backup" if source.name.endswith(".mailai-backup") else ".zip"
        if not target.name.lower().endswith(expected_suffix):
            target = target.with_name(target.name + expected_suffix)
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.resolve() != target.resolve():
            temporary = target.with_name(f".{target.name}.mailai-export")
            try:
                with source.open("rb") as src, temporary.open("wb") as dst:
                    shutil.copyfileobj(src, dst, length=1024 * 1024)
                os.replace(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)
        return {"ok": True, "filename": target.name, "path": str(target), "retained": True}

    def save_portable_backup(self, filename: str):
        """Save a generated migration package to a selected location."""
        from .portable_backup import stored_path
        return self._save_backup_file(Path(stored_path(str(filename or ""))))

    def save_local_backup(self, filename: str):
        """Save an account-scoped rollback snapshot without navigating the UI."""
        from .system_settings import backup_path
        return self._save_backup_file(Path(backup_path(str(filename or ""))))

    def clipboard_attachments(self):
        """Read actual file-list clipboard formats only, after an explicit paste."""
        import base64
        import mimetypes
        paths = []
        if sys.platform == 'darwin':
            from AppKit import NSPasteboard
            paths = list(NSPasteboard.generalPasteboard().propertyListForType_('NSFilenamesPboardType') or [])
        elif sys.platform == 'win32':
            import ctypes
            from ctypes import wintypes
            user = ctypes.WinDLL('user32', use_last_error=True)
            shell = ctypes.WinDLL('shell32', use_last_error=True)
            user.GetClipboardData.argtypes = [wintypes.UINT]
            user.GetClipboardData.restype = wintypes.HANDLE
            shell.DragQueryFileW.argtypes = [wintypes.HANDLE, wintypes.UINT, wintypes.LPWSTR, wintypes.UINT]
            shell.DragQueryFileW.restype = wintypes.UINT
            if not user.OpenClipboard(None):
                raise ValueError('剪贴板正被使用，请重试')
            try:
                handle = user.GetClipboardData(15)  # CF_HDROP
                if handle:
                    for index in range(shell.DragQueryFileW(handle, 0xFFFFFFFF, None, 0)):
                        length = shell.DragQueryFileW(handle, index, None, 0)
                        buffer = ctypes.create_unicode_buffer(length + 1)
                        shell.DragQueryFileW(handle, index, buffer, length + 1)
                        paths.append(buffer.value)
            finally:
                user.CloseClipboard()
        items, total = [], 0
        for value in paths:
            path = Path(value)
            if not path.is_file():
                raise ValueError('仅支持粘贴文件，请先将文件夹压缩')
            size = path.stat().st_size
            total += size
            if size > 20 * 1024 * 1024 or total > 25 * 1024 * 1024:
                raise ValueError('单个附件不能超过 20MB，总大小不能超过 25MB')
            with path.open('rb') as stream:
                raw = stream.read(size + 1)
            if len(raw) != size:
                raise ValueError('文件正在变化，请保存文件后重新复制')
            items.append({'filename':path.name, 'content_type':mimetypes.guess_type(path.name)[0] or 'application/octet-stream',
                          'data_base64':base64.b64encode(raw).decode(), 'size':size})
        return items

    def download_attachment(self, email_id: int, attachment_index: int, suggested_name: str = "", account_id: str = "", source: str = "email"):
        """Save an attachment through the native dialog used by packaged apps."""
        from webview import FileDialog

        from . import db
        from .parser import extract_attachment

        from contextlib import nullcontext
        from .account_context import snapshot, use
        with use(snapshot(account_id)) if account_id else nullcontext():
            if source in ("sent", "draft"):
                attachment = db.get_sent_attachment(int(email_id), int(attachment_index), draft=source == "draft")
            elif source == "email":
                row = db.get_email(int(email_id))
                if not row:
                    raise ValueError("邮件不存在")
                attachment = extract_attachment(row.get("raw_path"), int(attachment_index))
            else:
                raise ValueError("不支持的附件来源")
        if not attachment:
            raise ValueError("附件不存在或原始邮件文件已丢失")

        name = Path(suggested_name or attachment.get("name") or "附件").name
        # Keep the proposed filename legal on both Windows and macOS.
        name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .") or "附件"
        selected = self._runtime.window.create_file_dialog(
            FileDialog.SAVE,
            save_filename=name,
        )
        if not selected:
            return {"ok": False, "canceled": True}
        target = Path(selected[0] if isinstance(selected, (tuple, list)) else selected)
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f".{target.name}.mailai-download")
        try:
            temporary.write_bytes(attachment["payload"])
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
        return {"ok": True, "filename": target.name, "path": str(target)}


def run_macos_window(asgi_app, preferred_port: int = 0,
                     poll_callback: Callable[[], dict] | None = None) -> None:
    """Run the ASGI app inside a native Cocoa window with background residency."""
    global _runtime
    register_installed_application()
    local_server = start_local_server(asgi_app, preferred_port)
    url = f"http://127.0.0.1:{local_server.port}/"
    log.info("桌面窗口服务: %s", url)
    runtime = DesktopRuntime(poll_callback)
    _runtime = runtime
    try:
        import webview
        from webview.platforms import cocoa
        from .mail_navigation import navigation_delegate

        def open_mail_link(url):
            from urllib.parse import urlsplit

            if urlsplit(url).scheme.lower() == 'mailto':
                runtime._evaluate_js_safely(
                    '在 MailAI 中打开写邮件',
                    f"window.mailaiOpenMailto?.({json.dumps(url)})",
                )
                return

            def run():
                try:
                    if not DesktopApi(runtime).open_external_url(url)['ok']:
                        raise RuntimeError('系统浏览器未能打开链接')
                except Exception:
                    # URLs can contain private access tokens; do not log them.
                    log.warning('系统浏览器打开邮件链接失败')
                    runtime._evaluate_js_safely('链接打开失败', "toast('链接打开失败，请检查默认浏览器设置', 'error')")
            threading.Thread(target=run, daemon=True, name='mailai-open-link').start()

        cocoa.BrowserView.BrowserDelegate = navigation_delegate(cocoa.BrowserView.BrowserDelegate, url, open_mail_link)

        base_delegate = cocoa.BrowserView.AppDelegate

        class MailAIAppDelegate(base_delegate):
            def applicationShouldTerminate_(self, app):
                if not runtime.quitting:
                    runtime.quit()
                    return 0  # NSTerminateCancel; retry only after drafts are saved.
                return super().applicationShouldTerminate_(app)

            def applicationShouldHandleReopen_hasVisibleWindows_(self, app, has_visible_windows):
                runtime.show_window()
                return True

        cocoa.BrowserView.AppDelegate = MailAIAppDelegate

        window = webview.create_window(
            "MailAI",
            url=url,
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

        def ready():
            runtime._call_after_safely("安装菜单栏控件", runtime.install_native_controls)

        webview.start(ready, gui="cocoa", debug=False)
        if not runtime.quitting:
            log.warning("macOS WebView 事件循环在未收到退出指令时结束")
    finally:
        runtime.quitting = True
        _runtime = None
        local_server.stop()
