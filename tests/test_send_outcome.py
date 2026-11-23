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
    _test_sent_includes_queued_outbox()
    print('Partial SMTP acceptance, archive-failure warnings, and Sent outbox visibility passed')


def _test_sent_includes_queued_outbox():
    import tempfile
    from app import config, db, outbox, mail_list
    from app.web.routes.compose import api_sent_messages, api_outbox_detail
    from app.web.routes.mail_read import api_mailbox_counts

    with tempfile.TemporaryDirectory() as tmp:
        db_path = str(Path(tmp) / 'mailai-test.sqlite3')
        with patch.object(config, 'DB_PATH', db_path), \
             patch.object(config, 'IMAP_USER', 'owner@example.com'):
            db.init_db()
            token = 'tok-queued-sent-view'
            outbox.enqueue(token, {
                'to_addr': 'peer@example.com',
                'subject': '刚刚发出的邮件',
                'body_html': '<p>正文内容</p>',
                'attachments': [{'filename': 'report.pdf', 'size': 123, 'content_type': 'application/pdf', 'data_base64': 'AAAA'}],
            }, delay=10)
            listed = api_sent_messages()
            assert len(listed) == 1
            first = listed[0]
            assert first['id'] == f'outbox:{token}'
            assert first['_outbox'] is True
            assert first['outbox_token'] == token
            assert first['status'] == 'queued'
            assert first['scheduled'] is False
            assert first['attachments'][0]['filename'] == 'report.pdf'
            assert 'data_base64' not in first['attachments'][0]
            assert api_mailbox_counts()['totals']['sent'] == 1

            paged = mail_list.page({'special': 'sent'})
            assert paged['total'] == 1 and len(paged['items']) == 1
            assert paged['items'][0]['id'] == f'outbox:{token}'
            assert paged['items'][0]['_outbox'] is True
            assert paged['items'][0]['outbox_token'] == token
            assert paged['items'][0]['status'] == 'queued'
            assert paged['counts']['totals']['sent'] == 1

            detail = api_outbox_detail(token)
            assert detail['body_html'] == '<p>正文内容</p>'
            assert detail['outbox_token'] == token
            assert 'data_base64' not in detail['attachments'][0]

            # Once SMTP starts and creates the linked sent_messages row, Sent list & count must not duplicate it.
            ctx_token = outbox.current_send_token.set(token)
            try:
                record_id = db.create_sent_message({
                    'message_id': '<sending@example.com>',
                    'from_addr': 'owner@example.com',
                    'to_addr': 'peer@example.com',
                    'subject': '刚刚发出的邮件',
                    'body_html': '<p>正文内容</p>',
                })
            finally:
                outbox.current_send_token.reset(ctx_token)
            listed_sending = api_sent_messages()
            assert len(listed_sending) == 1 and listed_sending[0]['id'] == record_id
            assert api_mailbox_counts()['totals']['sent'] == 1
            paged_sending = mail_list.page({'special': 'sent'})
            assert paged_sending['total'] == 1 and paged_sending['items'][0]['id'] == record_id
            assert paged_sending['counts']['totals']['sent'] == 1

            # Canceling another queued email immediately removes it from Sent.
            token2 = 'tok-cancel-sent-view'
            outbox.enqueue(token2, {'to_addr': 'peer@example.com', 'subject': '待撤回', 'body_html': '<p>撤回</p>'}, delay=10)
            assert any(item['id'] == f'outbox:{token2}' for item in api_sent_messages())
            assert any(item['id'] == f'outbox:{token2}' for item in mail_list.page({'special': 'sent'})['items'])
            outbox.cancel(token2)
            assert all(item['id'] != f'outbox:{token2}' for item in api_sent_messages())
            assert all(item['id'] != f'outbox:{token2}' for item in mail_list.page({'special': 'sent'})['items'])


if __name__ == '__main__':
    main()
