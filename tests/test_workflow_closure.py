"""Isolated behavior regressions for restore, cross-device delivery and cleanup."""
import asyncio
import base64
import json
import os
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

HOME = tempfile.TemporaryDirectory(prefix='mailai-closure-')
os.environ.update(MAILAI_HOME=HOME.name, IMAP_USER='closure@example.test', IMAP_PASSWORD='fixture',
                  IMAP_HOST='imap.example.test', SMTP_HOST='smtp.example.test',
                  SMTP_USE_IMAP_CREDENTIALS='true', LLM_API_KEY='', AUTO_OPEN_BROWSER='false')
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from fastapi import HTTPException
from app import config, db, system_settings, portable_backup, outbox, smtp_client, remote_control
from app import share_tasks, share_storage, mail_import, assistant_actions, sent_followups, task_notifications
from app.account_guard import guard
from app.remote_document_reply import draft_digest
from app.web import server
from app.web.routes import compose
from app.web.schemas import SendMailRequest

server.app.router.on_startup.clear()


def data(subject='closure', **options):
    return dict(to_addr='recipient@example.test', cc_addr='', bcc_addr='', subject=subject,
                body_html='<p>Content confirmed.</p>', attachments=[], **options)


def receipt(payload):
    return dict(message_id='<closure@example.test>', recipients=1, refused_recipients=[],
                sent_folder='Sent', warning='')


def rejects(action, message=None):
    try:
        action()
    except (ValueError, HTTPException) as error:
        if message:
            assert message in str(error), (message, str(error))
        return error
    raise AssertionError('Expected the unsafe operation to be rejected')


def restore_exclusion():
    # Pause a real import immediately before the live database swap.
    archive = portable_backup.create()
    staged = portable_backup.stage_file(portable_backup.stored_path(archive['filename']))
    entered, release = threading.Event(), threading.Event()
    original = system_settings._copy_database
    def paused_copy(source, target):
        if target == config.DB_PATH and Path(source).name == 'mailai.db' and '.mailai-import-' in source:
            entered.set()
            assert release.wait(8)
        return original(source, target)
    with TestClient(server.app, base_url='http://127.0.0.1') as client, \
            patch.object(system_settings, '_copy_database', side_effect=paused_copy), ThreadPoolExecutor(1) as pool:
        job = pool.submit(client.post, '/api/system/portable-backups/restore', json={'import_token': staged['import_token']})
        try:
            assert entered.wait(8)
            for url, payload in [('/api/drafts', data()), ('/api/mail/outbox', {**data(), 'request_token':'blocked'}),
                                 ('/api/system/portable-backups/restore', {'import_token':staged['import_token']})]:
                assert client.post(url, json=payload).status_code == 409, url
            assert client.post('/api/share-storage/tasks?draft_id=1', content=b'x').status_code == 409
            assert client.get('/api/emails').status_code == 409
            # Preferences remain writable while account data is protected.
            assert client.get('/api/ui-preferences.js').status_code == 200
        finally:
            release.set()
        assert job.result(8).status_code == 200
        assert client.post('/api/drafts', json=data('saved after restore')).status_code == 200
    print('PASS restore excludes competing writes and resumes normal saving')


def delivery_claims():
    email_id = db.upsert_email(dict(uid=100, folder='INBOX', status='inbox', verdict='clean',
                                    subject='reply source', from_addr='recipient@example.test',
                                    message_id='<original@example.test>', date=datetime.now().isoformat()))
    body = data('cross-device', reply_to_email_id=email_id, in_reply_to='<original@example.test>', mode='reply')
    body['attachments'] = [dict(filename='response.txt', size=7, data_base64=base64.b64encode(b'fixture').decode(), content_type='text/plain')]
    draft_id = db.save_draft(body)
    draft = db.get_draft(draft_id)
    queued = {**body, 'id':draft_id, 'expected_revision':draft['revision']}
    outbox.enqueue('desktop-first', queued, delay=0)
    state = {'account_id':'fixture', 'selected':email_id, 'context_at':time.time(),
             'pending':dict(draft_id=draft_id, email_id=email_id, digest=draft_digest(draft), token='AABBCCDD', expires=time.time()+600)}
    with patch.object(remote_control, '_save_session'), patch.object(smtp_client, 'send', side_effect=receipt) as smtp:
        error = rejects(lambda: remote_control._mail_command('chat', state, '确认发送 AABBCCDD', config.IMAP_USER, 'weixin'))
        assert error.status_code == 409 and smtp.call_count == 0
        outbox.process(lambda payload: compose.api_send_mail(SendMailRequest(**payload)))
        assert smtp.call_count == 1 and db.get_draft(draft_id) is None
        rejects(lambda: outbox.enqueue('late-copy', queued))
    # Opposite order: a queued send must be rejected while a direct send is in SMTP.
    draft_id = db.save_draft(body)
    revision = db.get_draft(draft_id)['revision']
    payload = {**body, 'id':draft_id, 'expected_revision':revision}
    entered, release = threading.Event(), threading.Event()
    def slow_send(value):
        entered.set(); assert release.wait(8); return receipt(value)
    with patch.object(smtp_client, 'send', side_effect=slow_send) as smtp, ThreadPoolExecutor(1) as pool:
        job = pool.submit(compose.api_send_mail, SendMailRequest(**payload))
        try:
            assert entered.wait(8)
            rejects(lambda: outbox.enqueue('desktop-after-phone', payload))
            rejects(lambda: db.save_draft(body, draft_id, strict=True))
            rejects(lambda: compose.api_send_mail(SendMailRequest(**payload)))
        finally:
            release.set()
        assert job.result(8)['ok'] and smtp.call_count == 1
    # Direct SMTP uncertainty remains durable and blocks retry until user resolution.
    draft_id = db.save_draft(body)
    with patch.object(smtp_client, 'send', side_effect=TimeoutError('fixture drop after DATA')):
        rejects(lambda: compose.api_send_mail(SendMailRequest(**body, id=draft_id)))
    uncertain = next(row for row in outbox.items() if row['draft_id'] == draft_id)
    assert uncertain['status'] == 'unknown' and outbox.draft_pending(draft_id)
    assert db.get_sent_message(uncertain['sent_record_id'])['status'] == 'unknown'
    rejects(lambda: outbox.enqueue('unsafe-retry', {**body,'id':draft_id}))
    outbox.resolve(uncertain['token'], False)
    with patch.object(smtp_client, 'send', side_effect=receipt):
        assert compose.api_send_mail(SendMailRequest(**body, id=draft_id))['ok']
    # Re-reading a changed revision cannot submit the reviewed, older draft.
    draft_id = db.save_draft(body)
    stale = {**body,'id':draft_id,'expected_revision':1}
    db.save_draft({**body,'subject':'changed'},draft_id,strict=True)
    with patch.object(smtp_client,'send') as smtp:
        rejects(lambda: compose.api_send_mail(SendMailRequest(**stale)))
        smtp.assert_not_called()
    print('PASS both send orders, stale revisions and uncertain delivery prevent duplicate SMTP')


def warning_lifecycle():
    payload = data('partial delivery')
    payload.update(to_addr='ok@example.test', cc_addr='blocked@example.test', bcc_addr='private@example.test')
    result = dict(receipt(payload), warning='Partial recipient rejection', refused_recipients=['blocked@example.test','private@example.test'])
    with patch.object(smtp_client, 'send', return_value=result):
        compose.api_send_mail(SendMailRequest(**payload))
    row = next(row for row in outbox.items() if row['subject']=='partial delivery')
    assert row['needs_attention'] and row['warning'] == result['warning']
    assert db.get_sent_message(row['sent_record_id'])['error'] == result['warning']
    retry = compose.api_refused_recipient_draft(row['token'])
    assert retry['to_addr'] == '' and retry['cc_addr'] == 'blocked@example.test'
    assert retry['bcc_addr'] == 'private@example.test' and retry['id'] is None
    assert 'ok@example.test' not in retry['to_addr']+retry['cc_addr']+retry['bcc_addr']
    # Older warnings must survive the 200-row completed-history window.
    with db.conn() as c:
        c.execute("UPDATE outbox SET created_at='2000-01-01' WHERE token=?", (row['token'],))
    for i in range(205):
        outbox.enqueue('history-'+str(i), data('history'))
        outbox.cancel('history-'+str(i))
    assert any(item['token']==row['token'] for item in outbox.items())
    outbox.acknowledge_warning(row['token'])
    assert not any(item['token']==row['token'] for item in outbox.items())
    with db.conn() as c:
        assert c.execute('SELECT warning_acknowledged FROM outbox WHERE token=?',(row['token'],)).fetchone()[0]==1
    # Upgrade an older outbox in place, retaining its previously hidden warning.
    import sqlite3
    legacy = str(Path(HOME.name)/'legacy.db')
    with closing(sqlite3.connect(legacy)) as connection, connection:
        connection.execute("CREATE TABLE outbox(token TEXT PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL,due_at TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,result TEXT DEFAULT '{}',error TEXT DEFAULT '')")
        connection.execute("INSERT INTO outbox VALUES(?,?,'sent','','','',?,'')", ('legacy',json.dumps(data()),json.dumps({'warning':'legacy warning'})))
    with patch.object(config,'DB_PATH',legacy):
        db.init_db()
        assert outbox.item('legacy')['needs_attention']
        outbox.acknowledge_warning('legacy')
        assert not outbox.item('legacy')['needs_attention']
    print('PASS persistent warnings, explicit acknowledgement and To/Cc/Bcc-safe retry preparation')


def reminder_times():
    now=datetime.now()
    original=(now+timedelta(days=1)).isoformat(timespec='seconds')
    at=(now+timedelta(days=2)).isoformat(timespec='seconds')
    outbox.enqueue('schedule',dict(data(),send_at=original,followup_at=at))
    rejects(lambda:outbox.reschedule('schedule',at))
    rejects(lambda:outbox.reschedule('schedule',(now+timedelta(days=3)).isoformat()))
    row=next(row for row in outbox.items() if row['token']=='schedule')
    assert row['due_at']==original
    outbox.reschedule('schedule',(now+timedelta(hours=2)).isoformat())
    sent=db.create_sent_message(data('late send'))
    db.finish_sent_message(sent,ok=True,message_id='<late@example.test>')
    rejects(lambda:sent_followups.register(sent,at=(now-timedelta(days=1)).isoformat()))
    assert not any(item['sent_id']==sent for item in sent_followups.items())
    monday=datetime(2026,10,12)
    for day in range(7):
        today=monday+timedelta(days=day)
        class FixedDateTime(datetime):
            @classmethod
            def now(cls):return today
        with patch.object(assistant_actions,'datetime',FixedDateTime):
            for target,label in enumerate('一二三四五六日'):
                expected=(monday+timedelta(days=7+target)).date().isoformat()
                for word in ('下周','下星期'):
                    assert assistant_actions._parse_deadline(word+label+'提交')==expected
    # Late execution saves a durable warning, rather than an immediate reminder.
    queued=dict(data('delayed follow-up'),followup_at=at)
    outbox.enqueue('late-execution',queued,delay=0)
    original_finish=db.finish_sent_message
    def late_finish(record_id,**options):
        original_finish(record_id,**options)
        with db.conn() as connection:
            connection.execute('UPDATE sent_messages SET sent_at=? WHERE id=?',((now+timedelta(days=3)).isoformat(),record_id))
    with patch.object(smtp_client,'send',side_effect=receipt),patch.object(db,'finish_sent_message',side_effect=late_finish):
        outbox.process(lambda payload:compose.api_send_mail(SendMailRequest(**payload)))
    late=outbox.item('late-execution')
    assert late['status']=='sent' and late['needs_attention'] and late['warning']
    assert not any(row['sent_id']==late['sent_record_id'] for row in sent_followups.items())
    print('PASS reschedule rollback, delayed-send reminder bounds and 98 next-week combinations')


class Request:
    headers={'content-length':'7','x-mailai-filename':'private.zip'}
    async def stream(self):yield b'private'


async def canceled_upload():
    draft=db.save_draft(data('upload'))
    staged=await share_tasks.stage(Request(),draft,7)
    with patch('app.account_guard.threading.Thread.start',side_effect=RuntimeError('fixture start failure')):
        try:await share_tasks.upload(staged['id'])
        except RuntimeError:pass
        else:raise AssertionError('Expected thread-start failure')
    assert share_tasks.list_tasks(draft)[0]['state']=='failed'
    assert not share_tasks._active
    assert guard.acquire(True)
    guard.release(True)
    entered, release=threading.Event(),threading.Event()
    def slow(*args,**kwargs):
        entered.set();assert release.wait(8)
        return dict(url='https://example.test/file',expires_at='2099-01-01T00:00:00Z')
    with patch.object(share_storage,'_upload_file',side_effect=slow):
        caller=asyncio.create_task(share_tasks.upload(staged['id']))
        try:
            while not entered.is_set():await asyncio.sleep(.01)
            caller.cancel()
            try:await caller
            except asyncio.CancelledError:pass
            assert not guard.acquire(True), 'Canceled HTTP must not release the still-writing upload'
        finally:
            release.set()
        while share_tasks._workers:await asyncio.sleep(.01)
    deadline=time.monotonic()+2
    while not guard.acquire(True):
        assert time.monotonic()<deadline
        await asyncio.sleep(.01)
    guard.release(True)
    assert share_tasks.list_tasks(draft)[0]['state']=='done'
    print('PASS canceled upload keeps maintenance exclusion through actual worker completion')



def queued_backup_removal():
    from app import automatic_backup
    path=Path(HOME.name)/'backup-source.db'
    raw=Path(HOME.name)/'backup-source-raw';raw.mkdir()
    path.write_bytes(b'fixture')
    accounts={'a':dict(db_path=str(path),raw_dir=str(raw),user='a@example.test',host='imap.example.test')}
    with patch.object(system_settings,'_load_registry',side_effect=[{'accounts':accounts},{'accounts':{}}]), \
            patch.object(automatic_backup,'_automatic_files',return_value=[]), \
            patch.object(system_settings,'create_backup') as create:
        automatic_backup.run_due()
        create.assert_not_called()
    print('PASS queued automatic backup revalidates account removal before writing')


def cleanup_account():
    key=system_settings._account_key(config.IMAP_HOST,config.IMAP_USER)
    root=Path(system_settings.ACCOUNTS_DIR)/key
    root.mkdir(parents=True,exist_ok=True)
    account=dict(user=config.IMAP_USER,host=config.IMAP_HOST,db_path=str(root/'mailai.db'),raw_dir=str(root/'raw'))
    Path(account['raw_dir']).mkdir(exist_ok=True)
    with patch.multiple(config,DB_PATH=account['db_path'],RAW_DIR=account['raw_dir']):
        db.init_db()
        system_settings._save_registry({'accounts':{key:account},'last_account':key})
        draft=db.save_draft(data('cleanup'))
        task=asyncio.run(share_tasks.stage(Request(),draft,7))
        staged_share=share_tasks._path(task['id'])/'file'
        job=mail_import.create('private old mail',1)
        upload_key,source,name=mail_import.begin_upload(job['token'],'private.eml')
        source.write_bytes(b'private mail')
        mail_import.finish_upload(job['token'],upload_key,name,12);mail_import.end_upload(job['token'])
        # Independent account staging must remain intact.
        other=root.parent/'other.db.share-uploads';other.mkdir();(other/'keep').write_text('other account')
        with patch('app.credential_store.delete'):
            assert system_settings.logout_mail(clear_history=True,account_id=key)['history_cleared']
        assert not Path(account['db_path']).exists()
        assert not staged_share.exists() and not source.exists()
        assert (other/'keep').read_text()=='other account'
    print('PASS account removal clears both staging stores and preserves other accounts')


def main():
    db.init_db()
    restore_exclusion()
    delivery_claims()
    warning_lifecycle()
    reminder_times()
    asyncio.run(canceled_upload())
    cleanup_account()
    queued_backup_removal()


if __name__=='__main__':
    try:main()
    finally:HOME.cleanup()
