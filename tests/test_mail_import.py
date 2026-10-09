"""Offline client-mail import integrity, recovery and account-isolation checks."""
import mailbox
from io import BytesIO
import asyncio
import csv
import sys
import tempfile
from contextlib import contextmanager
from email.message import EmailMessage
from email import policy
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import config, db, mail_import as imp, parser
from app.account_context import use


def message(mid='old@example.test', body='历史邮件：请查收。', attachment=True):
    msg = EmailMessage()
    msg['From'] = '旧同事 <old@example.test>'
    msg['To'] = 'work@example.test'
    msg['Subject'] = '历史项目资料'
    msg['Date'] = 'Fri, 01 Jan 1993 09:30:00 +0800'
    if mid: msg['Message-ID'] = '<' + mid + '>'
    msg.set_content(body)
    if attachment: msg.add_attachment(b'\x00\xfforiginal attachment\r\n', maintype='application', subtype='octet-stream', filename='项目资料.bin')
    return msg.as_bytes(policy=policy.SMTP)


@contextmanager
def fixture():
    with tempfile.TemporaryDirectory() as root, patch.object(config, 'DATA_DIR', root):
        def account(name):
            return use(dict(ACCOUNT_ID=name, IMAP_USER=name+'@example.test',
                            DB_PATH=str(Path(root, name+'.db')), RAW_DIR=str(Path(root, name+'-raw'))))
        with account('work'): db.init_db()
        with account('personal'): db.init_db()
        yield Path(root), account


def upload(token, name, raw):
    key, target, name = imp.begin_upload(token, name)
    try:
        target.write_bytes(raw)
        return imp.finish_upload(token, key, name, len(raw))
    finally: imp.end_upload(token)


def scan(token):
    imp._update(token, phase='scan', state='scanning', cancel=False)
    imp._run(token, 'scan')
    return imp.status(token)


def apply(token):
    imp._update(token, phase='import', state='importing', cancel=False)
    imp._run(token, 'import')
    return imp.status(token)


def count():
    with db.conn() as c: return c.execute('SELECT COUNT(*) FROM emails').fetchone()[0]


def raises(function, *args):
    try: function(*args)
    except ValueError: return
    raise AssertionError('Expected invalid operation to fail')


def test_round_trip_and_dedup():
    with fixture() as (root, account), account('work'):
        raw = message()
        job = imp.create('Foxmail 历史', 3); token = job['token']
        upload(token, '收件箱/原件.eml', raw)
        # LF/CRLF and added transport headers must not duplicate an export.
        equivalent = b'Received: by export.example.test\n' + raw.replace(b'\r\n', b'\n')
        assert imp.signature(raw)[1] == imp.signature(equivalent)[1]
        upload(token, '收件箱/重复.EML', equivalent)
        boxpath = root/'sent.mbox'; box = mailbox.mbox(boxpath)
        box.add(BytesIO(message('sent@example.test'))); box.add(BytesIO(raw)); box.close()
        upload(token, '已发送.mbox', boxpath.read_bytes())
        result = scan(token)
        assert (result['found'], result['new'], result['duplicates'], result['failed']) == (4,2,2,0), result
        assert result['folder_count'] == 2
        assert {row['name']:row['count'] for row in result['folders']} == {'收件箱':1,'已发送':1}
        assert count() == 0, 'Preview must not insert mail'
        result = apply(token)
        assert result['state'] == 'completed' and result['imported'] == 2, result
        rows = db.list_emails(status='local_archive', days=365000)
        assert len(rows) == 2 and {r['folder'] for r in rows} == {'LOCAL_IMPORT/Foxmail 历史/收件箱','LOCAL_IMPORT/Foxmail 历史/已发送'}
        for row in rows:
            assert row['uid'] < 0 and row['is_local_archive'] == row['is_read'] == row['notification_sent'] == row['processing_complete'] == 1
            assert row['arrival_kind'] == 'history' and row['pending_action'] == ''
            assert '历史邮件' in row['body_text'] and row['date'].startswith('1993')
            assert parser.extract_attachment(row['raw_path'], 0)['payload'] == b'\x00\xfforiginal attachment\r\n'
            assert db.reconcile_folder(row['folder'], []) == 0
        assert not (imp._path(token)/'messages').exists(), 'Successful staging must be cleaned'
        repeated = imp.create()['token']; upload(repeated, 'again.eml', equivalent)
        assert scan(repeated)['new'] == 0 and imp.status(repeated)['duplicates'] == 1
        assert count() == 2
        # Same Message-ID, different body: retain both; absent ID also supported.
        changed = imp.create()['token']; upload(changed,'changed.eml',message(body='内容不同'))
        assert scan(changed)['new'] == 1; assert apply(changed)['imported'] == 1
        no_id = imp.create()['token']; raw_no_id = message(mid=None)
        upload(no_id,'no-id.eml',raw_no_id); assert scan(no_id)['new'] == 1; apply(no_id)
        no_id2 = imp.create()['token']; upload(no_id2,'same.eml',raw_no_id)
        assert scan(no_id2)['duplicates'] == 1
        with account('personal'):
            raises(imp.status, token)
            assert not imp.history() and count() == 0
            independent = imp.create()['token']; upload(independent,'own.eml',raw)
            assert scan(independent)['new'] == 1 and apply(independent)['imported'] == 1
        assert count() == 4, 'Import must stay in selected account'


def test_interruption_retry_and_live_dedup():
    with fixture() as (root, account), account('work'):
        token = imp.create()['token']
        upload(token,'1.eml',message('one')); upload(token,'2.eml',message('two'))
        scan(token)
        real_insert = imp._insert
        def stop_after_one(*args):
            result = real_insert(*args)
            imp._update(token, cancel=True)
            return result
        imp._update(token, phase='import', state='importing', cancel=False)
        with patch.object(imp,'_insert',side_effect=stop_after_one): imp._run(token,'import')
        assert imp.status(token)['state'] == 'paused' and count() == 1
        assert apply(token)['imported'] == 2 and count() == 2
        # A candidate failing to write can be retried; prior successful rows stay.
        retry = imp.create()['token']; upload(retry,'3.eml',message('three')); upload(retry,'4.eml',message('four'))
        scan(retry)
        def disk_failure(token,item,raw):
            if item['key'] == '00000001.eml': raise OSError('disk full')
            return real_insert(token,item,raw)
        with patch.object(imp,'_insert',side_effect=disk_failure): result = apply(retry)
        assert result['state'] == 'failed' and result['imported'] == 1 and result['failed'] == 1
        with open(imp.report(retry), encoding='utf-8-sig', newline='') as report:
            rows=list(csv.DictReader(report))
        assert len(rows) == 1 and rows[0]['阶段'] == '导入' and rows[0]['文件或邮件'] == '4.eml'
        result = apply(retry)
        assert result['state'] == 'completed' and result['imported'] == 2 and result['failed'] == 0 and count() == 4
        with open(imp.report(retry), encoding='utf-8-sig', newline='') as report:
            assert list(csv.DictReader(report)) == [], 'Resolved write failures must not remain in current report'
        live = imp.create()['token']; raw = message('live')
        upload(live,'live.eml',raw); assert scan(live)['new'] == 1
        # Server download arrives between preview and apply.
        parsed = parser.parse_message(100, raw, save_raw=True); parsed['status']='inbox'; db.upsert_email(parsed)
        result = apply(live)
        assert result['imported'] == 0 and result['duplicates'] == 1 and count() == 5
        # Restarted partial scan cannot be mistaken for a complete preview.
        partial = imp.create()['token']; upload(partial,'partial.eml',message('partial'))
        (imp._path(partial)/'plan.jsonl').write_text('{}\n')
        imp._update(partial, phase='scan', state='scanning')
        assert imp.status(partial)['state'] == 'paused'
        raises(imp.start, partial, 'import')
        queued = []
        with patch.object(imp,'start_account_thread',side_effect=lambda target,**kw: queued.append(target)):
            imp.start(partial,'scan'); imp.start(partial,'scan')
            assert len(queued) == 1
            raises(imp.discard, partial)
        queued[0]()
        assert imp.status(partial)['state'] == 'ready'


def test_invalid_inputs_and_forwarded_identity():
    with fixture() as (_, account), account('work'):
        token = imp.create(expected_files=2)['token']
        for name in ('../a.eml','/a.eml','C:/a.eml','Storage.fox','a\x00.eml'):
            raises(imp.begin_upload, token, name)
        upload(token,'one.eml',message())
        raises(imp.start,token,'scan')
        upload(token,'broken.eml',b'not an email')
        result = scan(token)
        assert result['new'] == 1 and result['failed'] == 1 and result['errors'][0]['file'] == 'broken.eml'
        assert apply(token)['imported'] == 1
        with patch.object(imp,'MAX_MESSAGE_SIZE',10): raises(imp.signature,message())
        # Missing originals must be reported instead of duplicating by ID.
        db.upsert_email(dict(uid=5,folder='INBOX',message_id='<missing>',subject='cached only'))
        missing = imp.create()['token']; upload(missing,'missing.eml',message('missing'))
        result = scan(missing)
        assert result['duplicates'] == 1 and result['errors'] and result['new'] == 0
        embedded1 = EmailMessage(); embedded1['From']='a@example.test'; embedded1['Subject']='first'; embedded1.set_content('same')
        embedded2 = EmailMessage(); embedded2['From']='a@example.test'; embedded2['Subject']='second'; embedded2.set_content('same')
        def forwarded(inner):
            outer=EmailMessage(); outer['From']='a@example.test'; outer['Subject']='forward'; outer.set_content('see attached')
            outer.add_attachment(inner,filename='forward.eml'); return outer.as_bytes()
        assert imp.signature(forwarded(embedded1))[1] != imp.signature(forwarded(embedded2))[1]
        # Named text attachments are byte-exact, including meaningful trailing newlines.
        def text_attachment(payload):
            mail=EmailMessage(); mail['From']='a@example.test'; mail['Message-ID']='<attachment>'
            mail.set_content('same body'); mail.add_attachment(payload,filename='data.txt')
            return mail.as_bytes()
        assert imp.signature(text_attachment('first\n'))[1] != imp.signature(text_attachment('first\n\n'))[1]
        # Unexpected third-party MIME parser errors affect only that record.
        malformed=imp.create()['token']; upload(malformed,'malformed.eml',message('malformed'))
        upload(malformed,'okay.eml',message('okay'))
        original_parse=parser.parse_message
        def bad_mime(uid,raw,**kwargs):
            if b'<malformed>' in raw: raise RuntimeError('malformed MIME')
            return original_parse(uid,raw,**kwargs)
        with patch.object(parser,'parse_message',side_effect=bad_mime): result=scan(malformed)
        assert result['state'] == 'ready' and result['new'] == result['failed'] == 1
        # A partial raw write cannot leave a row or an orphan .eml.
        failure = imp.create()['token']; raw = message('failed-write'); upload(failure,'fail.eml',raw); scan(failure)
        original_write = Path.write_bytes
        def bad_write(path,data):
            if path.parent.name == 'client-import':
                original_write(path,b'partial'); raise OSError('disk full')
            return original_write(path,data)
        before = count()
        with patch.object(Path,'write_bytes',bad_write): assert apply(failure)['state'] == 'failed'
        assert count() == before
        with db.conn() as c: referenced = {r[0] for r in c.execute("SELECT raw_path FROM emails WHERE raw_path != ''")}
        assert {str(p) for p in Path(config.RAW_DIR,'client-import').glob('*.eml')} == referenced


def test_upload_disconnect_and_limits():
    from fastapi import HTTPException
    from starlette.requests import ClientDisconnect
    from app.web.routes.mail_import import api_mail_import_upload
    class Request:
        def __init__(self, chunks, disconnect=False): self.chunks, self.disconnect = chunks, disconnect
        async def stream(self):
            for chunk in self.chunks: yield chunk
            if self.disconnect: raise ClientDisconnect()
    with fixture() as (_, account), account('work'):
        token = imp.create(expected_files=1)['token']
        for request, limit in ((Request([b'partial'], True), 1024), (Request([b'x'*33]), 32)):
            with patch.object(imp, 'MAX_MESSAGE_SIZE', limit):
                try: asyncio.run(api_mail_import_upload(token, request, 'old.eml'))
                except HTTPException as exc: assert exc.status_code == 400
                else: raise AssertionError('Invalid upload accepted')
            job = imp.status(token)
            assert job['state'] == 'collecting' and job['files'] == job['bytes'] == 0
            assert list((imp._path(token)/'sources').iterdir()) == [], 'Partial uploads must be removed'
        raw = message('valid-upload')
        result = asyncio.run(api_mail_import_upload(token, Request([raw[:100], raw[100:]]), '收件箱/old.eml'))
        assert result['files'] == 1 and result['bytes'] == len(raw)
        assert scan(token)['new'] == 1 and apply(token)['imported'] == 1


def test_duplicate_progress_and_complete_reports():
    with fixture() as (root, account), account('work'):
        raw = message('already-imported')
        first = imp.create()['token']; upload(first,'first.eml',raw); scan(first); apply(first)
        path=root/'large.mbox'; box=mailbox.mbox(path)
        for _ in range(75): box.add(BytesIO(raw))
        for _ in range(70): box.add(BytesIO(b'not a valid email'))
        box.close()
        token=imp.create('=危险名称')['token']; upload(token,'+核对.mbox',path.read_bytes())
        progress=[]; original_update=imp._update
        def record_progress(token,**fields):
            progress.append(dict(fields)); return original_update(token,**fields)
        with patch.object(imp,'_update',side_effect=record_progress): result=scan(token)
        assert (result['found'], result['new'], result['duplicates'], result['failed']) == (145,0,75,70)
        assert any(row.get('source_processed')==25 and row.get('duplicates')==25 and row.get('source_total')==145 for row in progress)
        assert result['issue_count'] == 70 and len(result['errors']) == 30
        report=Path(imp.report(token)); assert report.read_bytes().startswith(b'\xef\xbb\xbf')
        with report.open(encoding='utf-8-sig',newline='') as stream: rows=list(csv.DictReader(stream))
        assert len(rows) == 70 and all(row['类型']=='未导入' for row in rows)
        assert all(row['文件或邮件'].startswith("'+") and row['归档名称'].startswith("'=") for row in rows)
        assert rows[-1]['文件或邮件'].endswith('第 145 封'), 'All issues must remain available after preview cap/cleanup'
        with account('personal'): raises(imp.report,token)
        imp._active.add(str(imp._path(token)))
        try: raises(imp.report,token)
        finally: imp._active.discard(str(imp._path(token)))

        # Warnings for missing originals are distinct from corrupt-file failures.
        db.upsert_email(dict(uid=10,folder='INBOX',message_id='<raw-missing>'))
        warning=imp.create()['token']; upload(warning,'missing.eml',message('raw-missing')); result=scan(warning)
        assert result['issue_count']==1 and result['failed']==0 and result['errors'][0]['kind']=='warning'
        with open(imp.report(warning),encoding='utf-8-sig',newline='') as stream:
            assert list(csv.DictReader(stream))[0]['类型']=='请核对'


if __name__ == '__main__':
    # mailbox.add(bytes) replaces LF with os.linesep without stripping CR.
    # Use streams for valid exports and exercise Windows CRLF on every runner.
    for separator in (b'\n', b'\r\n'):
        with patch.object(mailbox, 'linesep', separator):
            test_round_trip_and_dedup()
            test_duplicate_progress_and_complete_reports()
    test_interruption_retry_and_live_dedup()
    test_invalid_inputs_and_forwarded_identity()
    test_upload_disconnect_and_limits()
    print('Client mail import: MIME/attachments, dedup, account isolation, pause/retry, concurrent sync and invalid inputs passed')
