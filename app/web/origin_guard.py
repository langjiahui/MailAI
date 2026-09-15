"""Protect the local desktop API from cross-site requests and DNS rebinding."""
from urllib.parse import urlsplit
from starlette.responses import JSONResponse
from .. import config


def _origin(value):
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
            return None
        return parsed.scheme, parsed.hostname.lower(), parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError:
        return None


class LocalOriginMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = {key.lower(): value.decode("latin-1") for key, value in scope.get("headers", [])}
        expected = _origin(scope.get("scheme", "http") + "://" + headers.get(b"host", ""))
        allowed_hosts = {"127.0.0.1", "localhost", "::1"}
        configured = str(getattr(config, "WEB_HOST", "127.0.0.1")).lower()
        if configured not in ("0.0.0.0", "::", ""):
            allowed_hosts.add(configured)
        blocked = expected is None or expected[1] not in allowed_hosts
        if scope.get("path", "").startswith("/api/"):
            # Browsers attach Origin to mutations and Fetch Metadata to requests;
            # same-site is NOT same-origin (another local port is untrusted).
            origin = headers.get(b"origin")
            referer = headers.get(b"referer")
            if origin is not None:
                blocked |= _origin(origin) != expected
            elif referer is not None:
                blocked |= _origin(referer) != expected
            blocked |= headers.get(b"sec-fetch-site", "") in ("cross-site", "same-site")
        if blocked:
            return await JSONResponse({"detail": "为保护本机邮箱，已拒绝来自其他网页的请求。请在 MailAI 中操作。"}, status_code=403)(scope, receive, send)

        async def secure_send(message):
            if message["type"] == "http.response.start":
                message = dict(message)
                response_headers = list(message.get("headers", []))
                response_headers.extend([(b"x-content-type-options", b"nosniff"), (b"x-frame-options", b"DENY")])
                if scope.get("path", "").startswith("/api/"):
                    response_headers = [(k, v) for k, v in response_headers if k.lower() != b"cache-control"]
                    response_headers.append((b"cache-control", b"no-store"))
                message["headers"] = response_headers
            await send(message)
        await self.app(scope, receive, secure_send)
