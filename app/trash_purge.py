"""Local-first trash purge with durable tombstones and isolated best-effort IMAP work."""
import hashlib
import json
import secrets
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import config, db
from .imap_client import MailClient, mailbox_role
from .server_cleanup import _select

_previews = {}
_preview_lock = threading.Lock()
_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix='trash-purge')
_workers = {}
_workers_lock = threading.Lock()
_next_run = {}


def _account():
    return (str(config.DB_PATH), config.IMAP_HOST, config.IMAP_USER)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def content_digest(row):
    fields = [str(row.get(k) or '') for k in ('message_id', 'from_addr', 'subject', 'date', 'body_text')]
    return digest(json.dumps(fields, ensure_ascii=False).encode()) if any(fields) else ''


def raw_digest(path):
    try:
        target = Path(path).resolve()
        if Path(config.RAW_DIR).resolve() not in target.parents:
            return ''
        with target.open('rb') as source:
            return hashlib.file_digest(source, 'sha256').hexdigest()
    except (OSError, ValueError):
        return ''


def is_suppressed(c, folder, uid, raw_hash='', content_hash=''):
    # Generation-qualified UIDs cannot hide an unrelated message after UID reuse.
    return c.execute(
        "SELECT 1 FROM trash_tombstones WHERE account=? AND host=? AND "
        "((raw_digest<>'' AND raw_digest=?) OR (content_digest<>'' AND content_digest=?) OR (folder=? AND uid=? AND uid_validity>0 AND "
        "uid_validity=COALESCE((SELECT uid_validity FROM sync_state WHERE folder=?),0))) LIMIT 1",
        (config.IMAP_USER, config.IMAP_HOST, raw_hash, content_hash, folder, uid, folder),
    ).fetchone() is not None


def suppressed(folder, uid, raw):
    with db.conn() as c:
        return is_suppressed(c, folder, uid, digest(raw))


def suppressed_uids(c, folder):
    return {int(r[0]) for r in c.execute(
        'SELECT uid FROM trash_tombstones WHERE account=? AND host=? AND folder=? AND uid>0 AND '
        'uid_validity>0 AND uid_validity=COALESCE((SELECT uid_validity FROM sync_state WHERE folder=?),0)',
        (config.IMAP_USER, config.IMAP_HOST, folder, folder))}


def _eligible(row):
    # Remote move failures must never veto an explicitly confirmed local purge.
    return bool(row and not row.get('cleanup_hold') and
                (row.get('pending_action') or '') in ('', 'trash', 'trash_copying', 'trash_copied', 'trash_locating', 'trash_local') and
                (row['status'] == 'trash' or str(row.get('pending_action') or '').startswith('trash')))


def _identity(row):
    # A move may advance while confirmation is open; content, not its phase or
    # server UID, identifies the user's selected message. Eligibility catches restores.
    return (content_digest(row), row.get('raw_path'), row.get('is_local_archive'))


def preview(factory, ids, empty=False):
    """No server connections. Snapshot all local trash, not merely the visible page."""
    with db.conn() as c:
        if empty:
            rows = [dict(r) for r in c.execute(
                "SELECT * FROM emails WHERE status='trash' OR pending_action LIKE 'trash%'")]
        else:
            rows = [db.get_email(i) for i in dict.fromkeys(ids)]
    if not empty and (not rows or any(not r or (r['status'] != 'trash' and
            not str(r.get('pending_action') or '').startswith('trash')) for r in rows)):
        raise ValueError('请选择本地已删除邮件')
    items = [dict(id=r['id'], identity=_identity(r)) for r in rows if _eligible(r)]
    now, token = time.monotonic(), secrets.token_urlsafe(32)
    with _preview_lock:
        for key, value in list(_previews.items()):
            if value['expires'] < now:
                _previews.pop(key, None)
        _previews[token] = dict(account=_account(), expires=now + 300, items=items)
    return dict(token=token, count=len(items), skipped=len(rows)-len(items), account=config.IMAP_USER)


def _remove_local(c, row):
    for table in ('todos', 'url_chains', 'seen_sync_jobs'):
        c.execute(f'DELETE FROM {table} WHERE email_id=?', (row['id'],))
    for table in ('email_vectors', 'briefing_dismissed'):
        if c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone():
            c.execute(f'DELETE FROM {table} WHERE email_id=?', (row['id'],))
    c.execute('UPDATE audit_logs SET email_id=NULL WHERE email_id=?', (row['id'],))
    c.execute('UPDATE drafts SET reply_to_email_id=NULL WHERE reply_to_email_id=?', (row['id'],))
    c.execute('UPDATE drafts SET source_draft_email_id=NULL WHERE source_draft_email_id=?', (row['id'],))
    c.execute('DELETE FROM threads WHERE thread_id=?', (row.get('thread_id'),))
    c.execute('DELETE FROM emails WHERE id=?', (row['id'],))
    c.execute('UPDATE mailbox_sequence SET value=value+1 WHERE id=1')


def execute(factory, token, confirmed):
    with _preview_lock:
        plan = _previews.get(token)
        if not confirmed or not plan or plan['account'] != _account() or plan['expires'] < time.monotonic():
            raise ValueError('确认已过期或邮箱已变化，请重新确认')
        _previews.pop(token)
    completed, errors = 0, []
    for item in plan['items']:
        row = db.get_email(item['id'])
        if not row:
            continue
        fingerprint = raw_digest(row.get('raw_path') or '')
        with db.conn() as c:
            c.execute('BEGIN IMMEDIATE')
            fresh = c.execute('SELECT * FROM emails WHERE id=?', (item['id'],)).fetchone()
            fresh = dict(fresh) if fresh else None
            if not _eligible(fresh) or _identity(fresh) != item['identity'] or fresh.get('raw_path') != row.get('raw_path'):
                errors.append('部分邮件正在移动或已恢复，已保留，请稍后重试')
                continue
            validity = c.execute('SELECT uid_validity FROM sync_state WHERE folder=?', (fresh['folder'],)).fetchone()
            validity = int(validity[0] or 0) if validity else 0
            pending = bool(fingerprint and validity and fresh['uid'] > 0 and not fresh.get('is_local_archive'))
            c.execute(
                'INSERT INTO trash_tombstones(account,host,folder,uid,uid_validity,raw_digest,content_digest,raw_path,state,error,created_at) '
                'VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                (config.IMAP_USER, config.IMAP_HOST, fresh['folder'], fresh['uid'], validity,
                 fingerprint, content_digest(fresh), fresh.get('raw_path') or '', 'pending' if pending else 'blocked',
                 '' if pending else '缺少可验证的服务器身份，仅删除本地邮件', time.time()),
            )
            _remove_local(c, fresh)  # Job and local deletion commit atomically.
            completed += 1
    cleanup_files()
    db.add_audit_log(None, 'purge_trash_local', actor='user', reason=f'本地彻底删除 {completed} 封；远端后台尽力同步')
    return dict(completed=completed, errors=list(dict.fromkeys(errors)), **status())


def discard_raw(path, expected_digest):
    """Never unlink outside RAW_DIR, a reused path, or another live row's raw."""
    target = Path(path).resolve()
    if Path(config.RAW_DIR).resolve() not in target.parents:
        raise ValueError('原文路径不在当前邮箱数据目录，未删除')
    if not target.exists():
        return
    stat = target.stat()
    if not expected_digest or raw_digest(path) != expected_digest:
        raise ValueError('原文内容已变化，未删除该文件')
    with db.conn() as c:
        c.execute('BEGIN IMMEDIATE')
        if c.execute('SELECT 1 FROM emails WHERE raw_path=? LIMIT 1', (path,)).fetchone():
            return
        if not target.exists():
            return
        current = target.stat()
        if (current.st_ino, current.st_size, current.st_mtime_ns) != (stat.st_ino, stat.st_size, stat.st_mtime_ns):
            raise ValueError('原文内容已变化，未删除该文件')
        target.unlink()


def cleanup_files(limit=200):
    with db.conn() as c:
        rows = [dict(r) for r in c.execute(
            "SELECT id,raw_path,raw_digest FROM trash_tombstones WHERE account=? AND host=? AND raw_path<>'' ORDER BY (cleanup_error<>''),id LIMIT ?",
            (config.IMAP_USER, config.IMAP_HOST, limit))]
    for row in rows:
        try:
            discard_raw(row['raw_path'], row['raw_digest'])
            with db.conn() as c:
                c.execute("UPDATE trash_tombstones SET raw_path='',cleanup_error='' WHERE id=?", (row['id'],))
        except (OSError, ValueError) as exc:
            with db.conn() as c:
                c.execute('UPDATE trash_tombstones SET cleanup_error=? WHERE id=?', (str(exc), row['id']))


def status():
    with db.conn() as c:
        counts = {r['state']: r['n'] for r in c.execute(
            'SELECT state,COUNT(*) n FROM trash_tombstones WHERE account=? AND host=? GROUP BY state',
            (config.IMAP_USER, config.IMAP_HOST))}
        files = c.execute("SELECT COUNT(*) FROM trash_tombstones WHERE account=? AND host=? AND raw_path<>''",
                          (config.IMAP_USER, config.IMAP_HOST)).fetchone()[0]
        notices = [r[0] for r in c.execute(
            "SELECT id FROM trash_tombstones WHERE account=? AND host=? AND state='blocked' "
            "AND id NOT IN (SELECT tombstone_id FROM trash_notice_ack) ORDER BY id",
            (config.IMAP_USER, config.IMAP_HOST))]
    return dict(pending=counts.get('pending', 0), blocked=counts.get('blocked', 0),
                cleanup_pending=files, notice_ids=notices, unacknowledged=len(notices))


def acknowledge(ids):
    """Acknowledge only displayed results, never pending work or suppression markers."""
    with db.conn() as c:
        for item in set(ids):
            c.execute(
                "INSERT OR IGNORE INTO trash_notice_ack(tombstone_id,acknowledged_at) "
                "SELECT id,? FROM trash_tombstones WHERE id=? AND account=? AND host=? AND state='blocked'",
                (time.time(), item, config.IMAP_USER, config.IMAP_HOST))
    return status()


def process_due(factory=None, limit=20):
    """Bounded background pass. No UI/global mutation lock over network I/O."""
    cleanup_files()
    factory = factory or MailClient
    with db.conn() as c:
        rows = [dict(r) for r in c.execute(
            "SELECT * FROM trash_tombstones WHERE account=? AND host=? AND state='pending' AND due_at<=? ORDER BY due_at,id LIMIT ?",
            (config.IMAP_USER, config.IMAP_HOST, time.time(), limit))]
    if not rows:
        return
    def update(row, state, error=''):
        attempts = row['attempts'] + 1
        with db.conn() as c:
            c.execute('UPDATE trash_tombstones SET state=?,attempts=?,error=?,due_at=? WHERE id=?',
                      (state, attempts, error[:300], time.time() + min(3600, 30 * 2 ** min(attempts, 7)), row['id']))
    try:
        with factory() as mail:
            if not mail.client.has_capability('UIDPLUS'):
                for row in rows:
                    update(row, 'blocked', '服务器不支持精确删除，本地删除不受影响')
                return
            folders = {mail._text(name) for flags, _, name in mail.client.list_folders()
                       if mailbox_role({'name': mail._text(name), 'flags': [mail._text(f) for f in flags]}) == 'trash'}
            started = time.monotonic()
            for row in rows:
                if time.monotonic() - started > 15:
                    break
                try:
                    if row['folder'] not in folders:
                        update(row, 'blocked', '原位置不是服务器垃圾箱，未执行远端删除')
                        continue
                    _select(mail, row['folder'], readonly=False, expected=row['uid_validity'])
                    metadata = mail.client.fetch([row['uid']], ['RFC822.SIZE']).get(row['uid'])
                    if metadata is None:
                        update(row, 'done')
                        continue
                    if int(metadata.get(b'RFC822.SIZE', 0)) > 50 * 1024 * 1024:
                        update(row, 'blocked', '远端原文超过安全校验大小，仅本地完成')
                        continue
                    remote = mail.client.fetch([row['uid']], ['BODY.PEEK[]']).get(row['uid'])
                    if remote is None:
                        update(row, 'done')
                        continue
                    raw = remote.get(b'BODY[]')
                    if not isinstance(raw, bytes) or digest(raw) != row['raw_digest']:
                        update(row, 'blocked', '服务器邮件身份已变化，未执行远端删除')
                        continue
                    mail.client.add_flags([row['uid']], ['\\Deleted'], silent=True)
                    mail.client.expunge([row['uid']])
                    if mail.client.search(['UID', str(row['uid'])]):
                        raise OSError('服务器仍保留邮件，将稍后重试')
                    update(row, 'done')
                except ValueError as exc:
                    update(row, 'blocked', str(exc))
                except Exception as exc:
                    update(row, 'pending', str(exc))
                    break  # Do not repeat timeouts on an unhealthy connection.
    except Exception as exc:
        for row in rows:
            update(row, 'pending', str(exc))


def schedule():
    """Separate pool: an offline provider cannot stall the send queue or UI."""
    from .account_context import current, use
    scoped = current.get()
    if scoped is None:
        return
    key = str(config.DB_PATH)
    with _workers_lock:
        prior = _workers.get(key)
        if prior and not prior.done():
            return
        if time.monotonic() < _next_run.get(key, 0):
            return
        _next_run[key] = time.monotonic() + 30
        def run():
            from .account_guard import guard
            from .account_context import snapshot
            guard.acquire_work()
            try:
                # Revalidate queued credentials/account removal before connecting.
                with use(snapshot(scoped['ACCOUNT_ID'])):
                    process_due()
            except Exception:
                __import__('logging').getLogger(__name__).exception('远端彻底删除暂不可用；本地功能不受影响')
            finally:
                guard.release()
        _workers[key] = _executor.submit(run)
