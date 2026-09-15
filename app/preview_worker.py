"""Disposable preview processes: a hung native decoder cannot hold the server."""
import multiprocessing
import threading

_slots = threading.BoundedSemaphore(2)
TIMEOUT_SECONDS = 20


def _render(output, attachment, page):
    try:
        from .attachment_preview import _preview_attachment
        output.send(_preview_attachment(attachment, page))
    finally:
        output.close()


def preview_isolated(attachment, page=0, *, timeout=TIMEOUT_SECONDS, worker=_render):
    fallback = {'name': attachment.get('name') or '附件',
                'size': len(attachment['payload']), 'kind': 'unsupported'}
    if not _slots.acquire(blocking=False):
        return {**fallback, 'message': '其他附件正在预览，请稍后重试'}
    incoming = outgoing = process = None
    started = False
    try:
        context = multiprocessing.get_context('spawn')
        incoming, outgoing = context.Pipe(duplex=False)
        process = context.Process(target=worker, args=(outgoing, attachment, page), daemon=True)
        process.start()
        started = True
        outgoing.close()
        if not incoming.poll(timeout):
            return {**fallback, 'message': '附件预览超时，已停止处理；请下载后查看'}
        return incoming.recv()
    except (EOFError, OSError, RuntimeError):
        return {**fallback, 'message': '附件预览进程异常退出或无法启动，请下载后查看'}
    finally:
        try:
            if incoming is not None:
                incoming.close()
            if outgoing is not None:
                outgoing.close()
            if started:
                process.join(timeout=0.2)
                if process.is_alive():
                    process.terminate()
                    process.join(timeout=1)
                if process.is_alive():
                    process.kill()
                    process.join(timeout=1)
                if not process.is_alive():
                    process.close()
        finally:
            _slots.release()
