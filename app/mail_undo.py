"""Short-lived undo records with state checks to protect later user changes."""
import json
import uuid
from contextlib import ExitStack
from datetime import datetime, timedelta
from . import db
from .imap_client import MailClient


def record(action, before, after):
    token = uuid.uuid4().hex
    now = datetime.now()
    with db.conn() as c:
        c.execute('INSERT INTO undo_operations VALUES(?,?,?,?,0)',
                  (token, json.dumps({'action': action, 'before': before, 'after': after}), now.isoformat(), (now + timedelta(minutes=2)).isoformat()))
    return token


def restore(token):
    with db.conn() as c:
        row = c.execute('SELECT * FROM undo_operations WHERE token=?', (token,)).fetchone()
        if not row or row['used'] or row['expires_at'] < datetime.now().isoformat():
            raise ValueError('撤销已过期或已经执行')
        c.execute('UPDATE undo_operations SET used=1 WHERE token=? AND used=0', (token,))
        if not c.execute('SELECT changes()').fetchone()[0]:
            raise ValueError('撤销正在执行')
        operation = json.loads(row['payload'])
    if operation['action'] == 'trash_pending':
        failed = []
        for before, after in zip(operation['before'], operation['after']):
            row = db.get_email(before['id'])
            if (not row or row.get('pending_action') != after.get('pending_action')
                    or int(row.get('remote_missing') or 0) != int(after.get('remote_missing') or 0)
                    or not db.cancel_pending_trash(before['id'])):
                failed.append({'id': before['id'], 'error': '邮件已开始同步服务器，不能再撤销本地任务'})
                continue
            db.add_audit_log(before['id'], 'undo_trash_pending', actor='user')
        failed_ids = {item['id'] for item in failed}
        retry = record(
            operation['action'],
            [item for item in operation['before'] if item['id'] in failed_ids],
            [item for item in operation['after'] if item['id'] in failed_ids],
        ) if failed else None
        return {'ok': not failed, 'failed': failed, 'retry_token': retry}
    if operation['action'] == 'read':
        failed = []
        for before, after in zip(operation['before'], operation['after']):
            row = db.get_email(before['id'])
            if not row or row.get('is_read') != after.get('is_read'):
                failed.append({'id': before['id'], 'error': '邮件已发生其他变化，请手动处理'})
                continue
            queued, _ = db.queue_seen_sync([before['id']], bool(before['is_read']))
            if not queued:
                failed.append({'id': before['id'], 'error': '邮件当前无法更新'})
                continue
            db.add_audit_log(before['id'], 'undo_read', actor='user',
                             reason='本地立即撤销，后台同步邮箱服务器')
        failed_ids = {item['id'] for item in failed}
        retry = record(
            operation['action'],
            [item for item in operation['before'] if item['id'] in failed_ids],
            [item for item in operation['after'] if item['id'] in failed_ids],
        ) if failed else None
        return {'ok': not failed, 'failed': failed, 'retry_token': retry}
    failed = []
    with ExitStack() as stack:
        try:
            mail = stack.enter_context(MailClient())
        except Exception as exc:
            with db.conn() as c:
                c.execute('UPDATE undo_operations SET used=0 WHERE token=?', (token,))
            raise ValueError('暂时无法连接邮箱，撤销记录已保留，请重试') from exc
        for before, after in zip(operation['before'], operation['after']):
            try:
                row = db.get_email(before['id'])
                if row and (row.get('is_local_archive') or row.get('cleanup_hold')):
                    raise ValueError('邮件已仅本地保留或正在清理，不能撤销服务器操作')
                fields = ('folder', 'uid', 'status') if operation['action'] == 'move' else ('is_read',) if operation['action'] == 'read' else ('is_starred',)
                if not row or any(row.get(k) != after.get(k) for k in fields):
                    raise ValueError('邮件已发生其他变化，请手动处理')
                if operation['action'] == 'move':
                    uid = mail.move(row['uid'], row['folder'], before['folder'])
                    db.set_mail_state(row['id'], folder=before['folder'], uid=uid)
                    db.set_status(row['id'], before['status'])
                elif operation['action'] == 'read':
                    mail.set_seen(row['uid'], row['folder'], bool(before['is_read']))
                    db.set_mail_state(row['id'], is_read=bool(before['is_read']))
                else:
                    mail.set_flagged(row['uid'], row['folder'], bool(before['is_starred']))
                    db.set_mail_state(row['id'], is_starred=bool(before['is_starred']))
                db.add_audit_log(row['id'], 'undo_' + operation['action'], actor='user')
            except Exception as exc:
                failed.append({'id': before['id'], 'error': str(exc)[:120]})
    failed_ids = {item['id'] for item in failed}
    retry = record(operation['action'], [r for r in operation['before'] if r['id'] in failed_ids],
                   [r for r in operation['after'] if r['id'] in failed_ids]) if failed else None
    return {'ok': not failed, 'failed': failed, 'retry_token': retry}
