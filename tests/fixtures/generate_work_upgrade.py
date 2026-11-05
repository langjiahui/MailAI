"""Generate synthetic upgrade fixtures with an exported v4.1.1 app tree.

Usage: python tests/fixtures/generate_work_upgrade.py /tmp/v4.1.1-source
The source must be exported from eb730abe9a7941ee20d06a2eaf5dee7bd3908098.
No network, mailbox credentials or real user data are used.
"""
import base64
import gzip
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

DESTINATION = Path(__file__).resolve().parent
sys.path.insert(0, str(Path(sys.argv[1]).resolve()))

with tempfile.TemporaryDirectory() as temporary:
    os.environ['MAILAI_HOME'] = temporary
    from app import config, db, companion_growth as growth, task_planner, outbox
    from app.account_context import use

    root = Path(temporary)
    account = dict(ACCOUNT_ID='upgrade', DB_PATH=str(root/'mailai.db'),
                   RAW_DIR=str(root/'raw'), IMAP_USER='me@example.test')
    attachment = base64.b64encode(b'synthetic attachment\x00\xff').decode()
    files = [dict(filename='legacy.bin', data_base64=attachment, content_type='application/octet-stream')]
    now = datetime(2026, 11, 5, 10, tzinfo=timezone(timedelta(hours=8)))
    with patch.object(config, 'DATA_DIR', temporary), use(account), patch.object(growth, '_now', return_value=now):
        db.init_db()
        for uid, folder, subject in ((1, 'INBOX', '项目排期'), (2, 'INBOX', '本地导入'), (3, 'Sent', '历史发送')):
            email_id = db.upsert_email(dict(uid=uid, folder=folder,
                message_id=f'<legacy-{uid}@example.test>', subject=subject,
                from_addr='colleague@example.test', to_addr='me@example.test',
                date='2026-11-04T09:00:00', body_text='请确认排期并提交附件。',
                attachments=files, status='inbox', raw_path=f'raw/legacy-{uid}.eml'))
            db.set_mail_state(email_id, is_read=True, is_starred=True)
        with db.conn() as c:
            c.execute('UPDATE emails SET is_local_archive=1 WHERE id=2')
            c.execute('UPDATE emails SET is_favorite=1 WHERE id=1')
        db.add_todos(1, [dict(title='人工修改的等待任务', deadline='2099-01-02'), dict(title='已完成任务')], user_edited=True)
        task_planner.save(todo_id=1, stage='waiting', remind_at='2099-01-01T09:00:00')
        db.set_todo_status(2, 'done')
        db.save_contact('colleague@example.test', name='人工姓名', company='合成单位',
                        note='保留联系人备注', favorite=True, group_name='项目组')
        db.set_runtime_setting('work_writing_preferences', json.dumps({'style': '结论在前'}, ensure_ascii=False))
        db.set_runtime_setting('synthetic_upgrade_preference', '保留原值')
        draft = db.save_draft(dict(to_addr='colleague@example.test', subject='未发送草稿',
            body_html='<p>保留草稿正文</p>', attachments=files, mode='reply', reply_to_email_id=1,
            in_reply_to='<legacy-1@example.test>', references='<legacy-1@example.test>'))
        outbox.enqueue('legacy-pending', dict(id=draft, expected_revision=1,
            to_addr='colleague@example.test', subject='未发送草稿', body_html='<p>保留草稿正文</p>',
            attachments=files, send_at=(datetime.now() + timedelta(days=90)).isoformat(timespec='seconds')))
        sent = db.create_sent_message(dict(to_addr='colleague@example.test', from_addr='me@example.test',
            subject='已发送记录', body_html='<p>保留发送记录</p>', attachments=files, reply_to_email_id=1,
            in_reply_to='<legacy-1@example.test>'))
        # This marks a synthetic DB record only; no SMTP client is called.
        db.finish_sent_message(sent, ok=True, message_id='<synthetic-sent@example.test>')
        with growth.connection() as c:
            c.execute('UPDATE companion_profile SET xp=1200,stamps=321,earned=801,style=?,equipped=? WHERE id=1',
                      ('ranger', json.dumps({'head':'cap','neck':'scarf','palette':'sky','theme':'theme_baowu'})))
            c.executemany('INSERT OR IGNORE INTO companion_inventory VALUES(?,?)',
                          [(item, '2026-11-04T09:00:00') for item in ('cap','scarf','sky','theme_baowu')])
            c.execute('INSERT INTO companion_gifts VALUES(?,?,?,?,?,?)',
                      ('legacy-gift', 'synthetic-receipt', '旧礼物', '["scarf"]', 'me@example.test', '2026-11-04T09:00:00'))
            c.execute('INSERT INTO companion_purchases VALUES(?,?,?,?,?)',
                      ('legacy-purchase', 'sky', 120, 0, '2026-11-04T09:00:00'))
            c.execute('INSERT OR REPLACE INTO companion_days VALUES(?,?,?,?,?)',
                      ('2026-11-04', '{"active":600}', '["focus"]', 55, 28))
        hashes = {}
        for name in ('mailai.db', 'companion.sqlite3'):
            snapshot = root/('snapshot-' + name)
            with sqlite3.connect(root/name) as source, sqlite3.connect(snapshot) as target:
                source.backup(target)
            payload = snapshot.read_bytes()
            destination = DESTINATION/('work-upgrade-4.1.1-' + name + '.gz')
            destination.write_bytes(gzip.compress(payload, mtime=0))
            hashes[destination.name] = hashlib.sha256(payload).hexdigest()
        (DESTINATION/'work-upgrade-4.1.1.json').write_text(json.dumps(dict(
            version='4.1.1', commit='eb730abe9a7941ee20d06a2eaf5dee7bd3908098',
            synthetic=True, uncompressed_sha256=hashes), indent=2) + '\n')
