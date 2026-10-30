"""Offline checks for chunked downloads and durable per-message retries."""
import sys
import tempfile
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import config, db
from app.account_context import use
from app.imap_client import BODY_CHUNK_BYTES, MailClient, MailTransportError, OversizedMessageError, RawMessageBatch


def main():
    body = b'x' * (5 * 1024 * 1024 + 200 * 1024)
    imap = Mock()
    imap.select_folder.return_value = {}

    def fetch(uids, fields):
        if fields == ['RFC822.SIZE']:
            return {uids[0]: {b'RFC822.SIZE': len(body)}}
        offset, length = fields[0].split('<', 1)[1].rstrip('>').split('.')
        offset, length = int(offset), int(length)
        assert length <= BODY_CHUNK_BYTES
        return {uids[0]: {f'BODY[]<{offset}>'.encode(): body[offset:offset + length]}}

    imap.fetch.side_effect = fetch
    mail = MailClient.__new__(MailClient)
    mail.client = imap
    assert mail.fetch_uid_bounded(7, config.INBOX_FOLDER) == body
    assert imap.fetch.call_count > 10, 'A 5.2 MB message should stream in bounded chunks'

    imap.fetch.side_effect = lambda uids, fields: {uids[0]: {b'RFC822.SIZE': 51 * 1024 * 1024}}
    with patch.object(mail, '_reconnect') as reconnect:
        try:
            mail.fetch_uid_bounded(8, config.INBOX_FOLDER)
        except OversizedMessageError as exc:
            assert exc.size == 51 * 1024 * 1024
        else:
            raise AssertionError('Oversized mail must be deferred before body download')
        reconnect.assert_not_called()

    attempts = 0
    def flaky_fetch(uids, fields):
        nonlocal attempts
        if fields == ['RFC822.SIZE']:
            return {uids[0]: {b'RFC822.SIZE': 3}}
        attempts += 1
        if attempts == 1:
            raise TimeoutError('simulated stalled server')
        return {uids[0]: {b'BODY[]<0>': b'abc'}}
    imap.fetch.side_effect = flaky_fetch
    with patch.object(mail, '_reconnect') as reconnect, patch('app.imap_client.time.sleep'):
        assert mail.fetch_uid_bounded(9, config.INBOX_FOLDER) == b'abc'
        reconnect.assert_called_once()

    # Reproduce the user's 47,740/47,742 loop. Only a separately requested full
    # body can confirm that RFC822.SIZE is inaccurate; never accept a prefix
    # merely because the missing byte count happens to be small.
    small = b'From: fixture@example.test\r\nSubject: size mismatch\r\n\r\n'
    small += b'x' * (47740 - len(small))
    progress = []
    mail.on_download_progress = lambda *args:progress.append(args)
    full_body = [small]
    def misreported_fetch(uids, fields):
        if fields == ['RFC822.SIZE']:
            return {uids[0]: {b'RFC822.SIZE': 47742}}
        if fields == ['BODY.PEEK[]']:
            return {uids[0]: {b'BODY[]':full_body[0]}}
        offset = int(fields[0].split('<', 1)[1].split('.')[0])
        return {uids[0]: {f'BODY[]<{offset}>'.encode():small[offset:]}}
    imap.fetch.side_effect = misreported_fetch
    with patch.object(mail, '_reconnect') as reconnect:
        assert mail.fetch_uid_bounded(12, 'INBOX') == small
        reconnect.assert_not_called()
    assert progress[-1] == (12, 47740, 47740)
    for unconfirmed in (None, b'', small[:-2], b'changed' + small, b'x' * (BODY_CHUNK_BYTES + 1)):
        full_body[0] = unconfirmed
        with patch.object(mail, '_reconnect') as reconnect, patch('app.imap_client.time.sleep'):
            try: mail.fetch_uid_bounded(12, 'INBOX')
            except RuntimeError: pass
            else: raise AssertionError('An unconfirmed or changed partial body was accepted')
            assert reconnect.call_count == 2, 'A true incomplete download must still retry'
    # A complete response can also repair missing partial bytes without any
    # trimming or synthesized line endings.
    full_body[0] = small + b'\r\n'
    assert mail.fetch_uid_bounded(12, 'INBOX') == small + b'\r\n'

    clock = [100.0]
    def expired_fetch(uids, fields):
        result = misreported_fetch(uids, fields)
        if fields == ['BODY.PEEK[]<47740.2>']:
            clock[0] = 221.0
        return result
    imap.fetch.side_effect = expired_fetch
    imap.fetch.reset_mock()
    with patch('app.imap_client.time.monotonic', side_effect=lambda:clock[0]), patch.object(mail, '_reconnect') as reconnect:
        try: mail.fetch_uid_bounded(12, 'INBOX')
        except TimeoutError: pass
        else: raise AssertionError('An expired download started a new whole-body request')
        reconnect.assert_not_called()
    assert not any(call.args[1]==['BODY.PEEK[]'] for call in imap.fetch.call_args_list)

    # Whole-body fallback is restricted to small messages; large bodies keep
    # their chunk bound and cannot turn a short FETCH into an unbounded read.
    imap.fetch.side_effect = lambda uids,fields: ({uids[0]:{b'RFC822.SIZE':BODY_CHUNK_BYTES+1}}
        if fields==['RFC822.SIZE'] else {uids[0]:{b'BODY[]<0>':b'x'}})
    imap.fetch.reset_mock()
    with patch.object(mail, '_reconnect'), patch('app.imap_client.time.sleep'):
        try: mail.fetch_uid_bounded(13, 'INBOX')
        except RuntimeError: pass
        else: raise AssertionError('Large incomplete mail was accepted')
    assert not any(call.args[1]==['BODY.PEEK[]'] for call in imap.fetch.call_args_list)

    imap.fetch.side_effect = TimeoutError('network down')
    with patch.object(mail, '_reconnect', side_effect=TimeoutError('reconnect failed')):
        try:
            list(RawMessageBatch(imap, 'INBOX', [10, 11], tolerate_missing=True,
                                 fetcher=mail.fetch_uid_bounded))
        except MailTransportError:
            pass
        else:
            raise AssertionError('A disconnected mailbox must stop instead of deferring every UID')

    with tempfile.TemporaryDirectory() as root, use({'DB_PATH': str(Path(root) / 'mail.db'), 'ACCOUNT_ID': 'test'}):
        db.init_db()
        db.observe_uid_validity('INBOX', 1)
        db.set_last_uid('INBOX', 10)
        db.defer_mail_fetch('INBOX', 11, 'read timeout', retry_after=600)
        db.set_last_uid('INBOX', 12)
        db.set_last_uid('INBOX', 11)
        assert db.get_last_uid('INBOX') == 12, 'Retrying an older UID must not rewind the cursor'
        assert db.mail_fetch_retry_summary('INBOX')['count'] == 1
        assert db.due_mail_fetch_retries('INBOX') == []
        assert db.retry_all_mail_fetch_now('INBOX') == 1
        assert db.due_mail_fetch_retries('INBOX') == [11]
        db.clear_mail_fetch_retry('INBOX', 11)
        assert db.mail_fetch_retry_summary('INBOX')['count'] == 0
        db.defer_mail_fetch('INBOX', 14, 'too large', size=51 * 1024 * 1024)
        assert db.mail_fetch_retry_summary('INBOX')['oversized'] == 0
        assert db.retry_all_mail_fetch_now('INBOX') == 1
        assert db.due_mail_fetch_retries('INBOX') == [14]
        db.clear_mail_fetch_retry('INBOX', 14)
        db.defer_mail_fetch('INBOX', 15, 'too large', size=257 * 1024 * 1024)
        assert db.mail_fetch_retry_summary('INBOX')['oversized'] == 1
        assert db.retry_all_mail_fetch_now('INBOX') == 0
        assert db.due_mail_fetch_retries('INBOX') == []
        db.defer_mail_fetch('INBOX', 13, 'stale UID', retry_after=600)
        db.observe_uid_validity('INBOX', 2, reset=True)
        assert db.mail_fetch_retry_summary('INBOX')['count'] == 0
    print('Chunked download, retry, oversized guard, cursor and UID generation passed')


if __name__ == '__main__':
    main()
