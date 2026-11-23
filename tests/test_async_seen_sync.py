"""Read/unread actions are instant locally and eventually consistent remotely."""
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import db, seen_sync
from app.account_context import use
from app.web import server


class FakeMail:
    calls = []
    on_write = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def set_seen_many(self, uids, folder, value):
        self.calls.append((uids, folder, value))
        if type(self).on_write:
            type(self).on_write()


def main():
    with tempfile.TemporaryDirectory() as root, use({
        'ACCOUNT_ID': 'seen-test', 'DB_PATH': str(Path(root) / 'mail.db')
    }):
        db.init_db()
        email_id = db.upsert_email({
            'uid': 42, 'folder': 'INBOX', 'subject': 'fixture',
            'from_addr': 'sender@example.test', 'is_read': 0,
        })

        before, after = db.queue_seen_sync([email_id], True)
        assert before[0]['is_read'] == 0 and after[0]['is_read'] == 1
        db.sync_mail_flags(email_id, is_read=False, is_starred=False)
        assert db.get_email(email_id)['is_read'] == 1, \
            'A routine mailbox refresh must not overwrite a queued local choice'
        first = db.due_seen_sync_jobs()[0]
        db.queue_seen_sync([email_id], False)
        latest = db.due_seen_sync_jobs()[0]
        assert latest['desired_value'] == 0
        assert latest['generation'] == first['generation'] + 1
        assert db.get_email(email_id)['is_read'] == 0

        FakeMail.calls = []
        FakeMail.on_write = lambda: db.queue_seen_sync([email_id], True)
        with patch.object(seen_sync, 'MailClient', FakeMail):
            result = seen_sync.process_due()
        assert result == {'processed': 1, 'failed': 0}
        assert FakeMail.calls == [([42], 'INBOX', False)]
        pending = db.due_seen_sync_jobs()
        assert len(pending) == 1 and pending[0]['desired_value'] == 1, \
            'A newer toggle must survive completion of the in-flight write'

        FakeMail.calls = []
        FakeMail.on_write = None
        with patch.object(seen_sync, 'MailClient', FakeMail):
            seen_sync.process_due()
        assert FakeMail.calls == [([42], 'INBOX', True)]
        assert db.due_seen_sync_jobs() == []

        db.queue_seen_sync([email_id], False)
        with patch.object(seen_sync, 'MailClient', side_effect=OSError('offline')):
            result = seen_sync.process_due()
        assert result == {'processed': 0, 'failed': 1}
        with db.conn() as c:
            queued = c.execute('SELECT * FROM seen_sync_jobs WHERE email_id=?', (email_id,)).fetchone()
        assert queued['attempts'] == 1 and queued['last_error'] == 'offline'
        assert queued['due_at'] > queued['updated_at']

        # HTTP actions must return after the durable local transaction and must
        # never open IMAP on the request thread.
        with patch.object(server, 'MailClient', side_effect=AssertionError('request touched IMAP')):
            response = server.api_set_email_read(email_id, True)
            assert response['sync_pending'] and db.get_email(email_id)['is_read'] == 1
            response = server.api_bulk_email_action(server.BulkMailRequest(
                ids=[email_id], action='read', value=False
            ))
            assert response['queued'] == 1 and db.get_email(email_id)['is_read'] == 0

        with db.conn() as c:
            c.execute("INSERT INTO assistant_conversations(id,title) VALUES(10,'conv')")
            c.execute("INSERT INTO assistant_mail_context(conversation_id,email_id) VALUES(10,?)", (email_id,))
            c.execute("INSERT INTO assistant_document_refs(conversation_id,refs) VALUES(10,'[]')")
            c.execute("INSERT INTO assistant_messages(id,conversation_id,role,content) VALUES(20,10,'user','hi')")
            c.execute("INSERT INTO assistant_search_runs(id,conversation_id,message_id,payload,created_at) VALUES('r1',10,20,'{}','2026-01-01')")
            c.execute("INSERT INTO assistant_images(id,message_id,mime,payload,thumbnail) VALUES(30,20,'image/png',X'00',X'00')")
            c.execute('DELETE FROM emails WHERE id=?', (email_id,))
            assert c.execute('SELECT count(*) FROM seen_sync_jobs WHERE email_id=?', (email_id,)).fetchone()[0] == 0
            c.execute('DELETE FROM assistant_conversations WHERE id=10')
            for table in ('assistant_mail_context', 'assistant_document_refs', 'assistant_search_runs', 'assistant_messages', 'assistant_images'):
                assert c.execute(f'SELECT count(*) FROM {table}').fetchone()[0] == 0, table

    print('Async seen sync: optimistic local state, coalescing, race safety and retry passed')


if __name__ == '__main__':
    main()
