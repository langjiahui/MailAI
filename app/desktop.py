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
from .ui_copy import ui_text
from .mail_notifications import notification_text, notification_target


log = logging.getLogger(__name__)
_runtime: "DesktopRuntime | None" = None


def restore_native_context_menu(host_class) -> None:
    """Keep WebKit's selection/edit menu in non-debug desktop windows."""
    import objc

    def will_open_menu(self, menu, event):
        # pywebview clears this menu when debug=False, removing Copy along with
        # the browser actions. WebKit already supplies the right native commands
        # for selected mail text, links and editable fields. Developer extras
        # remain disabled by the window configuration.
        return None

    # Replace only the callback. Subclassing/replacing WebKitHost would break
    # the backend's super(BrowserView.WebKitHost, self) calls in keyboard/drag code.
    original = host_class.willOpenMenu_withEvent_
    host_class.willOpenMenu_withEvent_ = objc.selector(
        will_open_menu, selector=b"willOpenMenu:withEvent:", signature=original.signature,
    )


def desktop_asset_path(filename: str = "mailai-mark.png") -> Path:
    """Resolve a checked-in desktop asset in source and frozen builds."""
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
    return base / "app" / "web" / "static" / "assets" / filename


def refresh_macos_dock_icon() -> bool:
    """Load the installed icon afresh on Cocoa's main thread, bypassing Dock cache."""
    if sys.platform != "darwin":
        return False
    try:
        from AppKit import NSApplication, NSImage

        path = desktop_asset_path("mailai-app-icon-1024.png")
        if not path.is_file():
            return False
        image = NSImage.alloc().initWithContentsOfFile_(str(path))
        if image is None or not image.isValid():
            log.warning("macOS Dock 图标无效，保留系统图标")
            return False
        app = NSApplication.sharedApplication()
        app.setApplicationIconImage_(image)
        app.dockTile().display()
        return True
    except Exception:
        log.exception("刷新 macOS Dock 图标失败")
        return False


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
        # Update the bundle timestamp before registration so icon services see
        # the new content-addressed ICNS, not the previous installation state.
        touched = subprocess.run(
            ["/usr/bin/touch", str(app_path)],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=4,
        )
        if touched.returncode:
            # A root-owned installed bundle may be read-only to this user.
            # Installer already touches it; still register in this user's GUI.
            log.debug("应用目录不可写，继续注册 MailAI 图标")
        if registrar.exists():
            registered = subprocess.run(
                [str(registrar), "-f", "-trusted", str(app_path)],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=8,
            )
            if registered.returncode:
                log.warning("注册 MailAI 应用图标失败")
                return False
        else:
            return False
        return True
    except (OSError, subprocess.SubprocessError):
        log.exception("刷新 macOS 应用注册失败")
        return False


def notify_poll_result(result: dict) -> bool:
    """Notify the active desktop runtime after a scheduled poll."""
    if _runtime is not None:
        return _runtime.notify_poll_result(result)
    return False


def refresh_dock_badge() -> None:
    """Refresh the native badge after local mail state changes."""
    if _runtime is not None:
        _runtime.refresh_dock_badge()


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
        self._notification_service = None
        self._notification_lock = threading.Lock()
        self._native_menu_entries = []
        self._main_menu = None
        self._window_foreground = None
        self._window_visibility_revision = 0
        self._window_visibility_lock = threading.Lock()

    def set_window_foreground(self, visible: bool, *, force: bool = False) -> None:
        """Forward native focus/visibility, even when WKWebView retains DOM focus."""
        visible = bool(visible and not self.hidden)
        with self._window_visibility_lock:
            if self.quitting or (visible == self._window_foreground and not force):
                return
            self._window_foreground = visible
            self._window_visibility_revision += 1
            revision = self._window_visibility_revision
        self._evaluate_js_safely('更新窗口节能状态',
            f"window.mailaiEnergy?.nativeVisibility({revision}, {json.dumps(visible)})")

    def sync_native_foreground(self, *, force: bool = False) -> None:
        # Call on Cocoa's main thread; minimized/restored events come from
        # pywebview workers and must marshal here before inspecting NSWindow.
        from AppKit import NSApplication
        app = NSApplication.sharedApplication()
        native = getattr(self.window, 'native', None)
        self.set_window_foreground(app.isActive() and not app.isHidden() and
                                   not (native and native.isMiniaturized()), force=force)

    def handle_closing(self, window=None):
        if self.quitting:
            return None
        self.hidden = True
        self.set_window_foreground(False)
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
            self.set_window_foreground(True)
            self.refresh_dock_badge()
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

    def notify_poll_result(self, result: dict, force: bool = False) -> bool:
        fetched = max(0, int((result or {}).get("fetched") or 0))
        if result and result.get("ok") and (result.get('received') or fetched):
            self._signal_mailbox_changed(result.get('received') or fetched)
        self.refresh_dock_badge()
        content = notification_text(result)
        if content is None:
            return True
        title, body = content
        return self._deliver_notification(title, body, mail_target=notification_target(result))

    def open_mail_notification(self, target):
        self.show_window()
        self._evaluate_js_safely("打开通知邮件",
            f"window.mailaiOpenMailNotification?.({json.dumps(target)})")

    def refresh_dock_badge(self) -> None:
        try:
            from .system_settings import unread_inbox_count
            count = unread_inbox_count()
            self._set_dock_badge(str(count) if count else "")
        except Exception:
            log.exception("读取未读邮件数量失败，保留当前 Dock 标记")

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
        try:
            if not self._notifications().authorized(request=True, timeout=30):
                return {"ok": False, "message": "未获得通知权限"}
            accepted = self._deliver_notification(ui_text('MailAI 通知已开启'), ui_text('关闭窗口后，新邮件和安全提醒会继续在后台送达。'))
            return {"ok": accepted, "message": "已发送测试通知" if accepted else "未能提交系统通知，请稍后重试"}
        except Exception:
            log.exception("测试 macOS 通知失败")
            return {"ok": False, "message": "未能提交系统通知，请稍后重试"}

    def _notifications(self):
        from .macos_notifications import MacNotificationService
        with self._notification_lock:
            if self._notification_service is None:
                self._notification_service = MacNotificationService(self)
            return self._notification_service

    def _open_notification_info(self, info):
        self.show_window()
        try:
            if info.get('mailai_mail'):
                self.open_mail_notification(json.loads(info['mailai_mail']))
            elif info.get('mailai_task'):
                target = json.loads(info['mailai_task'])
                self._evaluate_js_safely('打开提醒任务',
                    f"window.mailaiOpenTaskReminder?.({json.dumps(target)})")
        except (ValueError, TypeError):
            log.warning('无效的系统通知目标')

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

    def _deliver_notification(self, title: str, body: str, target: dict | None = None, *, mail_target: dict | None = None) -> bool:
        if self.quitting:
            return False
        try:
            return self._notifications().deliver(title, body, task_target=target, mail_target=mail_target)
        except Exception:
            log.exception("发送 macOS 通知失败")
            return False

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
        )

        runtime = self

        class StatusController(NSObject):
            def showMailAI_(self, sender):
                runtime.show_window()

            def pollMailAI_(self, sender):
                runtime.poll_now()

            def quitMailAI_(self, sender):
                runtime.quit()

        controller = StatusController.alloc().init()
        status_item = NSStatusBar.systemStatusBar().statusItemWithLength_(NSSquareStatusItemLength)
        button = status_item.button()
        status_icon = NSImage.alloc().initWithContentsOfFile_(str(desktop_asset_path("mailai-menu-template.png")))
        if status_icon is not None:
            status_icon.setSize_(NSMakeSize(18, 18))
            status_icon.setTemplate_(True)
            button.setImage_(status_icon)
            button.setTitle_("")
        else:
            button.setTitle_("M")
        button.setToolTip_(ui_text('MailAI · 后台收信中'))
        button.setImageScaling_(NSImageScaleProportionallyDown)

        menu = NSMenu.alloc().initWithTitle_("MailAI")
        open_item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(ui_text('打开 MailAI'), "showMailAI:", "")
        open_item.setTarget_(controller)
        menu.addItem_(open_item)
        poll_item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(ui_text('立即收取邮件'), "pollMailAI:", "")
        poll_item.setTarget_(controller)
        menu.addItem_(poll_item)
        menu.addItem_(NSMenuItem.separatorItem())
        state_item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(ui_text('✓ 后台收信已开启'), None, "")
        state_item.setEnabled_(False)
        menu.addItem_(state_item)
        menu.addItem_(NSMenuItem.separatorItem())
        quit_item = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(ui_text('退出 MailAI'), "quitMailAI:", "q")
        quit_item.setTarget_(controller)
        menu.addItem_(quit_item)
        status_item.setMenu_(menu)
        self._native_menu_entries = [(open_item, '打开 MailAI'), (poll_item, '立即收取邮件'),
                                     (state_item, '✓ 后台收信已开启'), (quit_item, '退出 MailAI')]

        NSApplication.sharedApplication().setActivationPolicy_(0)
        self._status_controller = controller
        self._status_item = status_item
        self._status_icon = status_icon
        try:
            self._notifications()
        except Exception:
            log.exception('初始化 macOS 通知失败；保留菜单栏并等待通知重试')

    def refresh_language(self):
        def apply():
            if self._status_item:
                self._status_item.button().setToolTip_(ui_text('MailAI · 后台收信中'))
            for item, source in self._native_menu_entries:
                item.setTitle_(ui_text(source))
            if self._main_menu:
                self._main_menu.refresh_language()
        if self._native_menu_entries or self._main_menu:
            self._call_after_safely('refresh native language', apply)


class DesktopApi:
    def __init__(self, runtime: DesktopRuntime):
        self._runtime = runtime
        self._macos_chrome_ready = False

    def open_compose_window(self, draft_id: int, account_id: str):
        from .compose_windows import open_window
        try:
            return open_window(self._runtime, draft_id, account_id, self)
        except (ValueError, RuntimeError):
            return {'ok': False, 'message': '独立窗口未打开，草稿仍保留；请检查草稿与邮箱连接后重试'}

    def _prepare_window(self):
        """Run on Cocoa's before_show event so the first web frame has final geometry."""
        from .macos_appearance import apply_window_appearance, install_unified_titlebar
        native = self._runtime.window.native
        install_unified_titlebar(native)
        self._macos_chrome_ready = True
        dark = native.effectiveAppearance().bestMatchFromAppearancesWithNames_(
            ['NSAppearanceNameAqua', 'NSAppearanceNameDarkAqua']) == 'NSAppearanceNameDarkAqua'
        apply_window_appearance(native, 'dark' if dark else 'light', 'system')

    def set_window_theme(self, theme, mode='system'):
        """Only the macOS shell opts into the matching native/web canvas."""
        if sys.platform != "darwin" or theme not in ("light", "dark") or mode not in ("light", "dark", "system"):
            return {"ok": False}
        from .macos_appearance import apply_window_appearance, install_unified_titlebar
        runtime = self._runtime
        def apply():
            native = getattr(runtime.window, "native", None)
            if native is not None:
                if not self._macos_chrome_ready:
                    install_unified_titlebar(native)
                    self._macos_chrome_ready = True
                apply_window_appearance(native, theme, mode)
        return {"ok": runtime._call_after_safely("更新窗口主题", apply)}

    def set_window_drag_region(self, left, right, viewport_width, gaps=None):
        import math
        if sys.platform != 'darwin':
            return {"ok": False}
        values = (left, right, viewport_width)
        if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in values):
            return {"ok": False}
        if not 0 <= left < right <= viewport_width or viewport_width <= 0:
            return {"ok": False}
        if gaps is not None:
            if not isinstance(gaps, list) or len(gaps) > 32:
                return {'ok': False}
            for gap in gaps:
                if (not isinstance(gap, list) or len(gap) != 2
                        or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in gap)
                        or not 0 <= gap[0] < gap[1] <= viewport_width):
                    return {'ok': False}
        from .macos_appearance import update_drag_region
        def apply():
            native = getattr(self._runtime.window, 'native', None)
            if native is not None:
                if gaps is None:
                    update_drag_region(native, left, right, viewport_width)
                else:
                    update_drag_region(native, left, right, viewport_width, gaps)
        return {"ok": self._runtime._call_after_safely('更新窗口拖动区域', apply)}

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

    def copy_image_png(self, data_url: str):
        """Copy a user-selected rendered image when the webview lacks ClipboardItem."""
        import base64
        import binascii
        if sys.platform != 'darwin':
            raise ValueError('当前桌面环境不支持图片复制')
        prefix = 'data:image/png;base64,'
        if not isinstance(data_url, str) or not data_url.startswith(prefix):
            raise ValueError('图片格式无效')
        encoded = data_url[len(prefix):]
        if len(encoded) > 28_000_000:
            raise ValueError('图片过大')
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ValueError('图片数据无效') from exc
        if not raw.startswith(b'\x89PNG\r\n\x1a\n') or len(raw) > 20 * 1024 * 1024:
            raise ValueError('图片格式或大小无效')
        from AppKit import NSPasteboard, NSPasteboardTypePNG
        from Foundation import NSData
        board = NSPasteboard.generalPasteboard()
        board.clearContents()
        if not board.setData_forType_(NSData.dataWithBytes_length_(raw, len(raw)), NSPasteboardTypePNG):
            raise ValueError('系统剪贴板写入失败')
        return {'ok': True}

    def open_attachment(self, email_id: int, attachment_index: int, account_id: str = "", source: str = "email"):
        """Open a user-selected attachment using the system's default application."""
        from .desktop_attachments import load_attachment, open_attachment_copy
        return open_attachment_copy(load_attachment(email_id, attachment_index, account_id, source))

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
        from .macos_menu import install_menu_factory
        native_menu = install_menu_factory(runtime, cocoa)
        from .mail_navigation import navigation_delegate

        restore_native_context_menu(cocoa.BrowserView.WebKitHost)

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
            def applicationDidBecomeActive_(self, notification):
                runtime.sync_native_foreground()

            def applicationDidResignActive_(self, notification):
                runtime.set_window_foreground(False)

            def applicationDidHide_(self, notification):
                runtime.set_window_foreground(False)

            def applicationDidUnhide_(self, notification):
                runtime.sync_native_foreground()

            def applicationShouldTerminate_(self, app):
                if not runtime.quitting:
                    runtime.quit()
                    return 0  # NSTerminateCancel; retry only after drafts are saved.
                return super().applicationShouldTerminate_(app)

            def applicationShouldHandleReopen_hasVisibleWindows_(self, app, has_visible_windows):
                runtime.show_window()
                return True

        cocoa.BrowserView.AppDelegate = MailAIAppDelegate

        desktop_api = DesktopApi(runtime)
        window = webview.create_window(
            "MailAI",
            url=url + "?shell=macos",
            js_api=desktop_api,
            width=1440,
            height=900,
            min_size=(900, 640),
            resizable=True,
            background_color="#f1f4f2",
            text_select=True,
        )
        runtime.window = window
        window.events.before_load += native_menu.web_loading
        window.events.loaded += native_menu.web_loaded
        window.events.before_show += desktop_api._prepare_window
        window.events.closing += runtime.handle_closing
        window.events.minimized += lambda: runtime.set_window_foreground(False)
        window.events.restored += lambda: runtime._call_after_safely(
            '恢复窗口节能状态', runtime.sync_native_foreground)
        window.events.loaded += lambda: runtime._call_after_safely(
            '初始化窗口节能状态', lambda: runtime.sync_native_foreground(force=True))

        def ready():
            runtime._call_after_safely("刷新 Dock 图标", refresh_macos_dock_icon)
            runtime._call_after_safely("安装菜单栏控件", runtime.install_native_controls)
            threading.Thread(target=runtime.refresh_dock_badge,
                             name="mailai-dock-unread", daemon=True).start()

        from .paths import USER_DIR
        webview.start(ready, gui="cocoa", debug=False, private_mode=False,
                      storage_path=str(USER_DIR / "webview"))
        if not runtime.quitting:
            log.warning("macOS WebView 事件循环在未收到退出指令时结束")
    finally:
        runtime.quitting = True
        _runtime = None
        local_server.stop()
