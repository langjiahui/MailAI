"""Keep global account configuration stable for requests and background work.

Shared leases allow parallel operations; account changes require an exclusive lease.
Leases do not depend on thread identity, so streaming ASGI responses are covered.
"""
import threading
from functools import wraps


class AccountBusy(RuntimeError):
    pass


class AccountGuard:
    def __init__(self):
        self._lock = threading.Lock()
        self._available = threading.Condition(self._lock)
        self._readers = 0
        self._changing = False

    def acquire(self, exclusive=False):
        with self._lock:
            if self._changing or (exclusive and self._readers):
                return False
            if exclusive:
                self._changing = True
            else:
                self._readers += 1
            return True

    def release(self, exclusive=False):
        with self._lock:
            if exclusive:
                self._changing = False
            else:
                self._readers -= 1
            self._available.notify_all()

    def acquire_work(self):
        with self._available:
            self._available.wait_for(lambda: not self._changing)
            self._readers += 1

    def reserve_work(self):
        """Called while the scheduler owns a request/startup account lease.

        Reserve before thread startup, including within the login exclusive lease.
        This closes the gap in which another request could switch accounts.
        """
        with self._lock:
            self._readers += 1

    def wait_ready(self):
        with self._available:
            self._available.wait_for(lambda: not self._changing)


guard = AccountGuard()


def start_account_thread(target, *, name=None):
    """Pin the scheduling account until a background task finishes."""
    guard.reserve_work()
    from .account_context import current, use
    scoped = current.get()
    def run():
        try:
            guard.wait_ready()
            if scoped is not None:
                with use(scoped):
                    target()
            else:
                target()
        finally:
            guard.release()
    thread = threading.Thread(target=run, daemon=True, name=name)
    try:
        thread.start()
    except BaseException:
        guard.release()
        raise
    return thread


def account_work(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        from .account_context import current
        if current.get() is not None:
            return function(*args, **kwargs)
        guard.acquire_work()
        try:
            return function(*args, **kwargs)
        finally:
            guard.release()
    return wrapped


class AccountGuardMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        if scope["type"] != "http" or not path.startswith("/api/"):
            return await self.app(scope, receive, send)
        public = path in {
            "/api/system/config", "/api/system/mail/discover",
            "/api/system/mail/login", "/api/system/mail/logout",
            "/api/system/mail/switch", "/api/system/mail/preferred", "/api/system/model",
            "/api/system/model/test", "/api/health",
        }
        headers = dict(scope.get('headers', []))
        account_id = headers.get(b'x-mailai-account', b'').decode('ascii', errors='ignore')
        if not account_id and scope.get('method') == 'GET':
            from urllib.parse import parse_qs
            account_id = parse_qs(scope.get('query_string', b'').decode()).get('mailai_account', [''])[0]
        if not public and not account_id:
            from . import config
            if not (config.IMAP_USER and config.IMAP_PASSWORD):
                from starlette.responses import JSONResponse
                response = JSONResponse({"detail": "请先登录邮箱账号"}, status_code=401)
                return await response(scope, receive, send)
        exclusive = path in {
            "/api/system/server-cleanup/execute",
            "/api/system/mail/login", "/api/system/mail/logout", "/api/system/mail/switch"
        } or (path.startswith("/api/system/backups/") and path.endswith("/restore"))
        if not guard.acquire(exclusive):
            from starlette.responses import JSONResponse
            response = JSONResponse({"detail": "邮箱仍有操作或对话正在进行，请完成后重试切换或恢复。"}, status_code=409)
            return await response(scope, receive, send)
        try:
            global_settings = path in {'/api/system/config', '/api/system/mail/login', '/api/system/mail/logout',
                                      '/api/system/mail/switch', '/api/system/mail/account/update',
                                      '/api/system/mail/preferred',
                                      '/api/system/mail/discover', '/api/system/model', '/api/system/model/test'}
            if account_id and not global_settings:
                from .account_context import snapshot, use
                try:
                    values = snapshot(account_id)
                except ValueError as exc:
                    from starlette.responses import JSONResponse
                    return await JSONResponse({'detail': str(exc)}, status_code=409)(scope, receive, send)
                with use(values):
                    return await self.app(scope, receive, send)
            # Hold through the final streaming chunk, not just response headers.
            await self.app(scope, receive, send)
        finally:
            guard.release(exclusive)
