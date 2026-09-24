"""系统连接配置、敏感字段掩码与邮箱账号级数据隔离。"""
import hashlib
import json
import os
import shutil
import ssl
import certifi
import sqlite3
import stat
import tempfile
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import closing, contextmanager
from datetime import datetime
from pathlib import Path

from dotenv import set_key
from imapclient import IMAPClient

from . import config, db, credential_store, smtp_client
from .mail_providers import discover
from .llm import client as llm_client
from .llm.providers import KEYLESS_PLACEHOLDER, KEYLESS_PROVIDERS, PRESETS, completion_url, validate_extra

ENV_PATH = config.CONFIG_PATH
ACCOUNTS_DIR = os.path.join(config.DATA_DIR, "accounts")
REGISTRY_PATH = os.path.join(config.DATA_DIR, "account_registry.json")
LEGACY_DB_PATH = os.path.join(config.DATA_DIR, "mailai.db")
LEGACY_RAW_DIR = os.path.join(config.DATA_DIR, "raw")
_session_credentials = {}
_verified_model_fingerprints = set()
SESSION_CREDENTIAL_NOTICE = "系统凭据库保存失败，授权码仅在本次运行中使用；退出软件后需要重新登录。"


def account_password(account_id):
    if account_id in _session_credentials:
        return _session_credentials[account_id]
    account = _load_registry().get("accounts", {}).get(account_id, {})
    # A failed replacement must never revive an older password from the vault.
    if account.get("credential_storage") == "session":
        return ""
    return credential_store.load(account_id)


def _save_account_password(account_id, password):
    saved = credential_store.save(account_id, password)
    if saved:
        _session_credentials.pop(account_id, None)
    else:
        _session_credentials[account_id] = password
    registry = _load_registry()
    registry["accounts"][account_id]["credential_storage"] = "vault" if saved else "session"
    _save_registry(registry)
    return saved


@contextmanager
def _sqlite_connection(path: str):
    """Transactional SQLite connection that is always closed on Windows too."""
    connection = sqlite3.connect(path)
    # Search-index triggers call this local function on email writes, including
    # staged backup restores that intentionally bypass db.conn().
    from .mail_search import register
    register(connection)
    try:
        yield connection
        connection.commit()
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.close()


class MailConnectionError(RuntimeError):
    def __init__(self, stage: str, cause: Exception):
        super().__init__(str(cause))
        self.stage = stage
        self.cause = cause


def _mask(value: str) -> str:
    if not value:
        return ""
    if len(value) <= 8:
        return "••••••••"
    return value[:3] + "••••••••" + value[-3:]


def _load_registry() -> dict:
    try:
        with open(REGISTRY_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {"accounts": {}, "last_account": ""}


def _save_registry(registry: dict):
    os.makedirs(config.DATA_DIR, exist_ok=True)
    tmp = REGISTRY_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(registry, f, ensure_ascii=False, indent=2)
    os.replace(tmp, REGISTRY_PATH)


def _account_key(host: str, user: str) -> str:
    return hashlib.sha256(f"{host.lower()}|{user.lower()}".encode()).hexdigest()[:16]


def _persist(updates: dict[str, object]):
    Path(ENV_PATH).touch(exist_ok=True)
    for key, value in updates.items():
        set_key(ENV_PATH, key, str(value).lower() if isinstance(value, bool) else str(value), quote_mode="auto")


def initialize_current_account():
    """恢复默认账号；无已保存账号时保持未登录，由前端进入登录页。"""
    registry = _load_registry()
    # Installed builds intentionally persist an empty password and recover it
    # from the credential vault. Always honor the server-side preferred account
    # in that case; browser localStorage may be reset by an app reinstall.
    if not config.IMAP_PASSWORD:
        visible = [(key, item) for key, item in registry.get("accounts", {}).items()
                   if item.get("visible", True)]
        preferred = registry.get("last_account", "")
        ordered = sorted(visible, key=lambda pair: pair[0] != preferred)
        selected = None
        for key, item in ordered:
            password = account_password(key)
            if password:
                selected = (key, item, password)
                break
        if not selected:
            if not config.IMAP_USER:
                return
        else:
            account_id, account, password = selected
            fallback = discover(account.get("user", ""))
            config.IMAP_HOST = account.get("host") or fallback["imap_host"]
            config.IMAP_PORT = int(account.get("port") or fallback["imap_port"])
            config.IMAP_USER, config.IMAP_PASSWORD = account.get("user", ""), password
            config.IMAP_SSL = bool(account.get("ssl", fallback["imap_ssl"]))
            config.IMAP_VERIFY_SSL = bool(account.get("verify_ssl", True))
            config.SMTP_HOST = account.get("smtp_host") or fallback["smtp_host"]
            config.SMTP_PORT = int(account.get("smtp_port") or fallback["smtp_port"])
            config.SMTP_SSL = bool(account.get("smtp_ssl", fallback["smtp_ssl"]))
            config.SMTP_STARTTLS = bool(account.get("smtp_starttls", fallback["smtp_starttls"]))
            config.SMTP_VERIFY_SSL = bool(account.get("smtp_verify_ssl", True))
            config.SMTP_USER, config.SMTP_PASSWORD = "", ""
            config.SMTP_USE_IMAP_CREDENTIALS = True
            registry["last_account"] = account_id
            _save_registry(registry)
            _activate_storage(account)
            _persist({"IMAP_HOST": config.IMAP_HOST, "IMAP_PORT": config.IMAP_PORT,
                      "IMAP_USER": config.IMAP_USER, "IMAP_PASSWORD": "", "IMAP_SSL": config.IMAP_SSL,
                      "IMAP_VERIFY_SSL": config.IMAP_VERIFY_SSL, "SMTP_HOST": config.SMTP_HOST,
                      "SMTP_PORT": config.SMTP_PORT, "SMTP_SSL": config.SMTP_SSL,
                      "SMTP_STARTTLS": config.SMTP_STARTTLS, "SMTP_VERIFY_SSL": config.SMTP_VERIFY_SSL,
                      "SMTP_USE_IMAP_CREDENTIALS": True, "SMTP_SENT_IMAP_HOST": config.IMAP_HOST})
            return

    account_id = _account_key(config.IMAP_HOST, config.IMAP_USER)
    if account_id not in registry["accounts"]:
        registry["accounts"][account_id] = {
            "user": config.IMAP_USER,
            "host": config.IMAP_HOST,
            "port": config.IMAP_PORT, "ssl": config.IMAP_SSL,
            "verify_ssl": config.IMAP_VERIFY_SSL,
            "smtp_host": config.SMTP_HOST, "smtp_port": config.SMTP_PORT,
            "smtp_ssl": config.SMTP_SSL, "smtp_starttls": config.SMTP_STARTTLS,
            "smtp_verify_ssl": config.SMTP_VERIFY_SSL,
            "db_path": LEGACY_DB_PATH,
            "raw_dir": LEGACY_RAW_DIR,
        }
    registry["last_account"] = account_id
    _save_registry(registry)
    _activate_storage(registry["accounts"][account_id])
    stored = account_password(account_id)
    if stored:
        config.IMAP_PASSWORD = stored
        _persist({"IMAP_PASSWORD": ""})
    elif config.IMAP_PASSWORD:
        _save_account_password(account_id, config.IMAP_PASSWORD)
        _persist({"IMAP_PASSWORD": ""})


def _activate_storage(account: dict):
    config.DB_PATH = account["db_path"]
    config.RAW_DIR = account["raw_dir"]
    os.makedirs(config.RAW_DIR, exist_ok=True)
    db.init_db()


def public_config() -> dict:
    from . import pipeline
    registry = _load_registry()
    def local_counts(item: dict) -> dict:
        path = item.get("db_path") or ""
        if not path or not os.path.isfile(path):
            return {"inbox": 0, "unread": 0}
        try:
            with _sqlite_connection(path) as connection:
                row = connection.execute(
                    "SELECT COUNT(*) AS inbox, SUM(CASE WHEN is_read=0 THEN 1 ELSE 0 END) AS unread "
                    "FROM emails WHERE remote_missing=0 AND status='inbox'"
                ).fetchone()
                job = connection.execute("SELECT status,message,error,updated_at FROM sync_jobs WHERE job_key='mailbox'").fetchone()
                last = connection.execute("SELECT value FROM runtime_settings WHERE key='last_sync_success'").fetchone()
                oversized = connection.execute("SELECT value FROM runtime_settings WHERE key='oversized_mail_count'").fetchone()
            live = pipeline.get_live_fetch_state(path)
            # A persisted running record is a checkpoint, not proof of a live worker.
            status = 'running' if live['running'] else ('interrupted' if job and job[0] in ('running', 'pending') else job[0] if job else 'idle')
            return {"inbox": int(row[0] or 0), "unread": int(row[1] or 0),
                    'oversized_mail_count': int(oversized[0] or 0) if oversized else 0,
                    'sync_status': status,
                    'sync_message': live['message'] if live['running'] else '上次同步中断，可重新同步' if status == 'interrupted' else job[1] if job else '',
                    'sync_error': live['error'] if live['running'] else job[2] if job else '',
                    'sync_operation': live['operation'], 'sync_phase': live['phase'],
                    'sync_processed': live['processed'], 'sync_total': live['total'],
                    'sync_elapsed_seconds': live['elapsed_seconds'], 'sync_quiet_seconds': live['quiet_seconds'],
                    'sync_current_folder': live.get('current_folder', ''),
                    'sync_folder_progress': live.get('folder_progress', []),
                    'sync_folder_omitted': live.get('folder_omitted', 0),
                    'last_sync': last[0] if last else ''}
        except (OSError, sqlite3.Error):
            return {"inbox": 0, "unread": 0}
    profiles = _model_profiles()
    public_profiles = {provider: {key: value for key, value in values.items()
                                  if key not in ('verification_status', 'verified_fingerprint', 'api_key')}
                       for provider, values in profiles.items()}
    return {
        "mail": {
            "logged_in": bool(config.IMAP_USER and config.IMAP_PASSWORD),
            "host": config.IMAP_HOST, "port": config.IMAP_PORT,
            "user": config.IMAP_USER, "password_masked": _mask(config.IMAP_PASSWORD),
            "ssl": config.IMAP_SSL, "verify_ssl": config.IMAP_VERIFY_SSL,
            "inbox_folder": config.INBOX_FOLDER,
        },
        "model": {
            "saved_providers": list(profiles), "profiles": public_profiles,
            "provider": config.LLM_PROVIDER, "presets": PRESETS,
            "extra_params": config.LLM_EXTRA_PARAMS, "multimodal_enabled": config.MULTIMODAL_ENABLED,
            "base_url": config.LLM_BASE_URL, "model": config.LLM_MODEL,
            "multimodal_model": config.MULTIMODAL_MODEL,
            "api_key_masked": _mask(config.LLM_API_KEY),
            "verify_ssl": config.LLM_VERIFY_SSL,
            "available": llm_client.available(),
            "verified": _current_model_verified(profiles),
        },
        "smtp": {
            "configured": smtp_client.configured(),
            "verified": current_smtp_verified(),
            "host": config.SMTP_HOST, "port": config.SMTP_PORT,
            "user": config.SMTP_USER, "password_masked": _mask(config.SMTP_PASSWORD),
            "ssl": config.SMTP_SSL, "starttls": config.SMTP_STARTTLS,
            "verify_ssl": config.SMTP_VERIFY_SSL,
        },
        "accounts": [
            {"id": account_id, "user": item.get("user", ""), "host": item.get("host", ""),
             "active": bool(account_password(account_id)) and account_id == registry.get("last_account"),
             "credential_available": bool(account_password(account_id)),
             "credential_storage": item.get("credential_storage", "vault"),
             "auto_sync_paused": bool(item.get("auto_sync_paused", False)), **local_counts(item)}
            for account_id, item in registry.get("accounts", {}).items()
            if item.get("visible", True)
        ],
        "storage": {"account_isolated": True, "credential_vault": credential_store.available()},
    }


def current_smtp_verified() -> bool:
    registry = _load_registry()
    account = registry.get('accounts', {}).get(registry.get('last_account', ''), {})
    # Existing accounts predate this marker and retain their previous behavior.
    return bool(account.get('smtp_verified', True))


def list_unified_inbox(days: int = 9999, limit: int = 1000, offset: int = 0, q: str = '') -> list[dict]:
    """只读聚合所有可见账号的本地收件箱，不改变当前发信账号。"""
    registry = _load_registry()
    rows: list[dict] = []
    bounded_days = max(1, min(int(days or 9999), 9999))
    bounded_limit = max(1, min(int(limit or 1000), 3000))
    offset = max(0, int(offset))
    for account_id, item in registry.get("accounts", {}).items():
        if not item.get("visible", True):
            continue
        path = item.get("db_path") or ""
        if not path or not os.path.isfile(path):
            continue
        try:
            from .mail_search import predicate, match_preview
            import re
            with _sqlite_connection(path) as connection:
                connection.row_factory = sqlite3.Row
                condition, search_args = predicate(connection, re.split(r"\s+", q.strip()))
                account_rows = connection.execute(
                    f"SELECT {db.EMAIL_LIST_COLUMNS}{',body_text' if q.strip() else ''} FROM emails WHERE remote_missing=0 AND status='inbox' "
                    "AND datetime(COALESCE(NULLIF(date,''),created_at)) >= datetime('now','localtime', ?) "
                    f"AND {condition} ORDER BY date DESC,id DESC LIMIT ?",
                    [f"-{bounded_days} days", *search_args, bounded_limit + offset],
                ).fetchall()
                decoded_rows = db._decode_rows(account_rows)
                if q.strip():
                    for message in decoded_rows:
                        message['search_match'] = match_preview(message, re.split(r"\s+", q.strip()))
                        message.pop('body_text', None)
                contact_names = db.contact_display_names(
                    [value for message in decoded_rows
                     for value in (message.get("from_addr"), message.get("to_addr")) if value],
                    connection=connection,
                )
        except (OSError, sqlite3.Error):
            continue
        for message in decoded_rows:
            message["_account_id"] = account_id
            message["_account_user"] = item.get("user", "")
            address = str(message.get("from_addr") or "").strip().casefold()
            match = contact_names.get(address)
            message["_contact_names"] = {address: match} if match else {}
            rows.append(message)
    rows.sort(key=lambda item: (item.get("date") or item.get("created_at") or "", int(item.get("id") or 0), item['_account_id']), reverse=True)
    return rows[offset:offset + bounded_limit]


def test_mail_connection(values: dict) -> dict:
    verify = bool(values.get("verify_ssl", True))
    if verify:
        ctx = ssl.create_default_context(cafile=certifi.where())
    else:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    client = IMAPClient(values["host"], port=int(values["port"]), ssl=bool(values.get("ssl", True)),
                        ssl_context=ctx, timeout=15)
    try:
        client.login(values["user"], values["password"])
        folders = client.list_folders()
        return {"ok": True, "folders": len(folders)}
    finally:
        try:
            client.logout()
        except Exception:
            pass


def login_mail(values: dict):
    try:
        test_result = test_mail_connection(values)
    except Exception as exc:
        raise MailConnectionError("imap", exc) from exc
    try:
        smtp_result = smtp_client.test_connection(values)
        smtp_warning = ""
    except Exception:
        smtp_result = {"ok": False}
        smtp_warning = "收件邮箱已连接，但发件服务验证失败。你可以先阅读邮件，稍后在“邮箱账号”中修复发件设置。"
    host, user = values["host"].strip(), values["user"].strip()
    registry = _load_registry()
    account_id = _account_key(host, user)
    is_new_account = account_id not in registry["accounts"]
    if is_new_account:
        root = os.path.join(ACCOUNTS_DIR, account_id)
        registry["accounts"][account_id] = {
            "user": user, "host": host,
            "db_path": os.path.join(root, "mailai.db"),
            "raw_dir": os.path.join(root, "raw"),
        }
    registry["accounts"][account_id].update({
        "user": user, "host": host, "port": int(values["port"]),
        "visible": True,
        "ssl": bool(values.get("ssl", True)), "verify_ssl": bool(values.get("verify_ssl", True)),
        "smtp_host": str(values.get("smtp_host") or "").strip(),
        "smtp_port": int(values.get("smtp_port") or 465),
        "smtp_ssl": bool(values.get("smtp_ssl", True)),
        "smtp_starttls": bool(values.get("smtp_starttls", False)),
        "smtp_verify_ssl": bool(values.get("smtp_verify_ssl", values.get("verify_ssl", True))),
        "smtp_verified": bool(smtp_result.get("ok")),
    })
    registry["last_account"] = account_id
    _save_registry(registry)
    config.IMAP_HOST, config.IMAP_PORT = host, int(values["port"])
    config.IMAP_USER, config.IMAP_PASSWORD = user, values["password"]
    config.IMAP_SSL, config.IMAP_VERIFY_SSL = bool(values.get("ssl", True)), bool(values.get("verify_ssl", True))
    _activate_storage(registry["accounts"][account_id])
    with db.conn() as connection:
        has_local_mail = connection.execute("SELECT 1 FROM emails LIMIT 1").fetchone() is not None
    stored_securely = _save_account_password(account_id, values["password"])
    _persist({"IMAP_HOST": host, "IMAP_PORT": config.IMAP_PORT, "IMAP_USER": user,
              "IMAP_PASSWORD": "", "IMAP_SSL": config.IMAP_SSL,
              "IMAP_VERIFY_SSL": config.IMAP_VERIFY_SSL})
    config.SMTP_HOST = str(values.get("smtp_host") or "").strip()
    config.SMTP_PORT = int(values.get("smtp_port") or 465)
    config.SMTP_SSL = bool(values.get("smtp_ssl", True))
    config.SMTP_STARTTLS = bool(values.get("smtp_starttls", False))
    config.SMTP_VERIFY_SSL = bool(values.get("smtp_verify_ssl", values.get("verify_ssl", True)))
    config.SMTP_USER, config.SMTP_PASSWORD = "", ""
    config.SMTP_USE_IMAP_CREDENTIALS = True
    _persist({"SMTP_HOST": config.SMTP_HOST, "SMTP_PORT": config.SMTP_PORT,
              "SMTP_USER": "", "SMTP_PASSWORD": "", "SMTP_SSL": config.SMTP_SSL,
              "SMTP_STARTTLS": config.SMTP_STARTTLS, "SMTP_VERIFY_SSL": config.SMTP_VERIFY_SSL,
              "SMTP_USE_IMAP_CREDENTIALS": True, "SMTP_SENT_IMAP_HOST": host})
    db.add_audit_log(None, action="mail_account_login", actor="user", reason=f"登录邮箱 {user}")
    sync_job = db.get_sync_job()
    initialization_incomplete = bool(sync_job and sync_job.get("status") in
                                     ("running", "pending", "failed", "canceled"))
    return {**test_result, "smtp": smtp_result, "smtp_warning": smtp_warning,
            "account_id": account_id, "new_account": is_new_account,
            "credential_warning": "" if stored_securely else SESSION_CREDENTIAL_NOTICE,
            "initialization_needed": is_new_account or not has_local_mail or initialization_incomplete}


def update_mail_account(account_id: str, values: dict) -> dict:
    """更新已保存账号的连接信息，不改变当前正在使用的邮箱。"""
    registry = _load_registry()
    account = registry.get("accounts", {}).get(account_id)
    if not account:
        raise KeyError("账号不存在")
    host, user = values["host"].strip(), values["user"].strip()
    if _account_key(host, user) != account_id:
        raise ValueError("邮箱账号和 IMAP 服务器不可修改；如需更换，请新增邮箱")
    try:
        test_result = test_mail_connection(values)
    except Exception as exc:
        raise MailConnectionError("imap", exc) from exc
    try:
        smtp_result = smtp_client.test_connection(values)
    except Exception as exc:
        raise MailConnectionError("smtp", exc) from exc
    active = registry.get("last_account") == account_id and config.IMAP_USER.lower() == user.lower()
    stored_securely = _save_account_password(account_id, values["password"])
    account["credential_storage"] = "vault" if stored_securely else "session"
    account.update({
        "port": int(values["port"]), "ssl": bool(values.get("ssl", True)),
        "verify_ssl": bool(values.get("verify_ssl", True)),
        "smtp_host": str(values.get("smtp_host") or "").strip(),
        "smtp_port": int(values.get("smtp_port") or 465),
        "smtp_ssl": bool(values.get("smtp_ssl", True)),
        "smtp_starttls": bool(values.get("smtp_starttls", False)),
        "smtp_verify_ssl": bool(values.get("smtp_verify_ssl", values.get("verify_ssl", True))),
        "smtp_verified": bool(smtp_result.get("ok")),
    })
    _save_registry(registry)
    if active:
        config.IMAP_PORT = account["port"]
        config.IMAP_PASSWORD = values["password"]
        config.IMAP_SSL, config.IMAP_VERIFY_SSL = account["ssl"], account["verify_ssl"]
        config.SMTP_HOST, config.SMTP_PORT = account["smtp_host"], account["smtp_port"]
        config.SMTP_SSL, config.SMTP_STARTTLS = account["smtp_ssl"], account["smtp_starttls"]
        config.SMTP_VERIFY_SSL = account["smtp_verify_ssl"]
        _persist({"IMAP_PORT": config.IMAP_PORT, "IMAP_PASSWORD": "",
                  "IMAP_SSL": config.IMAP_SSL, "IMAP_VERIFY_SSL": config.IMAP_VERIFY_SSL,
                  "SMTP_HOST": config.SMTP_HOST, "SMTP_PORT": config.SMTP_PORT,
                  "SMTP_SSL": config.SMTP_SSL, "SMTP_STARTTLS": config.SMTP_STARTTLS,
                  "SMTP_VERIFY_SSL": config.SMTP_VERIFY_SSL})
    return {"ok": True, "account_id": account_id, "user": user,
            "imap": test_result, "smtp": smtp_result, "active_unchanged": active,
            "credential_warning": "" if stored_securely else SESSION_CREDENTIAL_NOTICE}


def switch_mail_account(account_id: str) -> dict:
    """使用系统凭据库中的授权码即时切换；网络校验交给随后的后台同步。"""
    registry = _load_registry()
    account = registry.get("accounts", {}).get(account_id)
    if not account:
        raise KeyError("账号不存在")
    password = account_password(account_id)
    if not password:
        raise RuntimeError("该账号的授权码不在系统凭据库中，请重新登录")
    fallback = discover(account.get("user", ""))
    values = {
        "host": account.get("host") or fallback["imap_host"],
        "port": int(account.get("port") or fallback["imap_port"]),
        "ssl": bool(account.get("ssl", fallback["imap_ssl"])),
        "verify_ssl": bool(account.get("verify_ssl", True)),
        "user": account.get("user", ""), "password": password,
        "smtp_host": account.get("smtp_host") or fallback["smtp_host"],
        "smtp_port": int(account.get("smtp_port") or fallback["smtp_port"]),
        "smtp_ssl": bool(account.get("smtp_ssl", fallback["smtp_ssl"])),
        "smtp_starttls": bool(account.get("smtp_starttls", fallback["smtp_starttls"])),
        "smtp_verify_ssl": bool(account.get("smtp_verify_ssl", True)),
    }
    config.IMAP_HOST, config.IMAP_PORT = values["host"], values["port"]
    config.IMAP_USER, config.IMAP_PASSWORD = values["user"], password
    config.IMAP_SSL, config.IMAP_VERIFY_SSL = values["ssl"], values["verify_ssl"]
    config.SMTP_HOST, config.SMTP_PORT = values["smtp_host"], values["smtp_port"]
    config.SMTP_SSL, config.SMTP_STARTTLS = values["smtp_ssl"], values["smtp_starttls"]
    config.SMTP_VERIFY_SSL, config.SMTP_USE_IMAP_CREDENTIALS = values["smtp_verify_ssl"], True
    registry["last_account"] = account_id
    _save_registry(registry)
    _activate_storage(account)
    _persist({"IMAP_HOST": config.IMAP_HOST, "IMAP_PORT": config.IMAP_PORT,
              "IMAP_USER": config.IMAP_USER, "IMAP_PASSWORD": "", "IMAP_SSL": config.IMAP_SSL,
              "IMAP_VERIFY_SSL": config.IMAP_VERIFY_SSL, "SMTP_HOST": config.SMTP_HOST,
              "SMTP_PORT": config.SMTP_PORT, "SMTP_SSL": config.SMTP_SSL,
              "SMTP_STARTTLS": config.SMTP_STARTTLS, "SMTP_VERIFY_SSL": config.SMTP_VERIFY_SSL,
              "SMTP_USE_IMAP_CREDENTIALS": True, "SMTP_SENT_IMAP_HOST": config.IMAP_HOST})
    db.add_audit_log(None, "mail_account_switch", actor="user", reason=f"切换邮箱 {config.IMAP_USER}")
    return {"ok": True, "account_id": account_id, "user": config.IMAP_USER}


def remember_mail_account(account_id: str) -> dict:
    """Persist UI account preference without changing in-flight account context."""
    registry = _load_registry()
    account = registry.get('accounts', {}).get(account_id)
    if not account or not account.get('visible', True):
        raise KeyError('账号不存在')
    if not account_password(account_id):
        raise RuntimeError('该邮箱需要重新登录')
    registry['last_account'] = account_id
    _save_registry(registry)
    return {'ok': True, 'account_id': account_id, 'user': account.get('user', '')}


def _remove_account_storage(account_id: str, account: dict):
    """删除一个账号的数据文件，并拒绝注册表中伪造的越界路径。"""
    account_root = os.path.realpath(os.path.join(ACCOUNTS_DIR, account_id))
    legacy_db = os.path.realpath(LEGACY_DB_PATH)
    legacy_raw = os.path.realpath(LEGACY_RAW_DIR)
    db_path = os.path.realpath(account.get("db_path") or "")
    raw_dir = os.path.realpath(account.get("raw_dir") or "")

    def inside_account_root(path: str) -> bool:
        try:
            return os.path.commonpath([path, account_root]) == account_root
        except ValueError:
            return False

    if not db_path or (db_path != legacy_db and not inside_account_root(db_path)):
        raise ValueError("账号数据库路径不安全，已停止清空")
    if not raw_dir or (raw_dir != legacy_raw and not inside_account_root(raw_dir)):
        raise ValueError("账号邮件目录路径不安全，已停止清空")

    for path in (db_path, db_path + "-wal", db_path + "-shm"):
        if os.path.lexists(path):
            os.remove(path)
    if os.path.islink(raw_dir):
        os.remove(raw_dir)
    elif os.path.isdir(raw_dir):
        shutil.rmtree(raw_dir)
    elif os.path.lexists(raw_dir):
        os.remove(raw_dir)

    # 新版账号目录清空后不留下空壳；旧版 data/raw 的父目录不能删除。
    if inside_account_root(db_path) and os.path.isdir(account_root) and not os.listdir(account_root):
        os.rmdir(account_root)


def logout_mail(clear_history: bool = False, account_id: str = "") -> dict:
    """退出当前邮箱并撤销本机授权码，可选清空该账号的隔离存储。"""
    registry = _load_registry()
    active_id = _account_key(config.IMAP_HOST, config.IMAP_USER) if config.IMAP_USER else ""
    target_id = account_id or active_id
    account = registry.get("accounts", {}).get(target_id)
    if not account:
        raise KeyError("账号不存在或已经退出")
    old_user = account.get("user", "")
    is_active = bool(active_id and target_id == active_id)

    # 只有当前激活的账号数据库适合写退出审计；已退出的保留记录可能并非当前存储。
    if is_active:
        db.add_audit_log(None, action="mail_account_logout", actor="user",
                         reason=f"退出邮箱 {old_user}", meta={"clear_history": bool(clear_history)})

    if clear_history:
        _remove_account_storage(target_id, account)
        registry["accounts"].pop(target_id, None)
    else:
        # 保留内部存储映射，重新登录同一邮箱时自动找回历史；不再显示为可切换账号。
        account["visible"] = False
    if registry.get("last_account") == target_id:
        registry["last_account"] = ""
    _save_registry(registry)
    _session_credentials.pop(target_id, None)
    credential_store.delete(target_id)

    if is_active:
        config.IMAP_USER = ""
        config.IMAP_PASSWORD = ""
        _persist({"IMAP_USER": "", "IMAP_PASSWORD": ""})
    return {"ok": True, "user": old_user, "history_cleared": bool(clear_history)}


def _model_profiles():
    try:
        return json.loads(Path(config.DATA_DIR, 'model_profiles.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def _model_fingerprint(resolved: dict) -> str:
    fields = {key: resolved.get(key) for key in (
        'provider', 'base_url', 'model', 'api_key', 'verify_ssl', 'extra_params')}
    payload = json.dumps(fields, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(payload.encode('utf-8')).hexdigest()


def _current_model_verified(profiles=None) -> bool:
    if not llm_client.available():
        return False
    try:
        resolved = _model_values({})
    except ValueError:
        return False
    profile = (profiles if profiles is not None else _model_profiles()).get(resolved['provider'], {})
    fingerprint = _model_fingerprint(resolved)
    status = profile.get('verification_status')
    if status == 'unverified':
        return False
    if status == 'verified' or profile.get('verified_fingerprint'):
        return profile.get('verified_fingerprint') == fingerprint
    # Compatibility: configurations created before verification tracking have no
    # marker at all. They were already in use, so upgrading/reinstalling must not
    # send those users through first-use setup again. New saves always add a marker.
    return True


def _remember_model(resolved):
    profiles = _model_profiles()
    provider = resolved['provider']
    if not credential_store.save('model-profile:' + provider, resolved['api_key']):
        raise ValueError('系统凭据库无法保存模型密钥，请检查系统凭据库后重试')
    fingerprint = _model_fingerprint(resolved)
    previous = profiles.get(provider, {})
    profile = {key: value for key, value in resolved.items() if key != 'api_key'}
    previous_is_legacy = bool(previous) and not {
        'verification_status', 'verified_fingerprint'
    }.intersection(previous)
    current_is_legacy = not previous and provider == config.LLM_PROVIDER
    if current_is_legacy:
        try:
            current_is_legacy = _model_fingerprint(_model_values({})) == fingerprint
        except ValueError:
            current_is_legacy = False
    if (fingerprint in _verified_model_fingerprints
            or previous.get('verified_fingerprint') == fingerprint
            or previous_is_legacy or current_is_legacy):
        profile['verification_status'] = 'verified'
        profile['verified_fingerprint'] = fingerprint
    else:
        profile['verification_status'] = 'unverified'
    profiles[provider] = profile
    os.makedirs(config.DATA_DIR, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=config.DATA_DIR, prefix='.model-profiles-')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(profiles, stream, ensure_ascii=False)
        os.replace(temporary, Path(config.DATA_DIR, 'model_profiles.json'))
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _model_values(values):
    base_url = values.get("base_url", config.LLM_BASE_URL).strip()
    model = values.get("model", config.LLM_MODEL).strip()
    endpoint = completion_url(base_url)
    if not model:
        raise ValueError("请填写模型名称")
    provider = values.get("provider", config.LLM_PROVIDER)
    if provider not in {p['id'] for p in PRESETS}:
        raise ValueError("请选择支持的服务商或自定义兼容服务")
    changed = endpoint != completion_url(config.LLM_BASE_URL) or provider != config.LLM_PROVIDER
    api_key = (values.get("api_key") or "").strip()
    if not api_key and provider in KEYLESS_PROVIDERS:
        # Ollama 等本地服务不校验密钥，用占位值复用现有保存/验证链路
        api_key = KEYLESS_PLACEHOLDER
    if not api_key:
        if changed:
            saved = _model_profiles().get(provider, {})
            if saved and completion_url(saved['base_url']) == endpoint:
                api_key = credential_store.load('model-profile:' + provider)
            if not api_key:
                raise ValueError("切换服务商或 API 地址后，请重新填写对应的 API Key")
        else:
            api_key = config.LLM_API_KEY
    if not api_key:
        raise ValueError("请填写 API Key")
    extra = values.get("extra_params")
    if extra is None:
        extra = {} if changed else config.LLM_EXTRA_PARAMS
    return dict(base_url=base_url, model=model, api_key=api_key, provider=provider,
                extra_params=validate_extra(extra), verify_ssl=bool(values.get("verify_ssl", config.LLM_VERIFY_SSL)),
                multimodal_enabled=bool(values.get("multimodal_enabled", config.MULTIMODAL_ENABLED)),
                multimodal_model=(values.get("multimodal_model") or "").strip() or model)


def save_model(values: dict):
    if set(values) == {'provider'}:
        saved = _model_profiles().get(values['provider'])
        if not saved:
            raise ValueError('此服务商尚未保存配置')
        values = dict(saved)
    resolved = _model_values(values)
    # Preserve the previously active configuration before replacing it.
    if config.LLM_API_KEY and config.LLM_PROVIDER != resolved['provider']:
        _remember_model(_model_values({}))
    _remember_model(resolved)
    updates = {"LLM_BASE_URL": resolved['base_url'], "LLM_MODEL": resolved['model'],
               "LLM_PROVIDER": resolved['provider'], "LLM_API_KEY": resolved['api_key'],
               "LLM_VERIFY_SSL": resolved['verify_ssl'], "MULTIMODAL_MODEL": resolved['multimodal_model'],
               "MULTIMODAL_ENABLED": resolved['multimodal_enabled'],
               "LLM_EXTRA_PARAMS": json.dumps(resolved['extra_params'], ensure_ascii=False)}
    _persist(updates)
    for key, value in updates.items():
        setattr(config, key, resolved['extra_params'] if key == 'LLM_EXTRA_PARAMS' else value)
    db.add_audit_log(None, action="model_config_change", actor="user",
                     reason=f"更新模型连接：{config.LLM_MODEL}",
                     meta={"base_url": config.LLM_BASE_URL, "model": config.LLM_MODEL})


def test_model(values: dict | None = None) -> dict:
    """Test text and, when requested, vision input without persisting the draft."""
    try:
        resolved = _model_values(values or {})
        multimodal_enabled = resolved.pop('multimodal_enabled')
        multimodal_model = resolved.pop('multimodal_model')
        result = llm_client.chat_completion(
            [{"role": "user", "content": "只回复 OK"}], temperature=0, max_tokens=1024, timeout=30,
            raise_errors=True, **resolved)
        choices = result.get('choices') if isinstance(result, dict) else None
        choice = choices[0] if isinstance(choices, list) and choices and isinstance(choices[0], dict) else {}
        message = choice.get('message')
        content = message.get('content') if isinstance(message, dict) else None
        if not isinstance(content, str) or not content.strip() or choice.get('finish_reason') == 'length':
            return {"ok": False, "message": "接口未返回完整文本，请检查模型名称、参数或推理长度限制"}
        _verified_model_fingerprints.add(_model_fingerprint(_model_values(values or {})))
        if not multimodal_enabled:
            return {"ok": True, "message": "文本连接成功：" + content[:80],
                    "multimodal": {"checked": False, "supported": False}}

        # A model-list endpoint rarely gives portable, trustworthy capability metadata.
        # Probe the exact configured model with a tiny synthetic PNG instead. It is
        # deliberately small, contains no user data, and works with OpenAI-compatible APIs.
        # Note: some gateways (e.g. Kimi Code) reject 1×1 probe pixels as "unsupported
        # image format", so the probe is a real 96×96 drawing; and reasoning models may
        # spend a few hundred tokens before the visible reply, so max_tokens stays high.
        vision_request = [{"role": "user", "content": [
            {"type": "text", "text": "请确认你收到了一张测试图片，只回复 OK。"},
            {"type": "image_url", "image_url": {"url": (
                "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAABLklEQVR42u3b0Q0BQRQFUDtRhKYkavCpAiWowKcaJJrySaIABSCZnZ2RfTvnfgovnNxnkzWGx+u5kt9JCAABAgQIECBAgAQQoPpZ5zxpez7+7Q3dDicNsmKAAAkgQIAAAQIECBAgAQQIECBAgAABEkCAAAECBAgQIAEECBAgQIDiZ/B/MQ0CBGg183PSM8/9uv98cLO79P4l/dWlulRIoEyaKkypB53iVwVrUPGHnFKl1JVOwRyX+UUA1apPwbTUm87YmVYsOFCL+oyarEGAFgzUbr/y52sQIECAAAEC1CS17itPma9BgJYN1G7LMidrUHygFiXKnxmjQXWNRk2zYksBqlWisXPi/fRcfJOojDjeipV9zuICOt3RwRlF54NcxQABAgRIAAECBAhQtLwBOSlWOS7d9dMAAAAASUVORK5CYII="
            )}},
        ]}]
        try:
            visual_result = llm_client.chat_completion(
                vision_request, temperature=0, max_tokens=512, timeout=30,
                raise_errors=True, **{**resolved, "model": multimodal_model})
            visual_choices = visual_result.get('choices') if isinstance(visual_result, dict) else None
            visual_choice = (visual_choices or [{}])[0] if isinstance(visual_choices, list) else {}
            visual_content = (visual_choice.get('message') or {}).get('content') if isinstance(visual_choice, dict) else None
            if not isinstance(visual_content, str) or not visual_content.strip() or visual_choice.get('finish_reason') == 'length':
                raise RuntimeError('图片测试未返回完整结果')
        except (ValueError, RuntimeError) as visual_exc:
            return {"ok": True,
                    "message": "文本连接成功，但图片识别不可用：" + str(visual_exc),
                    "multimodal": {"checked": True, "supported": False,
                                   "model": multimodal_model,
                                   "message": "请关闭图片识别，或填写支持图片输入的多模态模型后重新测试。"}}
        return {"ok": True, "message": "文本与图片识别连接均成功：" + content[:80],
                "multimodal": {"checked": True, "supported": True, "model": multimodal_model}}
    except (ValueError, RuntimeError) as exc:
        return {"ok": False, "message": str(exc)}


def diagnostics(lang: str = "zh") -> dict:
    """Run real local and remote probes without returning credentials or mail content."""
    # 诊断名称与说明是后端固有文案；前端按当前界面语言传 lang，英文界面不落中文。
    en = lang == "en"
    def t(zh: str, en_text: str) -> str:
        return en_text if en else zh

    checks = []
    def add(name: str, status: str, detail: str, *, probe: str = "local",
            issue: str = "", check_id: str = ""):
        # check_id 是不随语言变化的稳定标识，前端据此给出修复指引
        checks.append({"id": check_id, "name": name, "status": status, "ok": status == "pass",
                       "detail": detail, "probe": probe, "issue": issue})

    try:
        with _sqlite_connection(config.DB_PATH) as connection:
            integrity = connection.execute("PRAGMA quick_check").fetchone()[0]
        add(t("本地数据库", "Local database"), "pass" if integrity == "ok" else "fail",
            t("结构与索引校验通过", "Structure and index check passed") if integrity == "ok"
            else t("数据库校验异常", "Database integrity check failed"), check_id="db")
    except (OSError, sqlite3.Error):
        add(t("本地数据库", "Local database"), "fail", t("数据库无法打开或校验", "Database cannot be opened or verified"), check_id="db")

    registry = _load_registry()
    visible_accounts = [item for item in registry.get("accounts", {}).values()
                        if item.get("visible", True)]
    db_paths = [os.path.realpath(item.get("db_path") or "") for item in visible_accounts]
    account_id = _account_key(config.IMAP_HOST, config.IMAP_USER) if config.IMAP_USER else ""
    account = registry.get("accounts", {}).get(account_id, {})
    isolated = bool(account and os.path.realpath(account.get("db_path") or "") == os.path.realpath(config.DB_PATH)
                    and len(db_paths) == len(set(db_paths)))
    add(t("账号隔离", "Account isolation"), "pass" if isolated else "fail",
        t("当前邮箱使用独立数据库", "This mailbox uses its own database") if isolated
        else t("账号数据库映射异常，请重新打开软件", "Account database mapping is broken; restart the app"),
        check_id="isolation")

    password = account_password(account_id) if account_id else ""
    in_vault = bool(password) and account.get("credential_storage") != "session"
    add(t("系统凭据库", "System credential vault"), "pass" if in_vault else "warning" if password else "fail",
        t("授权码已持久保存在系统凭据库", "Password is stored persistently in the system credential vault") if in_vault else
        t("授权码仅在本次运行中有效", "Password is only valid for this session") if password
        else t("没有可用授权码", "No password available"),
        issue="credential_session" if password and not in_vault else "credential_missing" if not password else "",
        check_id="vault")

    def friendly_failure(kind: str, exc: Exception) -> tuple[str, str]:
        message = str(exc).lower()
        if any(word in message for word in ("auth", "login", "credential", "password", "535", "401", "403")):
            return t(f"{kind}认证失败，请核对授权码或 API Key",
                     f"{kind} authentication failed; check the password or API key"), "authentication"
        if any(word in message for word in ("certificate", "ssl", "tls")):
            return t(f"{kind}证书校验失败", f"{kind} certificate verification failed"), "certificate"
        if isinstance(exc, TimeoutError) or any(word in message for word in ("timeout", "timed out")):
            return t(f"{kind}连接超时", f"{kind} connection timed out"), "timeout"
        if any(word in message for word in ("gaierror", "name or service not known", "nodename nor servname", "getaddrinfo")):
            return t(f"{kind}服务器地址无法解析", f"{kind} server address cannot be resolved"), "dns"
        if "refused" in message:
            return t(f"{kind}服务器拒绝连接", f"{kind} server refused the connection"), "refused"
        return t(f"{kind}连接失败，请检查地址、网络和服务状态",
                 f"{kind} connection failed; check the address, network and service"), "connection"

    probes = {}
    if config.IMAP_USER and password:
        mail_values = {"host": config.IMAP_HOST, "port": config.IMAP_PORT,
                       "user": config.IMAP_USER, "password": password,
                       "ssl": config.IMAP_SSL, "verify_ssl": config.IMAP_VERIFY_SSL}
        probes[t("邮箱收信", "Mailbox receiving")] = ("IMAP", lambda: test_mail_connection(mail_values))
    else:
        add(t("邮箱收信", "Mailbox receiving"), "fail", t("尚未登录或授权码不可用", "Not signed in or password unavailable"), probe="live", issue="credential_missing", check_id="imap")

    smtp_password = password if config.SMTP_USE_IMAP_CREDENTIALS else config.SMTP_PASSWORD
    smtp_user = config.IMAP_USER if config.SMTP_USE_IMAP_CREDENTIALS else config.SMTP_USER
    if config.SMTP_HOST and smtp_user and smtp_password:
        smtp_values = {"smtp_host": config.SMTP_HOST, "smtp_port": config.SMTP_PORT,
                       "smtp_user": smtp_user, "password": smtp_password,
                       "smtp_ssl": config.SMTP_SSL, "smtp_starttls": config.SMTP_STARTTLS,
                       "smtp_verify_ssl": config.SMTP_VERIFY_SSL}
        probes[t("SMTP 发信", "SMTP sending")] = ("SMTP", lambda: smtp_client.test_connection(smtp_values))
    else:
        add(t("SMTP 发信", "SMTP sending"), "fail", t("尚未配置完整的 SMTP 地址和凭据", "SMTP address and credentials are not fully configured"), probe="live", issue="configuration", check_id="smtp")

    if llm_client.available():
        probes[t("AI 模型", "AI model")] = (t("模型", "Model"), lambda: test_model({}))
    else:
        add(t("AI 模型", "AI model"), "fail", t("尚未配置 API Key", "No API key configured"), probe="live", issue="configuration", check_id="model")

    live_results = {}
    started = time.monotonic()
    with ThreadPoolExecutor(max_workers=3, thread_name_prefix="diagnostic") as executor:
        futures = {executor.submit(callback): (name, kind)
                   for name, (kind, callback) in probes.items()}
        for future in as_completed(futures):
            name, kind = futures[future]
            try:
                result = future.result()
                if name == t("邮箱收信", "Mailbox receiving"):
                    live_results[name] = ("pass", t(f"实测登录成功，可读取 {result.get('folders', 0)} 个文件夹",
                                                    f"Signed in successfully; {result.get('folders', 0)} folders readable"), "")
                elif name == t("SMTP 发信", "SMTP sending"):
                    live_results[name] = ("pass", t("实测认证成功（未发送邮件）", "Authentication succeeded (no mail sent)"), "")
                elif result.get("ok"):
                    live_results[name] = ("pass", t(f"实测请求成功 · {config.LLM_MODEL}",
                                                    f"Live request succeeded · {config.LLM_MODEL}"), "")
                else:
                    detail = str(result.get("message") or t("接口未返回有效结果", "API returned no usable result"))
                    _, issue = friendly_failure(kind, RuntimeError(detail))
                    live_results[name] = ("fail", t("实测失败：", "Live check failed: ") + detail, issue)
            except Exception as exc:
                detail, issue = friendly_failure(kind, exc)
                live_results[name] = ("fail", detail, issue)
    live_ids = {t("邮箱收信", "Mailbox receiving"): "imap", t("SMTP 发信", "SMTP sending"): "smtp",
                t("AI 模型", "AI model"): "model"}
    for name in live_ids:
        if name in live_results:
            status, detail, issue = live_results[name]
            add(name, status, detail, probe="live", issue=issue, check_id=live_ids[name])

    job = db.get_sync_job()
    if job:
        job_status = job.get("status")
        status = "pass" if job_status == "completed" else "warning" if job_status in ("running", "pending") else "fail"
        labels = {"completed": t("已完成", "Completed"), "running": t("进行中", "Running"),
                  "pending": t("等待中", "Pending"), "failed": t("失败", "Failed"),
                  "canceled": t("已暂停", "Paused")}
        add(t("历史邮件初始化", "Initial mail import"), status,
            f"{labels.get(job_status, job_status or t('未知', 'Unknown'))} · {job.get('processed', 0)}/{job.get('total', 0)}",
            check_id="init")
    else:
        add(t("历史邮件初始化", "Initial mail import"), "warning", t("尚未启动", "Not started"), check_id="init")
    return {"ok": not any(item["status"] == "fail" for item in checks), "checks": checks,
            "data_dir": os.path.basename(config.DATA_DIR),
            "duration_ms": round((time.monotonic() - started) * 1000),
            "checked_at": datetime.now().isoformat(timespec="seconds")}


def create_backup(include_raw: bool = True) -> dict:
    """备份当前账号数据库和原始邮件，不包含授权码与模型密钥。"""
    backup_dir = os.path.join(config.DATA_DIR, "backups")
    os.makedirs(backup_dir, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    account_id = _account_key(config.IMAP_HOST, config.IMAP_USER) if config.IMAP_USER else "local"
    filename = f"MailAI-{account_id}-{stamp}.zip"
    target = os.path.join(backup_dir, filename)
    partial = target + ".part"
    try:
        with tempfile.TemporaryDirectory() as temp_dir:
            db_copy = os.path.join(temp_dir, "mailai.db")
            with _sqlite_connection(config.DB_PATH) as source, _sqlite_connection(db_copy) as destination:
                source.backup(destination)
            # Portable paths belong only to the snapshot, never the live database.
            with _sqlite_connection(db_copy) as snapshot:
                for email_id, raw_path in snapshot.execute("SELECT id,raw_path FROM emails WHERE raw_path IS NOT NULL").fetchall():
                    relative = os.path.relpath(raw_path, config.RAW_DIR).replace(os.sep, "/")
                    if relative == ".." or relative.startswith("../"):
                        raise ValueError("邮件原文位于当前账号目录之外，无法创建可迁移备份")
                    snapshot.execute("UPDATE emails SET raw_path=? WHERE id=?", (relative, email_id))
            manifest = {
                "version": 2, "created_at": datetime.now().isoformat(timespec="seconds"),
                "account": config.IMAP_USER, "imap_host": config.IMAP_HOST,
                "includes_raw_mail": include_raw,
            }
            with zipfile.ZipFile(partial, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.write(db_copy, "mailai.db")
                archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
                if include_raw and os.path.isdir(config.RAW_DIR):
                    for root, _, files in os.walk(config.RAW_DIR):
                        for name in files:
                            path = os.path.join(root, name)
                            if os.path.islink(path):
                                raise ValueError("原始邮件目录包含符号链接，备份已停止")
                            archive.write(path, os.path.join("raw", os.path.relpath(path, config.RAW_DIR)))
            os.chmod(partial, stat.S_IRUSR | stat.S_IWUSR)
            os.replace(partial, target)
    finally:
        try:
            os.unlink(partial)
        except FileNotFoundError:
            pass
    size = os.path.getsize(target)
    db.add_audit_log(None, "local_backup", actor="user", reason=f"创建本地备份 {filename}", meta={"size": size})
    return {"ok": True, "filename": filename, "size": size, "created_at": manifest["created_at"]}


def list_backups() -> list[dict]:
    backup_dir = os.path.join(config.DATA_DIR, "backups")
    if not os.path.isdir(backup_dir):
        return []
    account_id = _account_key(config.IMAP_HOST, config.IMAP_USER) if config.IMAP_USER else "local"
    prefix = f"MailAI-{account_id}-"
    result = []
    for name in sorted(os.listdir(backup_dir), reverse=True):
        path = os.path.join(backup_dir, name)
        if name.startswith(prefix) and name.endswith(".zip") and os.path.isfile(path):
            result.append({"filename": name, "size": os.path.getsize(path),
                           "created_at": datetime.fromtimestamp(os.path.getmtime(path)).isoformat(timespec="seconds")})
    return result[:30]


def backup_path(filename: str) -> str:
    account_id = _account_key(config.IMAP_HOST, config.IMAP_USER) if config.IMAP_USER else "local"
    prefix = f"MailAI-{account_id}-"
    if filename != os.path.basename(filename) or not filename.startswith(prefix) or not filename.endswith(".zip"):
        raise ValueError("备份文件名无效")
    path = os.path.join(config.DATA_DIR, "backups", filename)
    if not os.path.isfile(path):
        raise FileNotFoundError(filename)
    return path


def delete_backup(filename: str) -> dict:
    """Delete one validated backup belonging to the active account."""
    path = backup_path(filename)
    size = os.path.getsize(path)
    os.unlink(path)
    db.add_audit_log(None, "local_backup_delete", actor="user",
                     reason=f"删除本地备份 {filename}", meta={"size": size})
    return {"ok": True, "filename": filename, "deleted_size": size}


def _copy_database(source_path: str, target_path: str):
    """SQLite online copy kept as a seam for failure/rollback verification."""
    with _sqlite_connection(source_path) as source, _sqlite_connection(target_path) as destination:
        source.backup(destination)


def _freeze_restored_side_effects(snapshot_path: str):
    """Make a full snapshot inert before it can ever become the live database."""
    with _sqlite_connection(snapshot_path) as connection:
        tables = {row[0] for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )}
        if 'outbox' in tables:
            connection.execute(
                "UPDATE outbox SET status='unknown',"
                "error='记录来自恢复的备份，请核对实际发送结果后处理' "
                "WHERE status IN ('queued','sending')"
            )
        if 'seen_sync_jobs' in tables:
            connection.execute("DELETE FROM seen_sync_jobs")
        if 'emails' in tables:
            columns = {row[1] for row in connection.execute('PRAGMA table_info(emails)')}
            assignments = []
            for name, value in (
                ('pending_action', "''"), ('pending_target', "''"),
                ('pending_target_uid', 'NULL'), ('pending_due_at', 'NULL'),
                ('pending_attempts', '0'), ('pending_error', "''"),
            ):
                if name in columns:
                    assignments.append(f'{name}={value}')
            if assignments:
                connection.execute('UPDATE emails SET ' + ','.join(assignments))


def _stage_range_restore(snapshot_path, staged_raw, temp_dir, start_date, end_date):
    """Merge selected messages into a copy of live data; never replace unrelated rows."""
    merged_db = os.path.join(temp_dir, 'merged.db')
    _copy_database(config.DB_PATH, merged_db)
    merged_raw = os.path.join(temp_dir, 'merged-raw')
    if os.path.isdir(config.RAW_DIR):
        shutil.copytree(config.RAW_DIR, merged_raw)
    else:
        os.makedirs(merged_raw)
    namespace = 'restored-' + os.path.basename(temp_dir)
    restored = 0
    with _sqlite_connection(snapshot_path) as source, _sqlite_connection(merged_db) as target:
        source.row_factory = sqlite3.Row
        target.row_factory = sqlite3.Row
        columns = {row[1] for row in target.execute('PRAGMA table_info(emails)')}
        with closing(source.execute("SELECT * FROM emails WHERE substr(COALESCE(NULLIF(date,''),created_at),1,10) BETWEEN ? AND ?", (start_date, end_date))) as rows:
            for row in rows:
                values = {key: row[key] for key in row.keys() if key in columns and key != 'id'}
                existing = target.execute('SELECT * FROM emails WHERE folder=? AND uid=?', (row['folder'], row['uid'])).fetchone()
                if existing and (existing['message_id'] or '') != (row['message_id'] or ''):
                    raise ValueError('备份邮件与当前邮件的服务器编号冲突，未恢复任何邮件')
                # A current row outside the selected dates must remain untouched.
                if existing and not start_date <= (existing['date'] or existing['created_at'] or '')[:10] <= end_date:
                    raise ValueError('备份邮件与范围外现有邮件冲突，未恢复任何邮件')
                raw_path = values.get('raw_path')
                if raw_path:
                    relative = os.path.relpath(raw_path, config.RAW_DIR)
                    if relative == '..' or relative.startswith('../') or os.path.isabs(relative):
                        raise ValueError('备份原文路径无效')
                    source_raw = os.path.join(staged_raw, relative)
                    if os.path.isfile(source_raw):
                        relative = os.path.join(namespace, str(row['id']) + '.eml')
                        output = os.path.join(merged_raw, relative)
                        os.makedirs(os.path.dirname(output), exist_ok=True)
                        shutil.copy2(source_raw, output)
                        values['raw_path'] = os.path.join(config.RAW_DIR, relative)
                    elif existing and existing['raw_path'] and os.path.isfile(existing['raw_path']):
                        values['raw_path'] = existing['raw_path']
                    else:
                        values['raw_path'] = None
                # Restoring mail must never requeue remote mutations or send operations.
                for key in list(values):
                    if key.startswith('pending_'):
                        values[key] = 0 if key == 'pending_attempts' else None if key in ('pending_due_at', 'pending_target_uid') else ''
                if 'sender_profile_id' in values:
                    values['sender_profile_id'] = existing['sender_profile_id'] if existing else None
                values['remote_missing'] = 0
                if existing:
                    target.execute('UPDATE emails SET ' + ','.join('"'+key+'"=?' for key in values) + ' WHERE id=?', [*values.values(), existing['id']])
                    target.execute('DELETE FROM seen_sync_jobs WHERE email_id=?', (existing['id'],))
                else:
                    target.execute('INSERT INTO emails (' + ','.join('"'+key+'"' for key in values) + ') VALUES (' + ','.join('?' for _ in values) + ')', list(values.values()))
                restored += 1
    if not restored:
        raise ValueError('备份中没有所选日期范围内的邮件')
    return merged_db, merged_raw, restored


def restore_backup(filename: str, *, start_date: str = "", end_date: str = "") -> dict:
    """校验并恢复当前账号备份；恢复前自动创建安全快照。"""
    ranged = bool(start_date or end_date)
    if ranged:
        try:
            if (datetime.strptime(start_date, '%Y-%m-%d').strftime('%Y-%m-%d') != start_date
                    or datetime.strptime(end_date, '%Y-%m-%d').strftime('%Y-%m-%d') != end_date
                    or start_date > end_date):
                raise ValueError()
        except (ValueError, TypeError):
            raise ValueError('请选择有效的开始和结束日期，开始日期不能晚于结束日期')
    restored_count = None
    source_path = backup_path(filename)
    # Stage on the same filesystem as RAW_DIR so directory replacement is atomic.
    raw_parent = os.path.dirname(os.path.abspath(config.RAW_DIR))
    os.makedirs(raw_parent, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".mailai-restore-", dir=raw_parent) as temp_dir:
        with zipfile.ZipFile(source_path) as archive:
            names = set(archive.namelist())
            if "mailai.db" not in names or "manifest.json" not in names:
                raise ValueError("备份内容不完整")
            manifest = json.loads(archive.read("manifest.json"))
            if manifest.get("version") not in (1, 2):
                raise ValueError("不支持的备份版本")
            if (manifest.get("account") or "").lower() != (config.IMAP_USER or "").lower():
                raise ValueError("该备份不属于当前邮箱账号")
            if (manifest.get("imap_host") or "").lower() != (config.IMAP_HOST or "").lower():
                raise ValueError("该备份的收件服务器与当前账号不一致")
            db_restore = os.path.join(temp_dir, "mailai.db")
            with open(db_restore, "wb") as output:
                output.write(archive.read("mailai.db"))
            with _sqlite_connection(db_restore) as connection:
                integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
            if integrity != "ok":
                raise ValueError(f"备份数据库校验失败：{integrity}")
            raw_members = [name for name in names if name.startswith("raw/") and not name.endswith("/")]
            for name in raw_members:
                relative = os.path.normpath(name[4:])
                if (relative.startswith("..") or os.path.isabs(relative) or "\\" in name
                        or ":" in name or ".." in name.split("/")
                        or stat.S_ISLNK(archive.getinfo(name).external_attr >> 16)):
                    raise ValueError("备份中包含不安全的文件路径")
                destination = os.path.realpath(os.path.join(config.RAW_DIR, relative))
                if os.path.commonpath([destination, os.path.realpath(config.RAW_DIR)]) != os.path.realpath(config.RAW_DIR):
                    raise ValueError("恢复目标包含越界符号链接")
            if manifest.get("version") == 2:
                with _sqlite_connection(db_restore) as connection:
                    for email_id, relative in connection.execute("SELECT id,raw_path FROM emails WHERE raw_path IS NOT NULL").fetchall():
                        if (not relative or relative.startswith("/") or "\\" in relative or ":" in relative
                                or ".." in relative.split("/")):
                            raise ValueError("备份数据库包含不安全的原文路径")
                        if manifest.get("includes_raw_mail") and "raw/" + relative not in names:
                            raise ValueError("备份缺少邮件原文，恢复已停止")
                        connection.execute("UPDATE emails SET raw_path=? WHERE id=?",
                                           (os.path.join(config.RAW_DIR, *relative.split("/")), email_id))
        # Extract every raw message before touching live state. A full-raw v2
        # backup replaces the directory as one unit, so interrupted restores
        # cannot leave a database pointing at a half-written mail tree.
        staged_raw = os.path.join(temp_dir, "staged-raw")
        full_raw = manifest.get("version") == 2 and manifest.get("includes_raw_mail")
        if full_raw or raw_members:
            os.makedirs(staged_raw, exist_ok=True)
            if not full_raw and os.path.exists(config.RAW_DIR):
                shutil.copytree(config.RAW_DIR, staged_raw, dirs_exist_ok=True)
        if raw_members:
            with zipfile.ZipFile(source_path) as archive:
                for name in raw_members:
                    relative = os.path.normpath(name[4:])
                    destination = os.path.join(staged_raw, relative)
                    os.makedirs(os.path.dirname(destination), exist_ok=True)
                    with archive.open(name) as src, open(destination, "wb") as dst:
                        shutil.copyfileobj(src, dst)
        if ranged:
            if manifest.get('version') != 2:
                raise ValueError('旧版备份仅支持完整恢复，请使用新版备份进行范围恢复')
            db_restore, staged_raw, restored_count = _stage_range_restore(
                db_restore, staged_raw, temp_dir, start_date, end_date)
            full_raw = True
        else:
            # This happens while the database is still staged. A process death
            # after installation therefore cannot replay restored remote work.
            _freeze_restored_side_effects(db_restore)
        safety = create_backup(include_raw=True)
        os.makedirs(os.path.dirname(config.DB_PATH), exist_ok=True)
        rollback_db = os.path.join(temp_dir, "rollback.db")
        _copy_database(config.DB_PATH, rollback_db)
        rollback_raw = os.path.join(temp_dir, "rollback-raw")
        raw_moved = False
        raw_swapped = False
        try:
            if full_raw or raw_members:
                if os.path.exists(config.RAW_DIR):
                    os.replace(config.RAW_DIR, rollback_raw)
                    raw_moved = True
                os.replace(staged_raw, config.RAW_DIR)
                raw_swapped = True
            _copy_database(db_restore, config.DB_PATH)
        except BaseException:
            if raw_swapped or raw_moved:
                if os.path.exists(config.RAW_DIR):
                    shutil.rmtree(config.RAW_DIR)
                if raw_moved:
                    os.replace(rollback_raw, config.RAW_DIR)
            _copy_database(rollback_db, config.DB_PATH)
            raise
        else:
            if os.path.exists(rollback_raw):
                shutil.rmtree(rollback_raw)
    db.init_db()
    db.add_audit_log(None, "local_backup_restore", actor="user", reason=f"恢复备份 {filename}",
                     meta={"safety_backup": safety["filename"]})
    return {"ok": True, "filename": filename, "safety_backup": safety["filename"], "restored_count": restored_count, "mode": "range" if ranged else "full"}
