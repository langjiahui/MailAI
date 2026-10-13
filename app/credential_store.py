"""使用操作系统凭据库保存邮箱授权码；不可用时由调用方保留兼容配置。"""
import logging
import platform
import subprocess
import threading
from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps

log = logging.getLogger(__name__)
SERVICE = "MailAI"

# Process memory only: never persist or log this cache. Empty results (including
# denied/canceled access) are cached too, so background requests do not keep
# reopening the OS authorization dialog. Explicit saves refresh the entry;
# restarting the app starts a fresh authorization session.
_session_cache: dict[str, str] = {}
_vault_lock = threading.RLock()
_interactive = ContextVar('credential_prompt_allowed', default=False)
_quiet_unavailable: set[str] = set()
_authorization_required: set[str] = set()
_master_blocked: set[str] = set()


@contextmanager
def prompt_policy(allowed: bool):
    """Only explicit actions/current-account restoration may show OS dialogs."""
    token = _interactive.set(allowed)
    try:
        yield
    finally:
        _interactive.reset(token)


def quiet(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        with prompt_policy(False):
            return function(*args, **kwargs)
    return wrapped


def authorization_required(account_key: str) -> bool:
    with _vault_lock:
        return account_key in _authorization_required


def is_migrated(account_key: str) -> bool:
    if platform.system()!='Darwin':
        return False
    from . import macos_credential_vault
    return macos_credential_vault.contains(account_key)


def _keyring():
    try:
        import keyring
        return keyring
    except Exception:
        return None


def available() -> bool:
    return _keyring() is not None or platform.system() == "Darwin"


def save(account_key: str, secret: str) -> bool:
    if not account_key or not secret:
        return False
    with _vault_lock:
        _quiet_unavailable.discard(account_key)
        _authorization_required.discard(account_key)
        _master_blocked.discard(account_key)
        # Never serve an older cached credential after a failed replacement.
        _session_cache[account_key] = ""
        saved = _save_to_vault(account_key, secret)
        if saved:
            _session_cache[account_key] = secret
        return saved


def load(account_key: str) -> str:
    if not account_key:
        return ""
    with _vault_lock:
        if account_key in _master_blocked and platform.system()=='Darwin':
            from . import macos_credential_vault
            if macos_credential_vault.unlocked():
                _session_cache.pop(account_key,None)
                _quiet_unavailable.discard(account_key)
                _master_blocked.discard(account_key)
        if account_key not in _session_cache:
            if platform.system() == 'Darwin':
                return _load_macos(account_key)
            _session_cache[account_key] = _load_from_vault(account_key)
        return _session_cache[account_key]


def _load_macos(account_key: str) -> str:
    interactive = _interactive.get()
    from . import macos_keychain, macos_credential_vault
    try:
        status,value=macos_credential_vault.get(account_key,interactive=interactive)
        if status in macos_keychain.AUTH_REQUIRED:
            _master_blocked.add(account_key)
        if status==macos_keychain.NOT_FOUND:
            if not interactive and account_key in _quiet_unavailable:
                return ''
            status,value=macos_keychain.read(SERVICE,account_key,interactive=interactive)
            if status==0 and value:
                # Adopt only data the OS already authorized. A quiet master-key
                # creation/read must not add another migration authorization.
                if not macos_credential_vault.put(account_key,value,interactive=False):
                    log.warning('Credential migration deferred; legacy item retained')
    except Exception as exc:
        # Do not fall back to an interactive CLI if the quiet native read fails.
        log.warning('macOS Keychain 读取失败 (%s)', type(exc).__name__)
        status, value = -1, ''
    if status == 0:
        _session_cache[account_key] = value
        _quiet_unavailable.discard(account_key)
        _authorization_required.discard(account_key)
        _master_blocked.discard(account_key)
        return value
    _quiet_unavailable.add(account_key)
    if status in macos_keychain.AUTH_REQUIRED:
        _authorization_required.add(account_key)
    if interactive or status == macos_keychain.NOT_FOUND:
        # A real cancellation is remembered; quiet authorization failures must
        # remain retryable by the next explicit account selection.
        _session_cache[account_key] = ''
        if interactive:
            _authorization_required.discard(account_key)
    return ''


def delete(account_key: str):
    if not account_key:
        return
    with _vault_lock:
        _quiet_unavailable.discard(account_key)
        _authorization_required.discard(account_key)
        _master_blocked.discard(account_key)
        # Even if deletion fails, this process must not revive a logged-out
        # credential from its cache or automatically retry vault access.
        _session_cache[account_key] = ""
        _delete_from_vault(account_key)


def _save_to_vault(account_key: str, secret: str) -> bool:
    if platform.system()=='Darwin':
        from . import macos_credential_vault
        try:
            return macos_credential_vault.put(account_key,secret,interactive=_interactive.get())
        except Exception as exc:
            log.warning('Encrypted credential vault write failed (%s)',type(exc).__name__)
            return False
    keyring = _keyring()
    if not account_key or not secret:
        return False
    if not keyring:
        return False
    try:
        keyring.set_password(SERVICE, account_key, secret)
        return True
    except Exception as exc:
        log.warning("系统凭据库写入失败 (%s)", type(exc).__name__)
        return False


def _load_from_vault(account_key: str) -> str:
    keyring = _keyring()
    if not account_key:
        return ""
    if not keyring:
        return ""
    try:
        return keyring.get_password(SERVICE, account_key) or ""
    except Exception as exc:
        log.warning("系统凭据库读取失败 (%s)", type(exc).__name__)
        return ""


def _delete_from_vault(account_key: str):
    if platform.system()=='Darwin':
        from . import macos_credential_vault, macos_keychain
        try:
            removed=macos_credential_vault.remove(account_key,interactive=_interactive.get())
            if not removed:
                log.warning('Encrypted credential removal deferred; vault requires unlock')
            # Best-effort old-item cleanup is quiet. The encrypted tombstone
            # prevents migration from reviving a deleted account after restart.
            macos_keychain.delete(SERVICE,account_key,interactive=False)
        except Exception as exc:
            log.warning('Credential removal failed (%s)',type(exc).__name__)
        return
    keyring = _keyring()
    if not account_key:
        return
    if not keyring:
        return
    try:
        keyring.delete_password(SERVICE, account_key)
    except Exception:
        pass
