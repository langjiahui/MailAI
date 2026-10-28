"""Explicit, account-scoped recovery of deferred IMAP mail. No server writes."""
from email import policy
from email.parser import BytesHeaderParser
from pathlib import Path
import threading
import time
import uuid

from . import config, db, pipeline
from .account_guard import start_account_thread
from .imap_client import BODY_CHUNK_BYTES, MailClient, mailbox_role
from .mail_headers import decode_header_text

MAX_MANUAL_BYTES = 256 * 1024**2
_lock = threading.Lock()
_tasks = {}


def discover_legacy(mail):
    """Turn an old count-only warning into exact, recoverable UID records."""
    with db.conn() as c:
        c.execute("UPDATE mail_fetch_retries SET due_at=0,error=? WHERE size>? AND size<=? "
                  "AND error LIKE ?", ('大邮件等待自动分段下载', 50 * 1024**2, MAX_MANUAL_BYTES,
                                       '%超过 50 MB%'))
    count = int(db.get_runtime_settings().get('oversized_mail_count', '0') or 0)
    if count <= db.mail_fetch_retry_summary(config.INBOX_FOLDER)['oversized']:
        return
    folder = config.INBOX_FOLDER
    mail.select_folder(folder, readonly=True, reset_generation=True)
    uids = list(mail.client.search(['ALL']))
    for offset in range(0, len(uids), 100):
        if pipeline._is_canceled():
            return
        batch = uids[offset:offset + 100]
        sizes = mail.client.fetch(batch, ['RFC822.SIZE'])
        for uid in batch:
            item = sizes.get(uid, {})
            size = int(item.get(b'RFC822.SIZE') or item.get('RFC822.SIZE') or 0)
            if size > 50 * 1024**2 and not db.already_processed(folder, uid):
                db.defer_mail_fetch(folder, uid, '历史大邮件等待分段下载', size=size, retry_after=0)
    db.set_runtime_setting('oversized_mail_count', str(db.mail_fetch_retry_summary(folder)['oversized']))


def recover_large(mail, folder, uid, size, *, history=False):
    """Automatically stream a large message; never move it or mark it read."""
    if size > MAX_MANUAL_BYTES:
        raise ValueError('邮件超过 256 MB，请在原邮箱下载原件')
    row = dict(folder=folder, uid=uid, size=size, uid_validity=db.get_uid_validity(folder))
    with db.conn() as c:
        previous = c.execute('SELECT error FROM mail_fetch_retries WHERE folder=? AND uid=?', (folder, uid)).fetchone()
        history = history or bool(previous and str(previous['error']).startswith('历史大邮件'))
    Path(config.RAW_DIR).mkdir(parents=True, exist_ok=True)
    path = Path(config.RAW_DIR) / ('automatic-' + uuid.uuid4().hex + '.eml')
    try:
        def progress(received, total):
            pipeline._set_fetch_state(True, operation='fetch_all' if history else 'poll',
                message=f'正在分段下载大邮件：{received / 1024**2:.1f} / {total / 1024**2:.1f} MB', persist=False)
        flags = download(mail, row, path, progress)
        from .mail_import import _parse_exported
        from .trash_purge import raw_digest
        parsed = _parse_exported(path)
        parsed.update(uid=uid, folder=folder, raw_path=str(path), status='inbox',
                      arrival_kind='history' if history else 'new', processing_complete=1,
                      verdict='unreviewed', review_source='large_mail_download', action_mode='observe',
                      action_reason='大邮件分段保存到本机，未执行服务器操作', _purge_digest=raw_digest(path))
        existing = db.get_email_by_folder_uid(folder, uid)
        email_id = existing['id'] if existing else db.upsert_email(parsed)
        if email_id and not existing:
            path = None  # Only a committed row can own the downloaded file.
            db.sync_mail_flags(email_id, is_read=b'\\Seen' in flags or '\\Seen' in flags,
                               is_starred=b'\\Flagged' in flags or '\\Flagged' in flags)
            if history:
                with db.conn() as c:
                    c.execute('UPDATE emails SET notification_sent=1 WHERE id=?', (email_id,))
        db.clear_mail_fetch_retry(folder, uid)
        db.add_audit_log(email_id or None, 'automatic_large_mail_download', actor='system',
                         reason='大邮件分段下载完成，原邮件与已读状态保持不变')
        if email_id and not history and not existing:
            from .mailbox_jobs import notify_new_message
            notify_new_message(email_id)
        return {'status': 'inbox' if email_id else 'purged', 'id': email_id}
    except Exception as exc:
        if history:
            raise RuntimeError('历史大邮件下载失败：' + str(exc)) from exc
        raise
    finally:
        if path is not None:
            path.unlink(missing_ok=True)


def overview(offset=0, limit=30):
    with db.conn() as c:
        total = c.execute('SELECT COUNT(*) FROM mail_fetch_retries').fetchone()[0]
        rows = [dict(row) for row in c.execute('SELECT * FROM mail_fetch_retries ORDER BY updated_at DESC,folder,uid LIMIT ? OFFSET ?', (limit, offset))]
    with _lock:
        task = dict(_tasks.get(config.DB_PATH, {}))
    from .mail_connection import issue_kind
    sync = pipeline.get_fetch_state()
    sync['issue_kind'] = issue_kind(sync.get('error'))
    return dict(items=rows, total=total, task=task, sync=sync)


def _entry(folder, uid):
    with db.conn() as c:
        row = c.execute('SELECT * FROM mail_fetch_retries WHERE folder=? AND uid=?', (folder, uid)).fetchone()
    if not row:
        raise ValueError('这封邮件已下载或记录已变化，请刷新问题列表')
    return dict(row)


def _select(mail, row):
    info = mail.client.select_folder(row['folder'], readonly=True)
    generation = mail._uid_validity(info)
    if not generation or generation != int(row['uid_validity'] or 0):
        raise ValueError('服务器文件夹标识已变化，请先重新同步此邮箱，再查看问题邮件')


def inspect(folder, uid):
    row = _entry(folder, uid)
    with MailClient() as mail:
        _select(mail, row)
        # Partial PEEK fetch prevents mark-as-read and caps an untrusted header.
        data = mail.client.fetch([uid], ['RFC822.SIZE', 'BODY.PEEK[HEADER]<0.32768>']).get(uid, {})
        header = data.get(b'BODY[HEADER]<0>', b'')
        if not isinstance(header, bytes) or len(header) > 32768:
            raise ValueError('服务器未按限制返回邮件头，请在原邮箱核对这封邮件')
        if not header:
            raise ValueError('服务器暂未返回这封邮件，可能已移动或删除，请先重新同步')
        message = BytesHeaderParser(policy=policy.default).parsebytes(header)
        return {**row, 'subject':decode_header_text(str(message.get('Subject') or '')), 'sender':decode_header_text(str(message.get('From') or '')),
                'date':str(message.get('Date') or ''), 'size':int(data.get(b'RFC822.SIZE') or row['size'] or 0)}


def download(mail, row, path, progress):
    """Write bounded chunks to disk, never join a huge message in memory."""
    _select(mail, row)
    uid = row['uid']
    data = mail.client.fetch([uid], ['RFC822.SIZE', 'FLAGS']).get(uid, {})
    size = int(data.get(b'RFC822.SIZE') or 0)
    if size <= 0:
        raise ValueError('服务器未返回邮件大小，请先重新同步或在原邮箱下载原件')
    if size > MAX_MANUAL_BYTES:
        raise ValueError('这封邮件超过单封补下载的 256 MB 上限，请在原邮箱下载原件，另存较小副本后导入')
    received, deadline = 0, time.monotonic() + 900
    with path.open('xb') as target:
        while received < size:
            if pipeline._is_canceled():
                raise ValueError('已停止补下载，问题记录已保留，可稍后重试')
            if time.monotonic() > deadline:
                raise ValueError('单封邮件下载超时，问题记录已保留，可稍后重试')
            length = min(BODY_CHUNK_BYTES, size - received)
            piece = mail.client.fetch([uid], [f'BODY.PEEK[]<{received}.{length}>']).get(uid, {})
            raw = piece.get(f'BODY[]<{received}>'.encode())
            if raw is None and received == 0:
                raw = piece.get(b'BODY[]')
            if not isinstance(raw, bytes) or not raw or len(raw) > length:
                raise ValueError('邮件分段下载中断或服务器未按限制返回，问题记录已保留，请重试')
            target.write(raw)
            received += len(raw)
            progress(received, size)
    return data.get(b'FLAGS') or ()


def start(folder, uid):
    row = _entry(folder, uid)
    if int(row.get('size') or 0) > MAX_MANUAL_BYTES:
        raise ValueError('这封邮件超过单封补下载的 256 MB 上限，请在原邮箱下载原件，另存较小副本后导入')
    owner = config.DB_PATH
    with _lock:
        if _tasks.get(owner, {}).get('running'):
            raise ValueError('此邮箱已有单封补下载任务，请等待完成')
        if pipeline.get_live_fetch_state().get('running'):
            raise ValueError('此邮箱正在同步，请等待完成后再补下载')
        _tasks[owner] = dict(running=True, folder=folder, uid=uid, received=0, size=row['size'], error='')
    def update(**values):
        with _lock:
            _tasks[owner].update(values)
    def run():
        path = None
        acquired = False
        try:
            acquired = pipeline._poll_lock.acquire(blocking=False)
            if not acquired:
                raise ValueError('此邮箱正在同步，请等待完成后再补下载')
            _entry(folder, uid)
            pipeline._reset_cancel()
            pipeline._set_fetch_state(True, operation='recover_message', message='正在补下载单封邮件')
            def progress(received, size):
                update(received=received, size=size)
                pipeline._set_fetch_state(True, operation='recover_message', message=f'正在补下载邮件：{received / 1024**2:.1f} / {size / 1024**2:.1f} MB', persist=False)
            Path(config.RAW_DIR).mkdir(parents=True, exist_ok=True)
            path = Path(config.RAW_DIR) / ('recovered-' + uuid.uuid4().hex + '.eml')
            with MailClient() as mail:
                flags = download(mail, row, path, progress)
                role = mailbox_role(next((item for item in mail.list_mailboxes() if item['name'] == folder), {'name':folder}))
            # The bounded projection already used for large client imports preserves the raw file.
            from .mail_import import _parse_exported
            parsed = _parse_exported(path)
            parsed.update(uid=uid, folder=folder, raw_path=str(path), status='sent' if role == 'sent' else 'draft' if role == 'draft' else role if role in ('trash','spam','quarantine') else 'inbox',
                          arrival_kind='history', processing_complete=1, verdict='unreviewed', review_source='manual_download',
                          action_mode='observe', action_reason='单封补下载，仅保存本机副本，未执行服务器操作')
            if db.already_processed(folder, uid):
                saved = db.get_email_by_folder_uid(folder, uid)
                email_id = saved['id']
            else:
                email_id = db.upsert_email(parsed)
                if not email_id:
                    raise ValueError('此邮件已在本机删除，未重新恢复；请核对已删除邮件')
                with db.conn() as c:
                    c.execute('UPDATE emails SET is_read=?,notification_sent=1 WHERE id=?', (int(b'\\Seen' in flags or '\\Seen' in flags), email_id))
                path = None  # The committed email now owns the raw file.
            db.clear_mail_fetch_retry(folder, uid)
            db.set_runtime_setting('oversized_mail_count', str(db.mail_fetch_retry_summary(config.INBOX_FOLDER)['oversized']))
            db.add_audit_log(email_id, 'manual_mail_download', actor='user', reason='单封补下载完成，原邮件和已读状态保持不变')
            update(running=False, email_id=email_id, error='')
            pipeline._set_fetch_state(False, operation='recover_message', message='单封补下载完成，可打开邮件查看')
        except Exception as exc:
            error = str(exc) if isinstance(exc, ValueError) else '补下载未完成，请检查邮箱连接后重试；问题记录已保留'
            update(running=False, error=error)
            if acquired:
                pipeline._set_fetch_state(False, operation='recover_message', error=error, canceled=pipeline._is_canceled())
        finally:
            if path is not None:
                path.unlink(missing_ok=True)
            if acquired:
                pipeline._poll_lock.release()
    try:
        start_account_thread(run, name='mailai-mail-recovery')
    except Exception:
        update(running=False, error='无法启动补下载，请稍后重试')
        raise
    return dict(ok=True, running=True)
