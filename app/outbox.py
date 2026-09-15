"""Durable delayed sending. Uncertain SMTP outcomes are never auto-retried."""
import json
import os
import threading
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timedelta
from . import db

_active = set()
_lock = threading.Lock()
current_send_token = ContextVar('mailai_sending_token', default=None)


@contextmanager
def _process_lock(path: str):
    """Prevent two application processes from servicing one outbox."""
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    stream = open(path, "a+b")
    locked = False
    try:
        if os.name == "nt":
            import msvcrt
            stream.seek(0)
            if not stream.read(1):
                stream.seek(0)
                stream.write(b"0")
                stream.flush()
            stream.seek(0)
            try:
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                locked = True
            except OSError:
                pass
        else:
            import fcntl
            try:
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                locked = True
            except BlockingIOError:
                pass
        yield locked
    finally:
        if locked:
            try:
                if os.name == "nt":
                    import msvcrt
                    stream.seek(0)
                    msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
        stream.close()


def draft_pending(draft_id):
    if not draft_id:
        return False
    with db.conn() as c:
        return bool(c.execute("SELECT 1 FROM outbox WHERE status IN ('queued','sending','unknown') AND json_extract(payload,'$.id')=? LIMIT 1", (draft_id,)).fetchone())


def enqueue(token, payload, delay=10):
    if not token or len(token) > 100:
        raise ValueError('缺少发送请求编号')
    now = datetime.now()
    body = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    with db.conn() as c:
        c.execute('BEGIN IMMEDIATE')
        old = c.execute('SELECT payload,status FROM outbox WHERE token=?', (token,)).fetchone()
        if not old and payload.get('id'):
            pending = c.execute("SELECT token FROM outbox WHERE status IN ('queued','sending','unknown') AND json_extract(payload,'$.id')=?", (payload['id'],)).fetchone()
            if pending:
                raise ValueError('这份草稿已有发送任务，请先在任务与发件箱中撤销或确认发送结果')
        if old and old['payload'] != body:
            raise ValueError('发送内容已变化，请重新创建发送任务')
        c.execute("INSERT OR IGNORE INTO outbox(token,payload,status,due_at,created_at,updated_at) VALUES(?,?,'queued',?,?,?)",
                  (token, body, (now + timedelta(seconds=delay)).isoformat(), now.isoformat(), now.isoformat()))
    return {'ok': True, 'token': token, 'status': old['status'] if old else 'queued', 'delay': delay}


def cancel(token):
    with db.conn() as c:
        c.execute("UPDATE outbox SET status='canceled',updated_at=? WHERE token=? AND status='queued'", (datetime.now().isoformat(), token))
        if not c.execute('SELECT changes()').fetchone()[0]:
            raise ValueError('邮件已开始发送，无法撤销；请查看发件箱状态')
    return {'ok': True}


def resolve(token, delivered):
    with db.conn() as c:
        c.execute("UPDATE outbox SET status=?,error=?,updated_at=? WHERE token=? AND status='unknown'",
                  ('sent' if delivered else 'failed', '用户已核对：已送达' if delivered else '用户已核对：未送达，可从草稿重新编辑', datetime.now().isoformat(), token))
        if not c.execute('SELECT changes()').fetchone()[0]:
            raise ValueError('仅待确认的发送记录可以人工确认')
        row = c.execute('SELECT result,payload FROM outbox WHERE token=?', (token,)).fetchone()
        record_id = json.loads(row['result'] or '{}').get('sent_record_id')
        if record_id:
            c.execute('UPDATE sent_messages SET status=?,error=? WHERE id=?',
                      ('sent' if delivered else 'failed', '用户已核对发送结果', record_id))
    if delivered:
        db.complete_sent_draft(json.loads(row['payload']).get('id'))
    db.add_audit_log(None, 'resolve_send_outcome', actor='user', reason='已送达' if delivered else '未送达', meta={'token': token})
    return {'ok': True}


def items():
    with db.conn() as c:
        rows = [dict(row) for row in c.execute("SELECT * FROM outbox WHERE status IN ('queued','sending','failed','unknown') OR token IN (SELECT token FROM outbox WHERE status NOT IN ('queued','sending','failed','unknown') ORDER BY created_at DESC LIMIT 200) ORDER BY created_at DESC")]
    for row in rows:
        payload = json.loads(row.pop('payload'))
        row.update(subject=payload.get('subject'), to_addr=payload.get('to_addr'), draft_id=payload.get('id'))
    return rows


def process(send):
    """Called within an account snapshot. Only one worker per database."""
    from . import config
    key = config.DB_PATH
    with _lock:
        if key in _active:
            return
        _active.add(key)
    try:
        with _process_lock(key + ".outbox.lock") as owns_process_lock:
            if not owns_process_lock:
                return
            _process_locked(send)
    finally:
        with _lock:
            _active.remove(key)


def _process_locked(send):
    with db.conn() as c:
        # A previous process may have died after the server accepted DATA.
        c.execute("UPDATE outbox SET status='unknown',error='上次发送中断，结果待确认；请核对已发送邮件后再处理' WHERE status='sending'")
        c.execute("UPDATE sent_messages SET status='unknown' WHERE id IN (SELECT json_extract(result,'$.sent_record_id') FROM outbox WHERE status='unknown')")
        tokens = [row[0] for row in c.execute("SELECT token FROM outbox WHERE status='queued' AND due_at<=? ORDER BY due_at,token LIMIT 10", (datetime.now().isoformat(),))]
    for token in tokens:
        with db.conn() as c:
            c.execute("UPDATE outbox SET status='sending',updated_at=? WHERE token=? AND status='queued'", (datetime.now().isoformat(), token))
            if not c.execute('SELECT changes()').fetchone()[0]:
                continue
            payload = json.loads(c.execute('SELECT payload FROM outbox WHERE token=?', (token,)).fetchone()[0])
        result, error, status = {}, '', 'sent'
        context_token = current_send_token.set(token)
        try:
            result = send(payload)
        except Exception as exc:
            import smtplib
            known = isinstance(exc, (smtplib.SMTPRecipientsRefused, smtplib.SMTPAuthenticationError, ValueError)) or getattr(exc, 'status_code', 500) < 500
            status = 'failed' if known else 'unknown'
            error = str(exc)[:300] if known else '发送结果待确认，请先核对服务器已发送邮件，避免重复发送'
        finally:
            current_send_token.reset(context_token)
        with db.conn() as c:
            stored = json.loads(c.execute('SELECT result FROM outbox WHERE token=?', (token,)).fetchone()[0] or '{}')
            result = {**stored, **(result or {})}
            if status == 'unknown' and result.get('sent_record_id'):
                c.execute("UPDATE sent_messages SET status='unknown',error=? WHERE id=?", (error, result['sent_record_id']))
            c.execute('UPDATE outbox SET status=?,result=?,error=?,updated_at=? WHERE token=?',
                      (status, json.dumps(result, ensure_ascii=False), error, datetime.now().isoformat(), token))
