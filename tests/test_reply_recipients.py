"""Offline reply addressing regressions."""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.reply_recipients import recipients


def main():
    with tempfile.TemporaryDirectory() as root:
        path = Path(root) / 'mail.eml'
        path.write_bytes(
            b'From: Sender <sender@example.com>\r\n'
            b'Reply-To: Support <support@example.com>\r\n'
            b'To: Me <me@example.com>, "Doe, Jane" <jane@example.com>\r\n'
            b'Cc: ME@example.com, Jane@example.com, team@example.com\r\n'
            b'Bcc: hidden@example.com\r\n\r\nHello')
        row = {'raw_path': str(path), 'from_addr': 'sender@example.com'}
        assert recipients(row, 'me@example.com') == {'to_addr': 'support@example.com', 'cc_addr': ''}
        assert recipients(row, 'me@example.com', True) == {
            'to_addr': 'support@example.com, jane@example.com', 'cc_addr': 'team@example.com'}
        assert recipients({'from_addr': 'me@example.com', 'to_addr': 'other@example.com'}, 'me@example.com')['to_addr'] == 'other@example.com'
        try:
            recipients({'raw_path': str(Path(root) / 'missing')}, 'me@example.com', True)
        except ValueError:
            pass
        else:
            raise AssertionError('Missing original must not silently omit CC')
    print('Reply-To, reply-all CC, deduplication, self exclusion and Bcc privacy passed')


if __name__ == '__main__':
    main()
