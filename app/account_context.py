"""Immutable account snapshots for requests and background jobs.

Legacy configuration remains the desktop's default identity. Scoped work reads
its own snapshot through config, without changing that default or the registry.
"""
from contextlib import contextmanager
from contextvars import ContextVar
import threading

current = ContextVar('mailai_account', default=None)
_jobs = {}
_lock = threading.Lock()


def snapshot(account_id):
    from . import config, credential_store, system_settings as settings
    registry = settings._load_registry()
    account = registry.get('accounts', {}).get(account_id)
    if not account or not account.get('visible', True):
        raise ValueError('邮箱账号不存在')
    password = settings.account_password(account_id)
    if not password and settings._account_key(config.IMAP_HOST, config.IMAP_USER) == account_id:
        password = config.IMAP_PASSWORD
    if not password:
        raise ValueError('该邮箱需要重新登录')
    defaults = settings.discover(account['user'])
    return dict(ACCOUNT_ID=account_id, DB_PATH=account['db_path'], RAW_DIR=account['raw_dir'],
                IMAP_HOST=account['host'], IMAP_USER=account['user'], IMAP_PASSWORD=password,
                IMAP_PORT=account.get('port', 993), IMAP_SSL=account.get('ssl', True),
                IMAP_VERIFY_SSL=account.get('verify_ssl', True),
                SMTP_HOST=account.get('smtp_host') or defaults['smtp_host'],
                SMTP_PORT=account.get('smtp_port') or defaults['smtp_port'],
                SMTP_SSL=account.get('smtp_ssl', defaults['smtp_ssl']),
                SMTP_STARTTLS=account.get('smtp_starttls', defaults['smtp_starttls']),
                SMTP_VERIFY_SSL=account.get('smtp_verify_ssl', True),
                SMTP_USER='', SMTP_PASSWORD='', SMTP_USE_IMAP_CREDENTIALS=True,
                SMTP_SENT_IMAP_HOST=account['host'], SMTP_SENT_FOLDER='')


@contextmanager
def use(values):
    token = current.set(dict(values))
    with _lock:
        key = values['ACCOUNT_ID']
        _jobs[key] = _jobs.get(key, 0) + 1
    try:
        yield
    finally:
        current.reset(token)
        with _lock:
            _jobs[key] -= 1


def busy(account_id):
    with _lock:
        return _jobs.get(account_id, 0) > 0


def any_busy():
    with _lock:
        return any(_jobs.values())
