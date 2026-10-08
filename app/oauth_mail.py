"""Native OAuth with PKCE, expiring loopback sessions and vault-only token storage."""

import base64
import hashlib
import http.client
import json
import os
import secrets
import ssl
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlencode, urlsplit, parse_qs
import certifi
from . import config, credential_store
from .paths import USER_DIR

PROVIDERS = {
    "google": {
        "authorize": "https://accounts.google.com/o/oauth2/v2/auth",
        "token": "https://oauth2.googleapis.com/token",
        "scope": "https://mail.google.com/",
        "host": "imap.gmail.com",
        "smtp_host": "smtp.gmail.com",
        "smtp_port": 465,
        "smtp_ssl": True,
        "smtp_starttls": False,
    },
    "microsoft": {
        "authorize": "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        "token": "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        "scope": "offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send",
        "host": "outlook.office365.com",
        "smtp_host": "smtp.office365.com",
        "smtp_port": 587,
        "smtp_ssl": False,
        "smtp_starttls": True,
    },
}
_lock = threading.RLock()
_flows = {}
_tokens = {}
_token_locks = {}


def clients():
    try:
        return json.loads((USER_DIR / "oauth-clients.json").read_text())
    except (OSError, ValueError):
        return {}


def save_client(provider, client_id, secret=""):
    if (
        provider not in PROVIDERS
        or not isinstance(client_id, str)
        or not client_id.strip()
        or len(client_id) > 300
        or any(ch.isspace() for ch in client_id)
    ):
        raise ValueError("请填写有效的客户端 ID")
    if provider == "microsoft" and secret:
        raise ValueError("Microsoft 使用桌面公共客户端，无需客户端密钥")
    if secret and not credential_store.save("oauth-client:" + provider, secret):
        raise ValueError("系统凭据库不可用，未保存客户端密钥")
    with _lock:
        values = clients()
        values[provider] = {"client_id": client_id.strip()}
        USER_DIR.mkdir(parents=True, exist_ok=True)
        path = USER_DIR / "oauth-clients.json"
        temp = path.with_suffix(".tmp")
        temp.write_text(json.dumps(values), encoding="utf-8")
        os.chmod(temp, 0o600)
        os.replace(temp, path)
    return {"ok": True}


def _exchange(provider, values):
    """Only pinned public provider endpoints, no redirects or user-defined URLs."""
    from .security.chains import _public_target

    url = PROVIDERS[provider]["token"]
    parsed = urlsplit(url)
    host, addresses = _public_target(url)
    body = urlencode(values)
    conn = http.client.HTTPSConnection(
        host,
        443,
        timeout=20,
        context=ssl.create_default_context(cafile=certifi.where()),
    )
    import socket

    conn._create_connection = (
        lambda _address, timeout, source_address=None: socket.create_connection(
            (addresses[0], 443), timeout, source_address
        )
    )
    try:
        conn.request(
            "POST",
            parsed.path,
            body,
            {
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "application/json",
            },
        )
        response = conn.getresponse()
        raw = response.read(1024 * 1024 + 1)
        if response.status != 200 or len(raw) > 1024 * 1024:
            raise ValueError(
                "官方授权未完成或已失效，请重新授权；若持续失败请检查客户端类型与邮箱权限"
            )
        value = json.loads(raw)
        if not value.get("access_token") or not isinstance(
            value.get("expires_in"), (int, float)
        ):
            raise ValueError("官方服务没有返回有效授权")
        return value
    except (OSError, ValueError) as exc:
        if isinstance(exc, ValueError):
            raise
        raise ValueError("无法连接官方授权服务，请检查网络后重试") from exc
    finally:
        conn.close()


def _load_token(account_id):
    with _lock:
        if account_id in _tokens:
            return dict(_tokens[account_id])
        try:
            record = json.loads(credential_store.load("oauth:" + account_id) or "{}")
        except ValueError:
            record = {}
        if record.get("provider") in PROVIDERS and record.get("refresh_token"):
            _tokens[account_id] = record
            return dict(record)
    return {}


def available(account_id):
    return bool(_load_token(account_id))


def forget(account_id):
    with _lock:
        _tokens.pop(account_id, None)
    credential_store.delete("oauth:" + account_id)


def access_token(account_id):
    with _lock:
        lock = _token_locks.setdefault(account_id, threading.RLock())
    with lock:
        record = _load_token(account_id)
        if not record:
            raise ValueError("官方登录已失效，请重新授权")
        if record.get("expires_at", 0) > time.time() + 90:
            return record["access_token"]
        provider = record["provider"]
        client = clients().get(provider, {})
        if not client.get("client_id"):
            raise ValueError("请配置官方登录客户端 ID")
        fields = {
            "grant_type": "refresh_token",
            "refresh_token": record["refresh_token"],
            "client_id": client["client_id"],
        }
        if provider == "google":
            secret = credential_store.load("oauth-client:google")
            if secret:
                fields["client_secret"] = secret
        value = _exchange(provider, fields)
        record.update(
            access_token=value["access_token"],
            refresh_token=value.get("refresh_token") or record["refresh_token"],
            expires_at=time.time() + value["expires_in"],
        )
        if not credential_store.save("oauth:" + account_id, json.dumps(record)):
            raise ValueError("无法安全保存更新后的授权，请检查系统凭据库")
        with _lock:
            _tokens[account_id] = record
        return record["access_token"]


def account_id_for(user="", host=""):
    from . import system_settings

    return getattr(config, "ACCOUNT_ID", "") or system_settings._account_key(
        host or config.IMAP_HOST, user or config.IMAP_USER
    )


def is_oauth(user="", host=""):
    from . import system_settings

    if user and user.casefold() != (config.IMAP_USER or "").casefold():
        return False
    key = account_id_for(user, host)
    return (
        system_settings._load_registry()
        .get("accounts", {})
        .get(key, {})
        .get("auth_type")
        == "oauth2"
    )


def imap_login(client, user, password, *, values=None):
    if values and values.get("oauth_token"):
        return client.oauth2_login(user, values["oauth_token"])
    if values is not None:
        return client.login(user, password)
    if is_oauth(user):
        return client.oauth2_login(user, access_token(account_id_for(user)))
    return client.login(user, password)


def smtp_login(client, user, password, *, values=None):
    if values and values.get("oauth_token"):
        token = values["oauth_token"]
    elif values is not None:
        return client.login(user, password)
    elif is_oauth(user):
        token = access_token(account_id_for(user))
    else:
        return client.login(user, password)
    raw = f"user={user}\x01auth=Bearer {token}\x01\x01"
    # smtplib base64-encodes initial responses. Never use plaintext token logs.
    return client.auth(
        "XOAUTH2", lambda challenge=None: raw if challenge is None else ""
    )


def begin(provider, user):
    from .web.helpers import valid_contact_email

    user = valid_contact_email(user)
    if provider not in PROVIDERS:
        raise ValueError("不支持的邮箱厂商")
    client = clients().get(provider, {})
    if not client.get("client_id"):
        raise ValueError("请先配置客户端 ID")
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(48)
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
        .decode()
        .rstrip("=")
    )
    flow = {
        "provider": provider,
        "user": user,
        "verifier": verifier,
        "created": time.time(),
        "status": "waiting",
    }

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            query = parse_qs(urlsplit(self.path).query)
            supplied = query.get("state", [""])[0]
            if not secrets.compare_digest(supplied, state):
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b"Invalid authorization session")
                return
            with _lock:
                if flow["status"] != "waiting" or time.time() - flow["created"] > 600:
                    self.send_response(410)
                    self.end_headers()
                    return
                flow["status"] = "exchanging"
            try:
                if query.get("error") or not query.get("code"):
                    raise ValueError("官方登录已取消，请返回 MailAI 重新发起")
                fields = {
                    "grant_type": "authorization_code",
                    "client_id": client["client_id"],
                    "redirect_uri": flow["redirect_uri"],
                    "code": query["code"][0],
                    "code_verifier": verifier,
                }
                if provider == "google":
                    secret = credential_store.load("oauth-client:google")
                    if secret:
                        fields["client_secret"] = secret
                value = _exchange(provider, fields)
                if not value.get("refresh_token"):
                    raise ValueError("未获得离线授权，请在官方页面重新同意邮箱权限")
                flow["tokens"] = value
                flow["status"] = "ready"
                text = "授权已返回，请回到 MailAI 点击“连接邮箱”完成连接。"
            except Exception as exc:
                flow["status"] = "failed"
                flow["error"] = (
                    str(exc) if isinstance(exc, ValueError) else "授权未完成，请重试"
                )
                text = "授权未完成，请返回 MailAI 查看原因。"
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header(
                "Content-Security-Policy",
                "default-src 'none'; style-src 'unsafe-inline'",
            )
            self.end_headers()
            self.wfile.write(
                (
                    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>MailAI 官方登录</title><p>'
                    + text
                    + "</p></html>"
                ).encode()
            )

    with _lock:
        for key, value in list(_flows.items()):
            if time.time() - value["created"] > 600:
                _flows.pop(key, None)
        if sum(f["status"] == "waiting" for f in _flows.values()) >= 3:
            raise ValueError("请先完成或取消已有的官方登录")
        server = HTTPServer(("127.0.0.1", 0), Handler)
        server.timeout = 1
        hostname = "localhost" if provider == "microsoft" else "127.0.0.1"
        flow["redirect_uri"] = f"http://{hostname}:{server.server_port}/"
        flow["server"] = server
        _flows[state] = flow

    def serve():
        try:
            while time.time() - flow["created"] < 600 and flow["status"] == "waiting":
                server.handle_request()
        finally:
            server.server_close()

    threading.Thread(target=serve, name="mailai-oauth-callback", daemon=True).start()
    fields = {
        "client_id": client["client_id"],
        "redirect_uri": flow["redirect_uri"],
        "response_type": "code",
        "scope": PROVIDERS[provider]["scope"],
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "login_hint": user,
    }
    if provider == "google":
        fields.update(access_type="offline", prompt="consent")
    return {
        "state": state,
        "url": PROVIDERS[provider]["authorize"] + "?" + urlencode(fields),
        "redirect_uri": flow["redirect_uri"],
        "expires_in": 600,
    }


def status(state):
    with _lock:
        flow = _flows.get(state)
        if not flow or time.time() - flow["created"] > 600:
            return {"status": "expired", "message": "登录已过期，请重试"}
        return {"status": flow["status"], "message": flow.get("error", "")}


def cancel(state):
    with _lock:
        flow = _flows.get(state)
        if flow:
            flow["status"] = "canceled"
            flow.pop("tokens", None)
    return {"ok": True}


def complete(state):
    from . import system_settings

    with _lock:
        flow = _flows.get(state)
        if not flow or flow["status"] != "ready" or time.time() - flow["created"] > 600:
            raise ValueError("授权未就绪或已过期，请重新登录")
        flow["status"] = "connecting"
    provider, user = flow["provider"], flow["user"]
    settings = PROVIDERS[provider]
    values = {
        "host": settings["host"],
        "port": 993,
        "user": user,
        "password": "oauth2",
        "ssl": True,
        "verify_ssl": True,
        "smtp_host": settings["smtp_host"],
        "smtp_port": settings["smtp_port"],
        "smtp_ssl": settings["smtp_ssl"],
        "smtp_starttls": settings["smtp_starttls"],
        "smtp_verify_ssl": True,
        "oauth_token": flow["tokens"]["access_token"],
        "auth_type": "oauth2",
    }
    key = system_settings._account_key(settings["host"], user)
    record = {
        "provider": provider,
        "access_token": flow["tokens"]["access_token"],
        "refresh_token": flow["tokens"]["refresh_token"],
        "expires_at": time.time() + flow["tokens"]["expires_in"],
    }
    try:
        # Prove mailbox identity with the token before writing registry or vault.
        system_settings.test_mail_connection(values)
        if not credential_store.save("oauth:" + key, json.dumps(record)):
            raise ValueError("无法安全保存官方授权，请检查系统凭据库；邮箱尚未连接")
        with _lock:
            _tokens[key] = record
        result = system_settings.login_mail(values)
        with _lock:
            flow["status"] = "complete"
            flow.pop("tokens", None)
        return {**result, "config": system_settings.public_config()}
    except Exception as exc:
        with _lock:
            flow["status"] = "failed"
            flow.pop("tokens", None)
        raise ValueError(
            "邮箱连接未完成，请检查 IMAP/SMTP 权限、预期邮箱地址和系统凭据库后重新登录"
        ) from exc
