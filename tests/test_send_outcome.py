"""SMTP acceptance must not become a false failure on archive errors."""
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch
from contextlib import ExitStack

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import smtp_client
from email.message import EmailMessage


def main():
    msg = EmailMessage()
    msg['Message-ID'] = '<test@example.com>'
    msg.set_content('Test')
    transport = MagicMock()
    transport.__enter__.return_value = transport
    transport.send_message.return_value = {'blocked@example.com': (550, b'Rejected')}
    with patch.object(smtp_client, 'build_message', return_value=(msg, ['ok@example.com', 'blocked@example.com'])), \
         patch.object(smtp_client, '_credentials', return_value=('me@example.com', 'test')), \
         patch.object(smtp_client.smtplib, 'SMTP_SSL', return_value=transport), \
         patch.object(smtp_client.config, 'SMTP_SSL', True), \
         patch.object(smtp_client, '_archive_sent', side_effect=RuntimeError('IMAP offline')):
        result = smtp_client.send({})
        assert result['recipients'] == 1
        assert result['refused_recipients'] == ['blocked@example.com']
        assert '归档失败' in result['warning'] and '勿' in result['warning']
        transport.send_message.assert_called_once()
        transport.quit.side_effect = OSError('Disconnected after DATA accepted')
        result = smtp_client.send({})
        assert result['recipients'] == 1 and '关闭连接' in result['warning']
        transport.send_message.side_effect = RuntimeError('Rejected before acceptance')
        try:
            smtp_client.send({})
        except RuntimeError as exc:
            assert str(exc) == 'Rejected before acceptance'
        else:
            raise AssertionError('Send error must not be swallowed')
    with ExitStack() as stack:
        for key, value in dict(IMAP_HOST='imap.example.com', IMAP_PORT=1993,
                               IMAP_SSL=True, IMAP_VERIFY_SSL=True,
                               IMAP_USER='current@example.com', IMAP_PASSWORD='test-only',
                               SMTP_SENT_IMAP_HOST='', SMTP_SENT_FOLDER='').items():
            stack.enter_context(patch.object(smtp_client.config, key, value))
        archive = MagicMock()
        archive.__enter__.return_value = archive
        factory = stack.enter_context(patch.object(smtp_client, 'IMAPClient', return_value=archive))
        archive.list_folders.return_value = [((), '/', 'Sent Items')]
        assert smtp_client._archive_sent(b'test') == 'Sent Items'
        assert factory.call_args.kwargs['port'] == 1993
        archive.login.assert_called_with('current@example.com', 'test-only')
        archive.create_folder.assert_not_called()
        archive.list_folders.return_value = [((b'\\Sent',), '/', 'Custom Sent')]
        assert smtp_client._archive_sent(b'test') == 'Custom Sent'
        archive.list_folders.return_value = []
        assert smtp_client._archive_sent(b'test') == 'Sent Messages'
        archive.create_folder.assert_called_once_with('Sent Messages')
        with patch.object(smtp_client.config, 'SMTP_SENT_IMAP_HOST', 'stale.example.com'):
            before = factory.call_count
            try:
                smtp_client._archive_sent(b'test')
            except ValueError:
                pass
            else:
                raise AssertionError('Stale archive host must be rejected')
            assert factory.call_count == before
    print('Partial SMTP acceptance and archive-failure warnings passed')


if __name__ == '__main__':
    main()
