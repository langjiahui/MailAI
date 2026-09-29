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
                pdf = pypdfium2.PdfDocument(output['payload'])
                try:
                    pdf.init_forms()
                    page = pdf[0]
                    try:
                        image = page.render(scale=2, draw_annots=True).to_pil().convert('RGB')
                    finally:
                        page.close()
                    assert any(pixel != (255, 255, 255) for pixel in image.get_flattened_data()), 'PDF filled text must be visible'
                finally:
                    pdf.close()
            assert task._source(email_id, 0)[3] == payload
        assert not db.list_sent_messages(), 'preparing a document must not send the reply'


if __name__ == '__main__':
    test_document_fill()
    print('DOCX/PDF filling and draft preparation passed')
