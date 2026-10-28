"""Automatic large-mail recovery and bounded IMAP reconnect; no external services."""
import ssl
import sys
from pathlib import Path
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import config, db, pipeline, mail_recovery as recovery
from app.imap_client import MailClient, OversizedMessageError
from app.mail_connection import issue_kind
from imapclient.exceptions import LoginError
from test_mail_import import fixture, message

def identity():
    from app.oauth_mail import imap_login
    for supported in (False, True):
        client = Mock()
        client.has_capability.return_value = supported
        events = []
        client.login.side_effect = lambda *args: events.append('login') or 'authenticated'
        client.id_.side_effect = lambda details: events.append('id')
        assert imap_login(client, 'mail@example.test', 'synthetic', values={}) == 'authenticated'
        assert events == (['login', 'id'] if supported else ['login'])
        if supported:
            details = client.id_.call_args.args[0]
            assert details['name'] == 'MailAI' and 'password' not in details and 'user' not in details

def connections():
    client = Mock()
    with patch('app.imap_client.IMAPClient', side_effect=[TimeoutError('timed out'), client]) as connect, patch('app.oauth_mail.imap_login') as login, patch('app.imap_client.time.sleep'):
        with MailClient() as mail:
            assert mail.client is client
        assert connect.call_count == 2
        login.assert_called_once_with(client, config.IMAP_USER, config.IMAP_PASSWORD)
    with patch('app.imap_client.IMAPClient', side_effect=ConnectionError('offline')) as connect, patch('app.imap_client.time.sleep'):
        try: MailClient().__enter__()
        except ConnectionError: pass
        else: raise AssertionError('Persistent failure must remain visible after bounded retries')
        assert connect.call_count == 3
    for error, kind in [(LoginError('bad account'), 'credentials'), (ssl.SSLCertVerificationError('certificate verify failed'), 'certificate')]:
        with patch('app.imap_client.IMAPClient', return_value=client) as connect, patch('app.oauth_mail.imap_login', side_effect=error), patch('app.imap_client.time.sleep') as sleep:
            try: MailClient().__enter__()
            except Exception as exc: assert issue_kind(exc) == kind
            else: raise AssertionError('Invalid credentials/certificates require explicit repair')
            assert connect.call_count == 1
            sleep.assert_not_called()

def large_mail():
    for history in (False, True):
        with fixture() as (root, account), account('work'):
            db.observe_uid_validity('INBOX', 7)
            raw = message('automatic-large', attachment=True)
            mail = Mock()
            mail._uid_validity.return_value = 7
            mail.client.select_folder.return_value = {b'UIDVALIDITY':7}
            mail.client.search.return_value = [91]
            mail.fetch_new.return_value = [(91, OversizedMessageError(91, 51 * 1024**2))]
            db.defer_mail_fetch('INBOX', 91, '历史大邮件等待分段下载' if history else '超过 50 MB', size=51 * 1024**2)
            db.set_runtime_setting('oversized_mail_count', '1')
            def fetch(uids, fields):
                if fields == ['RFC822.SIZE']: return {91:{b'RFC822.SIZE':51 * 1024**2}}
                if fields == ['RFC822.SIZE', 'FLAGS']: return {91:{b'RFC822.SIZE':len(raw), b'FLAGS':(b'\\Seen', b'\\Flagged')}}
                offset, length = map(int, fields[0].split('<')[1].rstrip('>').split('.'))
                return {91:{f'BODY[]<{offset}>'.encode():raw[offset:offset + length]}}
            mail.client.fetch.side_effect = fetch
            manager = Mock(__enter__=Mock(return_value=mail), __exit__=Mock(return_value=False))
            with patch.object(pipeline, 'MailClient', return_value=manager), patch.object(pipeline, '_InboxPriority'), patch.object(pipeline, '_reset_action_guard'), patch('app.mailbox_jobs.notify_new_message') as notify:
                result = pipeline.fetch_all() if history else pipeline.poll_once()
                assert result['fetched'] == 1 and result['errors'] == 0, result
                assert notify.call_count == (0 if history else 1)
            row = db.get_email_by_folder_uid('INBOX', 91)
            assert row and Path(row['raw_path']).read_bytes() == raw
            assert row['is_read'] == 1 and row['is_starred'] == 1
            assert row['arrival_kind'] == ('history' if history else 'new')
            assert row['verdict'] == 'unreviewed' and row['action_mode'] == 'observe'
            assert db.mail_fetch_retry_summary('INBOX')['count'] == 0
            assert db.get_runtime_settings()['oversized_mail_count'] == '0'
            for method in ('move', 'copy', 'delete_messages', 'add_flags', 'set_flags', 'expunge'):
                getattr(mail.client, method).assert_not_called()
    with fixture() as (root, account), account('work'):
        db.observe_uid_validity('INBOX', 7)
        db.set_runtime_setting('oversized_mail_count', '1')
        mail = Mock()
        mail.client.search.return_value = [93]
        mail.client.fetch.return_value = {93:{b'RFC822.SIZE':51 * 1024**2}}
        recovery.discover_legacy(mail)
        assert db.due_mail_fetch_retries('INBOX') == [93]
        assert recovery._entry('INBOX', 93)['uid_validity'] == 7
        assert db.get_runtime_settings()['oversized_mail_count'] == '0'
        mail.client.fetch.reset_mock()
        recovery.discover_legacy(mail)
        mail.client.fetch.assert_not_called()
        db.defer_mail_fetch('INBOX', 94, '邮件 94 超过 50 MB，已暂停自动下载', size=51 * 1024**2, retry_after=86400)
        recovery.discover_legacy(mail)
        assert 94 in db.due_mail_fetch_retries('INBOX')
        db.defer_mail_fetch('INBOX', 94, 'network timeout', size=51 * 1024**2, retry_after=600)
        recovery.discover_legacy(mail)
        assert 94 not in db.due_mail_fetch_retries('INBOX')
        with patch.object(recovery, 'download', side_effect=TimeoutError('interrupted')):
            try: recovery.recover_large(mail, 'INBOX', 94, 51 * 1024**2)
            except TimeoutError: pass
            else: raise AssertionError('Interrupted mail must not be committed')
        assert not list(Path(config.RAW_DIR).glob('automatic-*.eml'))
        assert recovery._entry('INBOX', 94)

if __name__ == '__main__':
    identity(); connections(); large_mail()
    print('Automatic recovery: bounded reconnect, auth/TLS isolation, streamed poll/history, legacy discovery, flags, notification and cleanup passed')
