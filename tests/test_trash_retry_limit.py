"""Deletion sync ends after two retries; local mail and send jobs stay intact."""
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import HTTPException
from app import config, db, trash_queue, trash_purge
from app.account_context import use
from app.web.routes.mail_actions import api_action_sync, api_retry_action_sync, api_bulk_email_action, BulkMailRequest
from app.web.routes.mail_read import api_emails


def add(uid, phase='trash'):
    eid = db.upsert_email(dict(uid=uid, folder='INBOX', status='inbox', subject='保留本地邮件',
                               from_addr='test@example.test', message_id=f'<{uid}@example.test>'))
    db.queue_trash([eid], 0)
    db.advance_trash_action([eid], action=phase, target='Trash')
    return eid


def due(eid):
    with db.conn() as c:
        c.execute("UPDATE emails SET pending_due_at='' WHERE id=?", (eid,))


class Offline:
    calls = 0

    def __enter__(self):
        type(self).calls += 1
        raise OSError('offline')

    def __exit__(self, *args):
        pass


class NoTrashFolder(Offline):
    def __enter__(self):
        type(self).calls += 1
        return self

    def ensure_trash_folder(self):
        raise OSError('cannot discover trash folder')


class UnknownCopy(NoTrashFolder):
    copies = 0

    def ensure_trash_folder(self):
        return 'Trash'

    def find_message_uid(self, *args):
        return None

    def copy_many(self, *args):
        type(self).copies += 1
        raise OSError('COPY result unknown')

    def delete_many(self, *args):
        raise AssertionError('uncertain COPY must never delete source')


with tempfile.TemporaryDirectory() as root, patch.object(config, 'DB_PATH', str(Path(root) / 'mail.db')):
    db.init_db()
    for n, phase in enumerate(('trash', 'trash_copying', 'trash_copied', 'trash_locating'), 1):
        eid = add(n, phase)
        for failure in (1, 2, 3):
            db.retry_trash_action([eid], 'unavailable')
            row = db.get_email(eid)
            assert row['pending_attempts'] == failure
            assert row['pending_action'] == (phase if failure < 3 else 'trash_local')
        assert row['pending_due_at'] is None and row['remote_missing'] == 1
        assert api_action_sync(True)['total'] == 0
        assert not db.due_trash_actions()
        db.retry_trash_action([eid], 'late failure')
        assert db.get_email(eid)['pending_attempts'] == 3
        assert not db.finish_trash_action(eid, 'Trash', 900 + n)
        db.advance_trash_action([eid], action='trash_copied', target='Trash')
        assert db.get_email(eid)['pending_action'] == 'trash_local'
        try:
            api_retry_action_sync(eid)
        except HTTPException as exc:
            assert exc.status_code == 409
        else:
            raise AssertionError('discarded job must not restart')

        # A full source-folder refresh must not bring a deleted mail back.
        db.reconcile_folder('INBOX', list(range(1, 5)))
        assert db.get_email(eid)['remote_missing'] == 1
        assert not any(e['id'] == eid for e in api_emails(status='inbox', days=9999))
        assert any(e['id'] == eid for e in api_emails(status='trash', days=9999))
        assert trash_purge._eligible(db.get_email(eid))
        with patch.object(trash_queue, 'MailClient', side_effect=AssertionError('no remote restore')):
            assert db.cancel_pending_trash(eid)
        restored = db.get_email(eid)
        assert restored['is_local_archive'] == 1 and not restored['remote_missing']
        assert not restored['pending_action'] and restored['status'] == 'inbox'
        # Restored local copies can be deleted again without creating new jobs.
        assert api_bulk_email_action(BulkMailRequest(ids=[eid], action='trash'))['completed'] == 1
        assert db.get_email(eid)['pending_action'] == 'trash_local'
        assert api_bulk_email_action(BulkMailRequest(ids=[eid], action='cancel_trash'))['completed'] == 1

    # Budget survives phase changes and successful COPY without COPYUID.
    eid = add(10)
    db.retry_trash_action([eid], 'first failure')
    db.retry_trash_action([eid], 'second failure')
    db.advance_trash_action([eid], action='trash_copied', target='Trash')
    assert db.finish_trash_action(eid, 'Trash', None)
    assert db.get_email(eid)['pending_attempts'] == 2
    db.retry_trash_action([eid], 'target not visible')
    assert db.get_email(eid)['pending_action'] == 'trash_local'

    # Legacy retries, including paused rows, disappear when opening the panel.
    old = [add(20), add(21, 'trash_copying')]
    with db.conn() as c:
        c.execute("UPDATE emails SET pending_attempts=59,pending_due_at='9999-12-31T23:59:59' WHERE id IN (?,?)", old)
        c.execute("INSERT INTO outbox(token,payload,status,due_at,created_at,updated_at) VALUES('keep','{}','failed','','','')")
    assert api_action_sync(True) == {'rows': [], 'total': 0, 'paused_count': 0}
    assert all(db.get_email(eid)['pending_action'] == 'trash_local' for eid in old)
    with db.conn() as c:
        assert c.execute("SELECT status FROM outbox WHERE token='keep'").fetchone()[0] == 'failed'

    # No connection is attempted for exhausted jobs, across restarts/polls.
    with patch.object(trash_queue, 'MailClient', side_effect=AssertionError('retired jobs must stay retired')):
        for _ in range(3):
            assert trash_queue.process_due() == {'processed': 0, 'failed': 0}

    # Login, folder discovery and unknown COPY all consume the same budget.
    for uid, fake in enumerate((Offline, NoTrashFolder, UnknownCopy), 30):
        eid = add(uid)
        fake.calls = 0
        with patch.object(trash_queue, 'MailClient', fake):
            for failure in (1, 2, 3):
                due(eid)
                assert trash_queue.process_due() == {'processed': 0, 'failed': 1}
                assert db.get_email(eid)['pending_attempts'] == failure
            assert trash_queue.process_due() == {'processed': 0, 'failed': 0}
        assert fake.calls == 3
        assert db.get_email(eid)['pending_action'] == 'trash_local'
    assert UnknownCopy.copies == 1

    # A successful final retry still completes normally.
    eid = add(40)
    db.retry_trash_action([eid], 'first')
    db.retry_trash_action([eid], 'second')
    assert db.finish_trash_action(eid, 'Trash', 140)
    assert not db.get_email(eid)['pending_action']

    # Retiring jobs in one account must not consume another account's budget.
    with use({'ACCOUNT_ID': 'other', 'DB_PATH': str(Path(root) / 'other.db')}):
        db.init_db()
        other = add(1)
        assert api_action_sync()['total'] == 1
        assert db.get_email(other)['pending_attempts'] == 0
    assert api_action_sync()['total'] == 0

print('PASS bounded deletion retries, legacy retirement, local visibility/restore, no repeated COPY and account isolation')
