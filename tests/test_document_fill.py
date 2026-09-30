"""Real DOCX/PDF form writing and draft creation, without a live mailbox."""
import io
import json
import os
import sys
import tempfile
import zipfile
from email.message import EmailMessage
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import assistant_document_reply as task, config, db
from app.document_fill import inspect


def word_file():
    xml = '''<?xml version="1.0" encoding="UTF-8"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>姓名</w:t></w:r></w:p></w:tc>
      <w:tc><w:p/></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>车牌号</w:t></w:r></w:p></w:tc>
      <w:tc><w:p/></w:tc></w:tr></w:tbl><w:p><w:r><w:t>备注：____</w:t></w:r></w:p></w:body>
    </w:document>'''.encode('utf-8')
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w') as archive:
        archive.writestr('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
        archive.writestr('word/document.xml', xml)
    return out.getvalue()


def pdf_file():
    from pypdf import PdfWriter
    from pypdf.generic import ArrayObject, DictionaryObject, NameObject, NumberObject, RectangleObject, TextStringObject
    writer = PdfWriter()
    page = writer.add_blank_page(300, 300)
    field = DictionaryObject({NameObject('/FT'): NameObject('/Tx'), NameObject('/T'): TextStringObject('driver'),
                              NameObject('/TU'): TextStringObject('驾驶员'), NameObject('/V'): TextStringObject(''),
                              NameObject('/Type'): NameObject('/Annot'), NameObject('/Subtype'): NameObject('/Widget'),
                              NameObject('/Rect'): RectangleObject((40, 240, 250, 265)),
                              NameObject('/F'): NumberObject(4)})
    ref = writer._add_object(field)
    page[NameObject('/Annots')] = ArrayObject([ref])
    writer._root_object[NameObject('/AcroForm')] = writer._add_object(DictionaryObject({NameObject('/Fields'): ArrayObject([ref])}))
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def source_mail(root, name, payload, uid):
    mail = EmailMessage()
    mail['From'] = 'sender@example.com'
    mail['To'] = 'me@example.com'
    mail['Subject'] = '登记信息'
    mail['Message-ID'] = f'<source-{uid}@example.com>'
    mail.set_content('请填写附件后回复。')
    mail.add_attachment(payload, maintype='application', subtype='octet-stream', filename=name)
    path = Path(root) / f'{uid}.eml'
    path.write_bytes(mail.as_bytes())
    with db.conn() as conn:
        return conn.execute('INSERT INTO emails(uid,folder,from_addr,to_addr,subject,body_text,date,message_id,raw_path,attachments,created_at,remote_missing) '
                            'VALUES(?,?,?,?,?,?,?,?,?,?,?,0)',
                            (uid, 'INBOX', 'sender@example.com', 'me@example.com', '登记信息', '请填写附件后回复。',
                             '2026-09-29T10:00:00', f'<source-{uid}@example.com>', str(path),
                             json.dumps([{'name': name, 'size': len(payload)}]), '2026-09-29T10:00:00')).lastrowid


def model(messages, **_):
    if '只输出 JSON 对象' in messages[0]['content']:
        candidates = json.loads(messages[1]['content'])['候选字段']
        return {'choices': [{'message': {'content': json.dumps({'fields': [{'cell': candidate['cell']} for candidate in candidates]})}}]}
    return {'choices': [{'message': {'content': '您好，附件已填写，请查收。'}}]}


def test_document_fill():
    with tempfile.TemporaryDirectory() as root, patch.object(config, 'DB_PATH', os.path.join(root, 'mail.db')), \
            patch.object(config, 'IMAP_USER', 'me@example.com'):
        db.init_db()
        for uid, ext, payload in ((1, '.docx', word_file()), (2, '.pdf', pdf_file())):
            email_id = source_mail(root, f'登记表{ext}', payload, uid)
            with patch.object(task.client, 'chat_completion', side_effect=model):
                plan = task.plan(email_id, 0)
                assert plan['fields']
                fields = [dict(field, value='Zhang San' if ext == '.pdf' else '张三') for field in plan['fields']]
                result = task.prepare(email_id, 0, plan['digest'], fields, plan_token=plan['plan_token'])
                if ext == '.pdf':
                    try:
                        task.prepare(email_id, 0, plan['digest'],
                                     [dict(field, value='张三') for field in plan['fields']],
                                     plan_token=plan['plan_token'])
                    except ValueError as exc:
                        assert '中文字形' in str(exc)
                    else:
                        raise AssertionError('PDF without a Chinese font must not silently corrupt text')
            draft = db.get_draft(result['draft_id'])
            assert draft['reply_to_email_id'] == email_id and draft['to_addr'] == 'sender@example.com'
            output = db.get_sent_attachment(result['draft_id'], 0, draft=True)
            assert output['name'].endswith('_已填写' + ext)
            assert not inspect(output['payload'], ext)[0], 'filled targets must no longer be blank'
            if ext == '.pdf':
                import pypdfium2
                from PIL import ImageChops
                def render(data):
                    pdf = pypdfium2.PdfDocument(data)
                    try:
                        pdf.init_forms()
                        page = pdf[0]
                        try:
                            return page.render(scale=2, draw_annots=True).to_pil().convert('RGB')
                        finally:
                            page.close()
                    finally:
                        pdf.close()
                # Compare only the widget's interior, where the entered text
                # should appear; the empty form border cannot satisfy this.
                interior = (88, 78, 492, 112)
                before = render(payload).crop(interior)
                after = render(output['payload']).crop(interior)
                assert ImageChops.difference(before, after).getbbox(), 'PDF filled text must be visibly different from the blank form'
            assert task._source(email_id, 0)[3] == payload
        assert not db.list_sent_messages(), 'preparing a document must not send the reply'


def test_document_boundaries():
    from app.document_fill import fill
    relationships = b'''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"
        Target="https://example.test/external" TargetMode = "External"/>
    </Relationships>'''
    source = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(word_file())) as original, zipfile.ZipFile(source, 'w') as output:
        for member in original.infolist():
            output.writestr(member, original.read(member))
        output.writestr('word/_rels/document.xml.rels', relationships)
    try:
        inspect(source.getvalue(), '.docx')
    except ValueError as exc:
        assert '外部链接' in str(exc)
    else:
        raise AssertionError('external Word relationships must be rejected regardless of XML spacing')

    from pypdf import PdfWriter
    blank = io.BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(300, 300)
    writer.write(blank)
    try:
        inspect(blank.getvalue(), '.pdf')
    except ValueError as exc:
        assert '表单' in str(exc)
    else:
        raise AssertionError('a flat PDF must not be offered for automatic filling')
    try:
        fill(word_file(), '.docx', [{'sheet':'Word 文档','cell':'T1R1C2','value':'张三'},
                                    {'sheet':'Word 文档','cell':'T1R1C2','value':'李四'}])
    except ValueError as exc:
        assert '位置无效' in str(exc)
    else:
        raise AssertionError('duplicate target edits must not overwrite each other')


def test_document_api_flow():
    from fastapi.testclient import TestClient
    from app.web.server import app
    with tempfile.TemporaryDirectory() as root, patch.object(config, 'DB_PATH', os.path.join(root, 'mail.db')), \
            patch.object(config, 'IMAP_USER', 'me@example.com'), \
            patch.object(config, 'IMAP_PASSWORD', 'fixture'), \
            patch.object(task.client, 'chat_completion', side_effect=model):
        db.init_db()
        email_id = source_mail(root, '登记表.docx', word_file(), 21)
        client = TestClient(app, base_url='http://127.0.0.1')
        plan_response = client.post('/api/assistant/document-reply/plan', json={
            'email_id':email_id, 'index':0, 'instruction':'填写登记表并回复'})
        assert plan_response.status_code == 200, plan_response.text
        plan = plan_response.json()
        assert {field['label'] for field in plan['fields']} == {'姓名', '车牌号', '备注'}
        fields = [dict(field, value='张三' if field['label'] == '姓名' else '沪A12345') for field in plan['fields']]
        payload = {'email_id':email_id, 'index':0, 'digest':plan['digest'],
                   'plan_token':plan['plan_token'], 'fields':fields}
        altered = {**payload, 'digest':'0'*64}
        assert client.post('/api/assistant/document-reply/prepare', json=altered).status_code == 400
        prepared = client.post('/api/assistant/document-reply/prepare', json=payload)
        assert prepared.status_code == 200, prepared.text
        repeated = client.post('/api/assistant/document-reply/prepare', json=payload)
        assert repeated.status_code == 200 and repeated.json()['draft_id'] == prepared.json()['draft_id'], \
            'a lost API response must not leave duplicate reply drafts after retry'
        assert len(db.list_drafts()) == 1
        draft = client.get(f"/api/drafts/{prepared.json()['draft_id']}")
        assert draft.status_code == 200
        assert draft.json()['to_addr'] == 'sender@example.com'
        assert len(draft.json()['attachments']) == 1
        edited = db.get_draft(prepared.json()['draft_id'])
        edited['subject'] = '用户修改过的主题'
        db.save_draft(edited, prepared.json()['draft_id'])
        regenerated = client.post('/api/assistant/document-reply/prepare', json=payload)
        assert regenerated.status_code == 200 and regenerated.json()['draft_id'] != prepared.json()['draft_id'], \
            'a user-edited draft must not be silently reused as a new generated reply'
        with db.conn() as conn:
            conn.execute("UPDATE emails SET status='quarantine' WHERE id=?", (email_id,))
        assert client.post('/api/assistant/document-reply/prepare', json=payload).status_code == 400
        assert not db.list_sent_messages(), 'API preparation must never send email'


if __name__ == '__main__':
    test_document_fill()
    test_document_boundaries()
    test_document_api_flow()
    print('DOCX/PDF filling and draft preparation passed')
