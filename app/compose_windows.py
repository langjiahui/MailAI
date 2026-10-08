"""Native compose windows share the draft store and participate in safe exit."""

import threading
from urllib.parse import urlencode, urlsplit
from . import db
from .account_context import snapshot, use

_lock = threading.Lock()


def open_window(runtime, draft_id, account_id, delegate):
    if not isinstance(draft_id, int) or draft_id <= 0:
        raise ValueError("请先保存草稿")
    values = snapshot(account_id)
    with use(values):
        if not db.get_draft(draft_id):
            raise ValueError("草稿已发送或删除，请重新打开")
    import webview

    base = urlsplit(runtime.window.get_current_url())
    if base.hostname != "127.0.0.1" or base.scheme != "http":
        raise ValueError("独立写信只能连接本机 MailAI 服务")
    key = (account_id, draft_id)
    with _lock:
        windows = getattr(runtime, "_compose_windows", {})
        runtime._compose_windows = windows
        if key in windows:
            windows[key].show()
            return {"ok": True}
        if len(windows) >= 3:
            raise ValueError("最多同时打开 3 个独立写信窗口")
        url = f"http://127.0.0.1:{base.port}/?" + urlencode(
            {"compose_draft": draft_id, "compose_account": account_id}
        )
        window = webview.create_window(
            "MailAI · 写邮件",
            url=url,
            width=1050,
            height=760,
            min_size=(600, 500),
            resizable=True,
            text_select=True,
            js_api=delegate,
        )
        if window is None:
            raise ValueError("无法打开独立写信窗口，草稿仍保留")
        windows[key] = window
        window._mailai_exit_ready = False
    pending = threading.Event()

    def closing(*args):
        if runtime.quitting or window._mailai_exit_ready:
            return True
        if pending.is_set():
            return False
        pending.set()
        settled = threading.Event()

        def completed(ok):
            if settled.is_set():
                return
            settled.set()
            timer.cancel()
            pending.clear()
            if ok is True:
                window._mailai_exit_ready = True
                window.destroy()
            else:
                window.show()

        timer = threading.Timer(20, lambda: completed(False))
        timer.daemon = True
        timer.start()

        def evaluate():
            try:
                window.evaluate_js(
                    "Promise.resolve(window.mailaiPrepareExit ? window.mailaiPrepareExit() : true)",
                    callback=completed,
                )
            except Exception:
                completed(False)

        threading.Thread(
            target=evaluate, name="mailai-compose-save", daemon=True
        ).start()
        return False

    def closed(*args):
        with _lock:
            windows.pop(key, None)

    window.events.closing += closing
    window.events.closed += closed
    return {"ok": True}
