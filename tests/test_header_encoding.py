"""Legacy MIME names, exact recipient syntax and damaged historical identities."""
import base64
import os
import sys
import tempfile
from email import policy
from email.header import Header
from email.parser import BytesParser
from email.utils import getaddresses
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import config, db, parser, smtp_client
from app.mail_headers import decode_header_text
from app.web.helpers import resolved_contact_name


def word(name, actual='gbk', declared='gb2312', transfer='B'):
    payload = name.encode(actual)
    payload = base64.b64encode(payload) if transfer == 'B' else ''.join(f'={byte:02X}' for byte in payload).encode('ascii')
    return f'=?{declared}?{transfer}?{payload.decode("ascii")}?='


def message(name, **kwargs):
    encoded = word(name, **kwargs)
    return (f'From: {encoded} <person@example.test>\r\n'
            f'To: {encoded} <recipient@example.test>\r\n'
            f'Cc: {encoded} <cc@example.test>\r\n'
            f'Subject: {encoded}\r\n\r\nbody').encode('ascii')


def main():
    cases = [
        ('测试镕', 'gbk', 'gb2312'), ('测试镕', 'gbk', 'GB_2312-80'),
        ('扩展𠮷', 'gb18030', 'gb2312'), ('扩展𠮷', 'gb18030', 'gbk'),
        ('测试镕', 'gbk', 'utf-8'), ('测试姓名', 'utf-8', 'unknown-charset'),
        ('测试姓名', 'utf-8', 'utf-8'), ('傳統姓名', 'big5', 'big5'),
        ('François', 'iso-8859-1', 'iso-8859-1'), ('Привет', 'koi8-r', 'koi8-r'),
        ('山田太郎', 'iso-2022-jp', 'iso-2022-jp'),
    ]
    for name, actual, declared in cases:
        for transfer in ('B', 'Q'):
            raw = message(name, actual=actual, declared=declared, transfer=transfer)
            parsed = parser.parse_message(1, raw, save_raw=False)
            assert parsed['from_name'] == name, (actual, declared, parsed['from_name'])
            assert parsed['subject'] == name
            assert parsed['recipient_names'] == {'recipient@example.test': name, 'cc@example.test': name}
            fields = {'to_addr': f'{word(name, actual, declared, transfer)} <recipient@example.test>'}
            displayed = smtp_client.recipient_fields_for_display(fields)
            assert getaddresses([displayed['to_addr']]) == [(name, 'recipient@example.test')]

    # Names containing address punctuation must remain one recipient, even when
    # transport syntax did not need quotes around the original encoded word.
    for name in ['测试镕, 项目;采购', '张三:项目(采购)', '张三"采购"', '张三\\采购']:
        parsed = parser.parse_message(1, message(name), save_raw=False)
        assert parsed['from_addr'] == 'person@example.test'
        assert parsed['from_name'] == name
        assert parsed['to_addr'] == 'recipient@example.test'
        assert parsed['cc_addr'] == 'cc@example.test'
        assert parsed['recipient_names']['recipient@example.test'] == name
        display = smtp_client.recipient_fields_for_display({'to_addr': f'{word(name)} <recipient@example.test>'})
        normalized = smtp_client.normalize_recipient_fields(display)
        assert normalized['recipients'] == ['recipient@example.test']

    raw = message('测试镕, 项目').replace(
        b'Subject:', (f'Reply-To: {word("测试镕, 项目")} <reply@example.test>\r\n'
                     'Return-Path: <bounce@example.test>\r\nSubject:').encode('ascii'))
    parsed = parser.parse_message(1, raw, save_raw=False)
    assert parsed['reply_to'] == 'reply@example.test'
    assert parsed['return_path'] == 'bounce@example.test'

    for charset in ('utf-8', 'gbk'):
        raw = 'From: 测试镕 <person@example.test>\r\nSubject: 测试镕\r\n\r\nbody'.encode(charset)
        parsed = parser.parse_message(1, raw, save_raw=False)
        assert parsed['from_name'] == '测试镕'
        assert parsed['subject'] == '测试镕'

    folded = (f'To: {word("测试镕")}\r\n <a@example.test>\r\n'
              f'To: {word("项目")} <b@example.test>\r\n\r\n').encode('ascii')
    assert parser.recipient_header_names(BytesParser(policy=policy.default).parsebytes(folded)) == {
        'a@example.test': '测试镕', 'b@example.test': '项目',
    }
    mixed = f'{Header("项目", "utf-8").encode()} {word("测试镕")}'
    assert decode_header_text(mixed) == '项目测试镕'
    assert decode_header_text('=?broken') == '=?broken'
    assert decode_header_text('François / Привет / العربية') == 'François / Привет / العربية'
    assert decode_header_text('=?utf-8?b?/w==?=')  # Invalid bytes never vanish silently.
    assert decode_header_text('=?utf-8?b?!!!!?=') == '=?utf-8?b?!!!!?='
    assert decode_header_text(word('测试姓名', 'utf-8', 'bad\x00label')) == '测试姓名'
    assert decode_header_text('Plain\r\n\tfolded') == 'Plain folded'
    assert decode_header_text(f'{word("测试镕")} 张三') == '测试镕 张三'
    assert decode_header_text('原始姓名 ' + word('测试镕')) == '原始姓名 测试镕'
    assert decode_header_text('Raw\udcc3\udcfa ' + word('测试镕')) == 'Raw铭 测试镕'

    with tempfile.TemporaryDirectory() as root, patch.multiple(
        config, DB_PATH=os.path.join(root, 'mail.db'), IMAP_USER='me@example.test',
    ):
        db.init_db()
        raw_path = Path(root) / 'legacy.eml'
        raw = message('测试镕')
        raw_path.write_bytes(raw)
        old = parser.parse_message(1, raw, save_raw=False)
        old.update(from_name='测试�F', recipient_names={
            'recipient@example.test': '测试�F', 'cc@example.test': '人工标注的抄送姓名',
        },
                   raw_path=str(raw_path), date='2026-10-20', status='inbox')
        email_id = db.upsert_email(old)
        assert db.search_contacts('person@example.test')[0]['name'] == '测试镕'
        assert db.search_contacts('recipient@example.test')[0]['name'] == '测试镕'
        assert db.contact_display_names(['cc@example.test'])['cc@example.test']['name'] == '人工标注的抄送姓名'
        assert resolved_contact_name('person@example.test', '测试�F', db.contact_display_names(
            ['person@example.test'])) == ('测试镕', 'history')
        # Display recovery leaves evidence and the stored message untouched.
        stored = db.get_email(email_id)
        assert stored['from_name'] == '测试�F'
        assert stored['recipient_names'] == old['recipient_names']
        assert raw_path.read_bytes() == raw
        assert parser.sender_name_from_raw_path(str(raw_path), 'other@example.test') == ''
        assert parser.sender_name_from_raw_path(str(Path(root) / 'missing'), 'person@example.test') == ''

        # A newer damaged name cannot displace a usable older name when the
        # original is unavailable. Raw headers also repair partly populated maps.
        db.upsert_email(dict(old, uid=2, from_addr='history@example.test', from_name='完整姓名',
                             raw_path='', date='2026-10-01', recipient_names={}))
        db.upsert_email(dict(old, uid=3, from_addr='history@example.test', raw_path='', recipient_names={}))
        assert db.search_contacts('history@example.test')[0]['name'] == '完整姓名'
        db.save_contact('person@example.test', '人工维护姓名')
        assert db.search_contacts('person@example.test')[0]['name'] == '人工维护姓名'
        assert resolved_contact_name('person@example.test', '测试�F', db.contact_display_names(
            ['person@example.test'])) == ('人工维护姓名', 'manual')

        # Both low-level caches must notice changed original files.
        assert parser.sender_name_from_raw_path(str(raw_path), 'person@example.test') == '测试镕'
        assert parser.recipient_names_from_raw_path(str(raw_path))['recipient@example.test'] == '测试镕'
        raw_path.write_bytes(message('另一姓名'))
        assert parser.sender_name_from_raw_path(str(raw_path), 'person@example.test') == '另一姓名'
        assert parser.recipient_names_from_raw_path(str(raw_path))['recipient@example.test'] == '另一姓名'

    print('PASS legacy header encodings, recipient syntax and historical name recovery')


if __name__ == '__main__':
    main()
