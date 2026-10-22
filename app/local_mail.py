"""Organize local copies without changing their source identity or using IMAP."""
from . import db

TARGETS = {'__local_inbox__': 'inbox', '__local_archive__': 'local_archive', '__local_sent__': 'sent', 'INBOX': 'inbox'}
STATE_FIELDS = ('id', 'uid', 'folder', 'status', 'is_local_archive', 'remote_missing',
                'pending_action', 'cleanup_hold')


def snapshot(row):
    return {key: row[key] for key in STATE_FIELDS}


def move(ids, target):
    if target not in TARGETS:
        raise ValueError('本地邮件只能移入 MailAI 收件箱、已发送或本地归档，不会上传到服务器')
    before, after, failed = [], [], []
    with db.conn() as c:
        c.execute('BEGIN IMMEDIATE')
        for email_id in dict.fromkeys(ids):
            row = c.execute('SELECT * FROM emails WHERE id=?', (email_id,)).fetchone()
            if (not row or not row['is_local_archive'] or row['remote_missing'] or
                    row['pending_action'] or row['cleanup_hold']):
                failed.append({'id': email_id, 'error': '邮件不存在、不是本地邮件或正在处理，请刷新后重试'})
                continue
            if row['status'] == TARGETS[target]:
                continue
            old = snapshot(row)
            c.execute('UPDATE emails SET status=? WHERE id=?', (TARGETS[target], email_id))
            before.append(old)
            after.append({**old, 'status': TARGETS[target]})
    from .mail_undo import record
    token = record('local_move', before, after) if before else None
    for row in before:
        db.add_audit_log(row['id'], 'local_move', actor='user', reason='仅在 MailAI 本地整理',
                         meta={'from': row['status'], 'to': TARGETS[target]})
    return {'ok': not failed, 'completed': len(set(ids)) - len(failed), 'failed': failed,
            'local_only': True, 'undo_token': token}


def restore(before, after):
    failed = []
    with db.conn() as c:
        c.execute('BEGIN IMMEDIATE')
        for old, expected in zip(before, after):
            row = c.execute('SELECT * FROM emails WHERE id=?', (old['id'],)).fetchone()
            if not row or snapshot(row) != expected:
                failed.append({'id': old['id'], 'error': '邮件位置或状态已变化，请手动处理'})
                continue
            c.execute('UPDATE emails SET status=? WHERE id=?', (old['status'], old['id']))
    return {'ok': not failed, 'failed': failed}
