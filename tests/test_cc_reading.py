"""Cc parsing, persistence and legacy local-header recovery."""
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import config, db, parser

with tempfile.TemporaryDirectory() as root, patch.object(config, 'DB_PATH', str(Path(root)/'mail.db')):
    db.init_db()
    raw = b'From: sender@example.test\r\nTo: to@example.test\r\nCc: Alice <alice@example.test>, Bob <bob@example.test>\r\nSubject: Test\r\n\r\nBody'
    parsed = parser.parse_message(1, raw, save_raw=False)
    assert parsed['to_addr'] == 'to@example.test'
    assert parsed['cc_addr'] == 'alice@example.test, bob@example.test'
    assert parsed['recipient_names']['alice@example.test'] == 'Alice'
    email_id = db.upsert_email(parsed)
    assert db.get_email(email_id)['cc_addr'] == parsed['cc_addr']
    path = Path(root)/'old.eml'
    path.write_bytes(raw)
    assert parser.cc_from_raw_path(str(path)) == parsed['cc_addr']
    old_id = db.upsert_email(dict(uid=2, from_addr='sender@example.test', to_addr='to@example.test', raw_path=str(path)))
    assert db.get_email(old_id)['cc_addr'] is None
    from app.web.routes.mail_read import api_email_detail
    detail = api_email_detail(old_id)
    assert detail['cc_addr'] == parsed['cc_addr']
    assert db.get_email(old_id)['cc_addr'] == parsed['cc_addr']
    assert parser.parse_message(3, b'To: to@example.test\r\n\r\nBody', save_raw=False)['cc_addr'] == ''
    assert parser.cc_from_raw_path(str(Path(root)/'missing.eml')) is None
print('Cc parsing, database round trip and legacy detail recovery passed')
