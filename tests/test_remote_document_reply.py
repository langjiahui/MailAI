"""WeChat's explicit fill, review, file delivery and send confirmation flow."""
import io
import json
import os
import re
import sys
import tempfile
from email.message import EmailMessage
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import assistant_document_reply as task, config, db, remote_control, remote_media


def _source(root):
    from openpyxl import Workbook
    book = Workbook()
    sheet = book.active
    sheet.title = '登记表'
    sheet['A1'], sheet['A2'] = '姓名', '车牌号'
    data = io.BytesIO()
    book.save(data)
    message = EmailMessage()
    message['From'], message['To'], message['Subject'] = 'sender@example.com', 'me@example.com', '自驾登记'
    message.set_content('请填写附件后回复。')
    message.add_attachment(data.getvalue(), maintype='application', subtype='octet-stream', filename='登记表.xlsx')
    path = Path(root) / 'mail.eml'
    path.write_bytes(message.as_bytes())
    with db.conn() as conn:
        return conn.execute('INSERT INTO emails(uid,folder,from_addr,to_addr,subject,body_text,date,raw_path,attachments,created_at,remote_missing) '
                            'VALUES(?,?,?,?,?,?,?,?,?,?,0)',
                            (1, 'INBOX', 'sender@example.com', 'me@example.com', '自驾登记', '请填写附件后回复。',
                             '2026-09-29T10:00:00', str(path), json.dumps([{'name': '登记表.xlsx', 'size': len(data.getvalue())}]),
                             '2026-09-29T10:00:00')).lastrowid


def _model(messages, **_):
    if '只输出 JSON 对象' in messages[0]['content']:
        value = {'fields': [{'sheet': '登记表', 'cell': 'B1', 'label': '姓名'},
                            {'sheet': '登记表', 'cell': 'B2', 'label': '车牌号'}]}
        return {'choices': [{'message': {'content': json.dumps(value, ensure_ascii=False)}}]}
    return {'choices': [{'message': {'content': '已填写附件，请查收。'}}]}


def test_remote_document_reply():
    with tempfile.TemporaryDirectory() as root, patch.object(config, 'DB_PATH', os.path.join(root, 'mail.db')), \
            patch.object(config, 'IMAP_USER', 'me@example.com'), patch.object(config, 'RAW_DIR', root), \
            patch.object(remote_control, '_save_session'):
        db.init_db()
        email_id = _source(root)
        state = {'account_id': 'account', 'selected': email_id, 'context_at': __import__('time').time()}
        with patch.object(task.client, 'chat_completion', side_effect=_model):
            assert '待填写字段' in remote_control._mail_command('chat', state, '填写附件', 'me@example.com', 'weixin')
            assert '姓名：张三' in remote_control._mail_command('chat', state, '填写字段1：张三', 'me@example.com', 'weixin')
            remote_control._mail_command('chat', state, '填写字段2：沪A12345', 'me@example.com', 'weixin')
            preview = remote_control._mail_command('chat', state, '生成附件回复', 'me@example.com', 'weixin')
        assert '尚未发送' in preview and '登记表_已填写.xlsx' in preview
        assert not db.list_sent_messages()
        remote_control._mail_command('chat', state, '查看填写结果', 'me@example.com', 'weixin')
        assert remote_media.load_attachment(state['_media_request'])['name'] == '登记表_已填写.xlsx'
        token = re.search(r'确认发送 ([A-F0-9]{8})', preview)[1]
        assert token in remote_control._mail_command('chat', state, '回复预览', 'me@example.com', 'weixin')
        calls = []
        from app.web.routes import compose
        with patch.object(compose, 'api_send_mail', side_effect=lambda payload: calls.append(payload) or {'ok': True}):
            result = remote_control._mail_command('chat', state, f'确认发送 {token}', 'me@example.com', 'weixin')
        assert '服务器已接受' in result and len(calls) == 1
        assert calls[0].reply_to_email_id == email_id and len(calls[0].attachments) == 1
        assert '不匹配' in remote_control._mail_command('chat', state, f'确认发送 {token}', 'me@example.com', 'weixin')


if __name__ == '__main__':
    test_remote_document_reply()
    print('WeChat document fill, review, file transfer and send confirmation passed')
