"""Opt-in, account-local server cleanup. Failed or interrupted runs stay paused."""
import json
import logging
import sqlite3
import threading
import uuid
from contextlib import closing
from datetime import date, datetime, timedelta
from pathlib import Path

from . import config, db, pipeline, server_cleanup, system_settings
from .account_context import snapshot, use
from .account_guard import guard

log = logging.getLogger(__name__)
KEY = 'server_cleanup_automation'
_lock = threading.Lock()
DEFAULTS = dict(enabled=False, folder='INBOX', days=90, interval_days=1,
                status='disabled', next_run='', last_run='', last_error='', revision='')


def get_settings():
    value = db.get_runtime_settings().get(KEY)
    return {**DEFAULTS, **json.loads(value)} if value else dict(DEFAULTS)


def _save(policy):
    db.set_runtime_setting(KEY, json.dumps(policy, ensure_ascii=False))
    return policy


def save_settings(enabled, folder='INBOX', days=90, interval_days=1,
                  confirmation='', acknowledge=False):
    previous = get_settings()
    if not enabled:
        return _save({**previous, 'enabled': False, 'status': 'disabled', 'next_run': ''})
    if (acknowledge is not True or not config.IMAP_USER
            or confirmation.strip().lower() != config.IMAP_USER.strip().lower()):
        raise ValueError('请确认自动清理风险，并输入当前邮箱地址')
    if days not in (30, 60, 90, 180, 365) or interval_days not in (1, 7):
        raise ValueError('请选择有效的保留天数和执行频率')
    if not folder or folder.startswith('__MAILAI_LOCAL__'):
        raise ValueError('请选择服务器文件夹')
    with server_cleanup.MailClient() as mail:
        names = {item['name'] for item in mail.list_mailboxes() if item.get('selectable', True)}
        if folder not in names:
            raise ValueError('服务器文件夹不存在')
        server_cleanup._select(mail, folder)
    with db.conn() as c:
        reviewed_jobs = [row['token'] for row in c.execute("SELECT token FROM server_cleanup_jobs WHERE status IN ('running','attention')")]
    return _save({**previous, 'enabled': True, 'folder': folder, 'days': days,
                  'interval_days': interval_days, 'status': 'scheduled', 'last_error': '',
                  'revision': uuid.uuid4().hex, 'account': config.IMAP_USER, 'host': config.IMAP_HOST,
                  'scan_offset': 0, 'reviewed_jobs': reviewed_jobs,
                  'next_run': (datetime.now() + timedelta(days=interval_days)).isoformat(timespec='seconds')})


def _pause(policy, error):
    return _save({**policy, 'status': 'paused', 'next_run': '', 'last_error': str(error)})


def _run_account():
    policy = get_settings()
    if not policy['enabled'] or policy['status'] == 'paused':
        return
    if policy['status'] == 'running':
        _pause(policy, '上次自动清理意外中断，请核对最近清理记录和服务器后重新启用')
        return
    now = datetime.now()
    if policy['next_run'] and datetime.fromisoformat(policy['next_run']) > now:
        return
    try:
        if policy.get('account') != config.IMAP_USER or policy.get('host') != config.IMAP_HOST:
            raise ValueError('邮箱身份已变化，请重新设置自动清理')
        # Persist before preview/network work. A crash must never replay deletion.
        policy.update(status='running', last_run=now.isoformat(timespec='seconds'))
        _save(policy)
        with db.conn() as c:
            unfinished = any(row['token'] not in policy.get('reviewed_jobs', []) for row in
                             c.execute("SELECT token FROM server_cleanup_jobs WHERE status IN ('running','attention')"))
        if unfinished:
            raise ValueError('存在需要核对的清理记录，请先检查服务器')
        cutoff = (date.today() - timedelta(days=policy['days'])).isoformat()
        result = None
        # Look past protected/missing messages, with a bounded scan and one batch.
        start_offset = int(policy.get('scan_offset', 0))
        for page in range(10):
            plan = server_cleanup.preview(policy['folder'], cutoff, False,
                                          start_offset + page * server_cleanup.MAX_ITEMS,
                                          automation_id=policy['revision'])
            policy['scan_offset'] = plan['offset'] + server_cleanup.MAX_ITEMS - plan['count'] if plan['more'] else 0
            if plan['count']:
                result = server_cleanup._execute(plan['token'], automatic=True)
                break
            with db.conn() as c:
                c.execute("DELETE FROM server_cleanup_jobs WHERE token=? AND status='preview'", (plan['token'],))
            if not plan['more']:
                break
        if result and result['status'] != 'completed':
            raise ValueError('；'.join(result['errors']) or '清理未完成，请核对服务器')
        policy.update(status='scheduled', last_error='',
                      next_run=(datetime.now() + timedelta(days=policy['interval_days'])).isoformat(timespec='seconds'))
        _save(policy)
    except Exception as exc:
        _pause(policy, exc)
        log.warning('自动清理已暂停 (%s)', type(exc).__name__)


def run_due():
    """Read idle deadlines without credentials; take an exclusive lease to delete."""
    if not _lock.acquire(blocking=False):
        return
    try:
        from .energy_scheduler import background_priority
        background_priority()
        accounts = system_settings._load_registry().get('accounts', {})
        for account_id, account in accounts.items():
            path = Path(account.get('db_path') or '')
            if not account.get('visible', True) or not path.is_file():
                continue
            try:
                with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=.5)) as c:
                    row = c.execute('SELECT value FROM runtime_settings WHERE key=?', (KEY,)).fetchone()
                policy = json.loads(row[0]) if row else {}
                if not policy.get('enabled') or policy.get('status') == 'paused':
                    continue
                if (policy.get('status') != 'running' and policy.get('next_run')
                        and datetime.fromisoformat(policy['next_run']) > datetime.now()):
                    continue
                if not guard.acquire(exclusive=True):
                    continue
                try:
                    with use(snapshot(account_id)):
                        if not pipeline._poll_lock.acquire(blocking=False):
                            continue
                        try:
                            _run_account()
                        finally:
                            pipeline._poll_lock.release()
                finally:
                    guard.release(exclusive=True)
            except Exception:
                log.exception('自动清理检查未完成')
    finally:
        _lock.release()
