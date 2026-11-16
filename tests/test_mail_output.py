"""Single-mail output preserves MIME content without active or remote resources."""
from email.message import EmailMessage
import io
from pathlib import Path
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from PIL import Image
from lxml import html
from app import config, db, parser
from app import mail_output
from app.account_context import use
from app.desktop_mail_output import MailOutputStore
from fastapi.testclient import TestClient
from app.web.server import app


def fixture(directory, uid=1):
    image = io.BytesIO()
    Image.new('RGB', (20, 20), '#28705a').save(image, format='PNG')
    message = EmailMessage()
    message['From'] = '原始发件人 <sender@example.test>'
    message['To'] = 'Recipient <reader@example.test>'
    message['Cc'] = 'Copy <copy@example.test>'
    message['Subject'] = '采购 / 项目: 打印与分享'
    message['Date'] = 'Mon, 16 Nov 2026 10:20:30 +0800'
    message['Bcc'] = 'private@example.test'
    message['X-Internal-Test'] = 'original-headers-preserved'
    message.set_content('完整正文\n历史引用也要保留\n金额 123.45')
    message.add_alternative('''<html><head><style>body{display:none}</style></head><body>
      <p onclick="alert(1)">完整正文</p><details><summary>历史引用</summary><p>历史引用也要保留</p></details>
      <table width="1800"><tr><th>金额</th><th>说明</th></tr><tr><td>123.45</td><td>需要完整保留</td></tr></table>
      <img src="cid:logo"><img src="https://remote.example.test/tracker.png" alt="外部图片">
      <img src="/api/emails/999/inline/0"><img src="file:///etc/passwd">
      <a href="javascript:alert(1)">危险链接</a><a href="https://example.test/details">详情</a>
      <script>window.EMAIL_EXECUTED=true</script><form><input value="secret"></form>
      <iframe src="https://remote.example.test/frame"></iframe>
      <div style="background-image:url(https://remote.example.test/css);position:fixed;color:red">安全样式</div>
    </body></html>''', subtype='html')
    message.get_payload()[-1].add_related(image.getvalue(), maintype='image', subtype='png', cid='<logo>')
    message.add_attachment(b'synthetic attachment', maintype='application', subtype='octet-stream', filename='report.txt')
    raw = message.as_bytes()
    path = Path(directory) / f'{uid}.eml'
    path.write_bytes(raw)
    row = parser.parse_message(uid, raw, save_raw=False)
    row['raw_path'] = str(path)
    row['summary'] = 'AI summary MUST NOT be exported'
    row['from_name'] = '本地通讯录别名'
    return db.upsert_email(row), raw


class MailOutputTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.preference = patch.object(config, 'DB_PATH', str(Path(self.folder.name)/'mail.db'))
        self.preference.start()
        self.addCleanup(self.preference.stop)
        db.init_db()
        self.id, self.raw = fixture(self.folder.name)

    def test_inert_self_contained_document_and_full_text(self):
        result = mail_output.snapshot(self.id)
        doc = html.fromstring(result['document'])
        self.assertEqual(len(doc.xpath('//img')), 1)
        self.assertTrue(doc.xpath('//img/@src')[0].startswith('data:image/png;base64,'))
        self.assertFalse(doc.xpath('//script|//form|//iframe|//input'))
        self.assertFalse(doc.xpath('//*[@onclick]'))
        self.assertFalse(doc.xpath('//a[starts-with(@href,"javascript:")]'))
        self.assertIn('color:red', result['document'])
        self.assertNotIn('position:fixed', result['document'])
        self.assertNotIn('remote.example.test', result['document'])
        self.assertTrue(doc.xpath('//details[@open]'))
        for content in ('完整正文', '历史引用也要保留', '123.45', 'report.txt', '原始发件人', 'Copy <copy@example.test>'):
            self.assertIn(content, doc.text_content())
            self.assertIn(content, result['text'])
        for private in ('AI summary MUST NOT', '本地通讯录别名', 'private@example.test', 'original-headers-preserved'):
            self.assertNotIn(private, result['document'])
            self.assertNotIn(private, result['text'])
        self.assertEqual(mail_output.original(self.id)[0].read_bytes(), self.raw)

    def test_cache_fallback_missing_body_and_filename(self):
        mail_output.original(self.id)[0].unlink()
        result = mail_output.snapshot(self.id, 'en')
        self.assertFalse(result['has_raw'])
        self.assertIn('Using the cached body', result['notes'][-1])
        with self.assertRaises(FileNotFoundError): mail_output.original(self.id)
        empty = db.upsert_email(dict(uid=77, subject='headers only'))
        with self.assertRaises(ValueError): mail_output.snapshot(empty)
        blank = db.upsert_email(dict(uid=78, subject='Empty body is legitimate',body_text='',attachments=[{'name':'document.pdf','size':123}]))
        self.assertIn('document.pdf',mail_output.snapshot(blank)['document'])
        self.assertEqual(mail_output.filename('CON', '.pdf'), '_CON.pdf')
        name = mail_output.filename('../../主题\n\u202efile', '.eml')
        self.assertNotIn('/', name)
        self.assertNotIn('\n', name)
        self.assertNotIn('\u202e', name)

    def test_sent_and_incoming_ids_are_distinct_sources(self):
        sent = db.create_sent_message(dict(from_addr='me@example.test',to_addr='recipient@example.test',
            subject='Outgoing snapshot only',body_html='<p>Sent body only</p>',attachments=[]))
        output = mail_output.snapshot(sent, source='sent')
        self.assertIn('Sent body only',output['text'])
        self.assertNotIn('完整正文',output['text'])
        self.assertFalse(output['has_raw'])
        self.assertNotIn('bcc',output['document'])
        with self.assertRaises(FileNotFoundError): mail_output.original(sent, source='sent')

    def test_html_only_original_wins_over_stale_cached_text(self):
        raw=EmailMessage()
        raw['Subject']='HTML only'
        raw.set_content('<p>完整 HTML 原文</p><blockquote>历史引用也完整</blockquote>',subtype='html')
        path=Path(self.folder.name)/'html-only.eml'
        path.write_bytes(raw.as_bytes())
        item=db.upsert_email(dict(uid=88,subject='HTML only',raw_path=str(path),body_text='stale cached fragment'))
        text=mail_output.snapshot(item)['text']
        self.assertIn('完整 HTML 原文',text)
        self.assertIn('历史引用也完整',text)
        self.assertNotIn('stale cached fragment',text)

    def test_repeated_inline_images_count_towards_output_limit(self):
        import base64
        image = io.BytesIO()
        Image.new('RGB', (20, 20), '#28705a').save(image, format='PNG')
        source = 'data:image/png;base64,' + base64.b64encode(image.getvalue()).decode('ascii')
        markup = f'<img src="{source}"><img src="{source}" alt="Second copy">'
        with patch.object(mail_output, 'MAX_IMAGES', image.tell()+2):
            body, omitted = mail_output._body(markup, {'id': 1})
        self.assertEqual(omitted, 1)
        self.assertEqual(body.count('data:image/png;base64,'), 1)
        self.assertIn('Second copy', body)

    def test_http_export_account_isolation_and_original_bytes(self):
        a = dict(ACCOUNT_ID='output-a', DB_PATH=config.DB_PATH, RAW_DIR=self.folder.name)
        b = dict(ACCOUNT_ID='output-b', DB_PATH=str(Path(self.folder.name)/'b.db'), RAW_DIR=self.folder.name)
        with use(b):
            db.init_db()
            other = db.upsert_email(dict(uid=1, subject='Account B only', body_text='Other account body'))
        snapshots = {'output-a':a,'output-b':b}
        # Do not enter the production lifespan: it initializes the desktop's
        # preferred account. Only the fixture-scoped HTTP middleware is needed.
        client=TestClient(app,base_url='http://127.0.0.1')
        self.addCleanup(client.close)
        with patch('app.account_context.snapshot', side_effect=lambda key:snapshots[key]):
            response = client.get(f'/api/emails/{self.id}/original', headers={'X-MailAI-Account':'output-a'})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.content, self.raw)
            self.assertEqual(response.headers['cache-control'], 'no-store')
            self.assertIn('attachment;', response.headers['content-disposition'])
            output = client.get(f'/api/emails/{other}/output', headers={'X-MailAI-Account':'output-b'}).json()
            self.assertIn('Other account body', output['text'])
            self.assertNotIn('完整正文', output['text'])
            denied = client.get(f'/api/emails/{self.id}/original', headers={'Origin':'https://outside.example.test','X-MailAI-Account':'output-a'})
            self.assertEqual(denied.status_code,403)
            self.assertEqual(client.get('/api/emails/9999/output', headers={'X-MailAI-Account':'output-a'}).status_code,404)
            self.assertEqual(client.get(f'/api/emails/{self.id}/original?revision=invalid',headers={'X-MailAI-Account':'output-a'}).status_code,422)
            with patch('app.browser_mail_pdf.render_pdf', return_value=b'%PDF-1.4 fixture') as render:
                pdf = client.get(f'/api/emails/{other}/pdf', headers={'X-MailAI-Account':'output-b'})
                self.assertEqual(pdf.status_code, 200)
                self.assertEqual(pdf.content, b'%PDF-1.4 fixture')
                self.assertEqual(pdf.headers['content-type'], 'application/pdf')
                self.assertEqual(pdf.headers['cache-control'], 'no-store')
                self.assertIn('Other account body', render.call_args.args[0])
                self.assertNotIn('完整正文', render.call_args.args[0])
                denied_pdf = client.get(f'/api/emails/{self.id}/pdf', headers={
                    'Origin':'https://outside.example.test','X-MailAI-Account':'output-a',
                })
                self.assertEqual(denied_pdf.status_code, 403)
                render.assert_called_once()
            captured=client.get(f'/api/emails/{self.id}/output',headers={'X-MailAI-Account':'output-a'}).json()
            revision=captured['original_revision']
            path,_=mail_output.original(self.id)
            path.write_bytes(b'A different original replaced this path')
            changed=client.get(f'/api/emails/{self.id}/original?revision={revision}',headers={'X-MailAI-Account':'output-a'})
            self.assertEqual(changed.status_code,409)

    def test_native_capability_pins_identity_and_rejects_changed_original(self):
        runtime = types.SimpleNamespace(window=types.SimpleNamespace(create_file_dialog=lambda *args,**kw:None))
        store = MailOutputStore(runtime)
        self.addCleanup(store.storage.cleanup)
        a = dict(ACCOUNT_ID='output-a', DB_PATH=config.DB_PATH, RAW_DIR=self.folder.name)
        with patch('app.account_context.snapshot', return_value=a):
            data = store.prepare(self.id, 'output-a')
        token = data['token']
        self.assertEqual(store.file(token,'eml')[0].read_bytes(),self.raw)
        # Local contact/account changes cannot replace the captured document.
        with patch('app.mail_output.snapshot', side_effect=AssertionError('must use the captured document')):
            with patch('app.desktop_mail_output.render_pdf', side_effect=lambda doc,path:path.write_bytes(b'%PDF-fixture')) as render:
                self.assertEqual(store.pdf(token).read_bytes(),b'%PDF-fixture')
                store.pdf(token)
                render.assert_called_once()
                self.assertEqual(render.call_args.args[0],data['document'])
        path,_ = mail_output.original(self.id)
        path.write_bytes(b'changed original')
        with self.assertRaises(ValueError): store.file(token,'eml')
        with self.assertRaises(ValueError): store.file(token,'exe')
        store.release(token)
        with self.assertRaises(ValueError): store.get(token)


if __name__ == '__main__': unittest.main()
