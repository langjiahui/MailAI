"""Flush the editor before an intentional native exit, without blocking the UI."""
import logging
import threading

log = logging.getLogger(__name__)


def request_safe_exit(runtime, finish):
    if getattr(runtime, '_draft_exit_pending', False) or runtime.quitting:
        return
    if not runtime.window:
        finish()
        return
    runtime._draft_exit_pending = True
    settled = threading.Event()
    lock = threading.Lock()

    def complete(ok):
        with lock:
            if settled.is_set():
                return
            settled.set()
        timer.cancel()
        runtime._draft_exit_pending = False
        if ok is True:
            finish()
        else:
            runtime.show_window()

    timer = threading.Timer(20, lambda: complete(False))
    timer.daemon = True
    timer.start()

    def evaluate():
        try:
            runtime.window.evaluate_js(
                'Promise.resolve(window.mailaiPrepareExit ? window.mailaiPrepareExit() : true)',
                callback=complete,
            )
        except Exception:
            log.exception('退出前保存草稿失败；已保留应用窗口')
            complete(False)

    threading.Thread(target=evaluate, name='mailai-save-before-exit', daemon=True).start()
