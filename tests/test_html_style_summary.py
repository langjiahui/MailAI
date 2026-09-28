"""HTML-only mail must not expose CSS as readable text or an AI preview."""
import os
import sys
import tempfile
from email.mime.text import MIMEText
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config, db, parser, pipeline


def _html_mail() -> bytes:
    message = MIMEText(
        '<html><head><style>body { font-size: 12px; color: #000; }</style>'
        '<script>var tracking = 1;</script></head><body>'
        '<p>认证管理、活动学习、职业发展，现已一站连接。</p>'
        '<p>请访问官方服务平台了解证书查验和活动日历。</p>'
        '</body></html>',
        'html', 'utf-8',
    )
    message['From'] = 'sender@example.test'
    message['To'] = 'reader@example.test'
    message['Subject'] = '服务平台全新上线'
    return message.as_bytes()


def test_html_only_mail_excludes_style_and_script():
    parsed = parser.parse_message(1, _html_mail(), save_raw=False)
    assert parsed['body_text'].startswith('认证管理、活动学习')
    assert '证书查验和活动日历' in parsed['body_text']
    assert 'font-size' not in parsed['body_text']
    assert 'tracking' not in parsed['snippet']
    assert parser.has_css_leak('body { font-size: 12px; color: #000; }')
    assert not parser.has_css_leak(parsed['body_text'])


def test_repair_historical_css_preview_preserves_non_css_summary():
    raw = _html_mail()
    with tempfile.TemporaryDirectory() as root:
        db_path = os.path.join(root, 'mailai.db')
        raw_path = os.path.join(root, 'source.eml')
        Path(raw_path).write_bytes(raw)
        with patch.multiple(config, DB_PATH=db_path, RAW_DIR=root, INBOX_FOLDER='INBOX'):
            db.init_db()
            email_id = db.upsert_email({
                'uid': 1, 'folder': 'INBOX', 'subject': '服务平台全新上线',
                'from_addr': 'sender@example.test', 'date': '2026-09-28 12:00:00',
                'snippet': 'body { font-size: 12px; color: #000; }',
                'body_text': 'body { font-size: 12px; color: #000; } 认证管理',
                'body_html': '', 'urls': [], 'attachments': [],
                'summary': '', 'raw_path': raw_path,
            })
            result = pipeline.repair_html_style_bodies()
            assert result['updated'] == 1
            repaired = db.get_email(email_id)
            assert repaired['body_text'].startswith('认证管理、活动学习')
            assert 'font-size' not in repaired['snippet']
            assert '<html>' in repaired['body_html']
            assert repaired['summary'] == ''
            assert pipeline.repair_html_style_bodies()['skipped'] is True


if __name__ == '__main__':
    test_html_only_mail_excludes_style_and_script()
    test_repair_historical_css_preview_preserves_non_css_summary()
    print('HTML-only mail parsing and historical CSS preview repair passed')
