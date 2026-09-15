"""Optimistic local deletion and durable two-phase server trash regressions."""
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config, db, trash_queue
from app.imap_client import mailbox_role
from app.mail_undo import restore
from app.web import server


def add_email(uid=41, subject="待删除"):
    return db.upsert_email({
        "uid": uid, "folder": "INBOX", "status": "inbox", "subject": subject,
        "from_addr": "sender@example.test", "message_id": f"<{uid}@example.test>",
    })


def make_due(email_id):
    with db.conn() as connection:
        connection.execute(
            "UPDATE emails SET pending_due_at='2000-01-01T00:00:00' WHERE id=?", (email_id,)
        )


def main():
    old_db = config.DB_PATH
    with tempfile.TemporaryDirectory() as root:
        try:
            config.DB_PATH = os.path.join(root, "mailai.db")
            db.init_db()
            email_id = add_email()

            with patch.object(server, "MailClient", side_effect=AssertionError("request must not use IMAP")):
                result = server.api_bulk_email_action(
                    server.BulkMailRequest(ids=[email_id], action="trash")
                )
            row = db.get_email(email_id)
            assert result["queued"] == result["completed"] == 1 and not result["failed"]
            assert row["remote_missing"] == 1 and row["pending_action"] == "trash"
            assert (row["folder"], row["uid"]) == ("INBOX", 41)
            db.reconcile_folder("INBOX", [41])
            assert db.get_email(email_id)["remote_missing"] == 1, "sync must not resurrect queued mail"

            visible = server.api_emails(status='trash', days=9999)
            assert any(e['id'] == email_id and e['status'] == 'trash' and e['pending_action'] == 'trash' for e in visible)
            assert not db.list_emails(status='inbox', days=9999)
            assert db.get_email(email_id)['status'] == 'inbox'
            undone = restore(result["undo_token"])
            assert undone["ok"] and db.get_email(email_id)["remote_missing"] == 0

            server.api_bulk_email_action(server.BulkMailRequest(ids=[email_id], action="trash"))
            make_due(email_id)

            class FakeMail:
                copies = deletes = 0
                def __enter__(self): return self
                def __exit__(self, *_args): return False
                def ensure_trash_folder(self): return "Deleted Messages"
                def copy_many(self, uids, source, target):
                    assert (uids, source, target) == ([41], "INBOX", "Deleted Messages")
                    self.copies += 1
                    return {41: None}
                def delete_many(self, uids, source):
                    assert (uids, source) == ([41], "INBOX")
                    self.deletes += 1
                def find_message_uid(self, *_args): return None

            fake = FakeMail()
            with patch.object(trash_queue, "MailClient", lambda: fake), \
                 patch.object(trash_queue.pipeline, "sync_mail_folder", return_value={"ok": True}) as sync:
                outcome = trash_queue.process_due()
            row = db.get_email(email_id)
            assert outcome == {"processed": 1, "failed": 0}
            assert fake.copies == fake.deletes == 1
            assert row["pending_action"] == "trash_locating" and row["remote_missing"] == 1
            assert row["status"] == "trash" and row["folder"] == "INBOX"
            sync.assert_called_once_with("Deleted Messages")

            assert any(e['id'] == email_id for e in server.api_emails(status='trash', days=9999))
            # This case's unresolved UID is tested independently of the next batch.
            db.retry_trash_action([email_id], 'waiting for UID')
            repeat = server.api_bulk_email_action(server.BulkMailRequest(ids=[email_id], action='trash'))
            assert repeat['completed'] == 0 and repeat['failed']
            cancel_id = add_email(99)
            server.api_bulk_email_action(server.BulkMailRequest(ids=[cancel_id], action='trash'))
            assert server.api_bulk_email_action(server.BulkMailRequest(ids=[cancel_id], action='cancel_trash'))['completed'] == 1
            assert db.get_email(cancel_id)['remote_missing'] == 0

            # Copies left by an older build are reused instead of copied again.
            old_id = add_email(42, "旧版本已复制")
            server.api_bulk_email_action(server.BulkMailRequest(ids=[old_id], action="trash"))
            make_due(old_id)

            class ExistingCopyMail(FakeMail):
                def find_message_uid(self, folder, message_id):
                    assert folder == "Deleted Messages"
                    return 142 if message_id == "<42@example.test>" else None
                def copy_many(self, *_args):
                    raise AssertionError("an existing target copy must not be copied again")
                def delete_many(self, uids, source):
                    assert (uids, source) == ([42], "INBOX")

            with patch.object(trash_queue, "MailClient", ExistingCopyMail), \
                 patch.object(trash_queue.pipeline, "sync_mail_folder"):
                assert trash_queue.process_due()["processed"] == 1
            old_row = db.get_email(old_id)
            assert (old_row["folder"], old_row["uid"], old_row["remote_missing"]) == (
                "Deleted Messages", 142, 0
            )
            assert mailbox_role({"name": "Deleted Messages", "flags": []}) == "trash"
            repeat = server.api_bulk_email_action(server.BulkMailRequest(ids=[old_id], action='trash'))
            assert repeat['completed'] == 0 and repeat['failed']
            assert db.get_email(old_id)['pending_action'] == ''
            # Locate the unknown target UID without deleting/copying anything again.
            make_due(email_id)
            class LocateOnly(FakeMail):
                def find_message_uid(self, *_): return 141
                def copy_many(self, *_): raise AssertionError('must not copy again')
                def delete_many(self, *_): raise AssertionError('must not delete again')
            with patch.object(trash_queue, 'MailClient', LocateOnly):
                assert trash_queue.process_due()['processed'] == 1
            assert db.get_email(email_id)['uid'] == 141
            assert db.get_email(email_id)['remote_missing'] == 0
        finally:
            config.DB_PATH = old_db
    print("Optimistic trash queue, undo and QQ no-COPYUID flow passed")


if __name__ == "__main__":
    main()
