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

    windows = [runtime.window, *list(getattr(runtime, '_compose_windows', {}).values())]
    remaining = len(windows)
    completed_windows = set()
    callbacks_lock = threading.Lock()

    def saved(window, ok):
        nonlocal remaining
        if ok is not True:
            if window is not runtime.window:
                window.show()
            return complete(False)
        with callbacks_lock:
            if settled.is_set():
                return
            if id(window) in completed_windows:
                return
            completed_windows.add(id(window))
            if window is not runtime.window:
                window._mailai_exit_ready = True
            remaining -= 1
            finished = remaining == 0
        if finished:
            for child in windows[1:]:
                child.destroy()
            complete(True)

    def evaluate():
        try:
            for window in windows:
                window.evaluate_js(
                    'Promise.resolve(window.mailaiPrepareExit ? window.mailaiPrepareExit() : true)',
                    callback=lambda ok, target=window: saved(target, ok),
                )
        except Exception:
            log.exception('退出前保存草稿失败；已保留应用窗口')
            complete(False)

    threading.Thread(target=evaluate, name='mailai-save-before-exit', daemon=True).start()
