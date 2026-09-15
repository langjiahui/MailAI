"""Special-use folder mapping and imported Sent/Drafts remain first-class mail."""
import os
import sys
import tempfile
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import config, db, pipeline
from app.imap_client import mailbox_role
from app.web import server


RAW = (b"From: Me <me@example.test>\r\nTo: You <you@example.test>\r\n"
       b"Subject: Historical sent mail\r\nMessage-ID: <sent-1@example.test>\r\n"
       b"Date: Mon, 31 Aug 2026 10:00:00 +0800\r\nContent-Type: text/html; charset=utf-8\r\n\r\n"
       b"<p>Hello <strong>there</strong></p>")


def main():
    assert mailbox_role({"name": "Anything", "flags": ["\\Sent"]}) == "sent"
    assert mailbox_role({"name": "草稿箱", "flags": []}) == "draft"
    assert mailbox_role({"name": "隔离区", "flags": []}) == "quarantine"
    assert mailbox_role({"name": "All Mail", "flags": []}) == "all"
    assert mailbox_role({"name": "Projects", "flags": []}) == "folder"

    old_db, old_raw = config.DB_PATH, config.RAW_DIR
    with tempfile.TemporaryDirectory() as td:
        try:
            config.DB_PATH = os.path.join(td, "mailai.db")
            config.RAW_DIR = os.path.join(td, "raw")
            db.init_db()
            email_id = pipeline._store_folder_message("Sent", "sent", 7, RAW, ["\\Seen", "\\Flagged"])
            again = pipeline._store_folder_message("Sent", "sent", 7, RAW, ["\\Seen"])
            assert email_id == again
            row = db.get_email(email_id)
            assert row["status"] == "sent" and row["is_read"] == 1 and row["is_starred"] == 0
            assert len(db.list_special_folder_emails("sent")) == 1
            sent = server.api_sent_messages()
            remote = next(item for item in sent if item.get("_remote"))
            assert remote["id"] == -email_id and remote["remote_email_id"] == email_id
            assert remote["body_html"].startswith("<p>")

            draft_id = pipeline._store_folder_message("Drafts", "draft", 8, RAW, ["\\Draft"])

            class FakeMail:
                def __enter__(self): return self
                def __exit__(self, *_): return False
                def move_to_trash(self, uid, source):
                    assert (uid, source) == (8, "Drafts")
                    return 81, "Trash"

            with patch.object(server, "MailClient", FakeMail):
                result = server.api_delete_draft(-draft_id)
            moved = db.get_email(draft_id)
            assert result["remote"] is True
            assert moved["status"] == "trash" and moved["folder"] == "Trash" and moved["uid"] == 81
            assert not any(item["remote_email_id"] == draft_id for item in server.api_drafts()
                           if item.get("_remote"))

            # A complete server snapshot hides mail removed by another client,
            # while keeping the local row available for audit/source links.
            missing = db.reconcile_folder("Sent", [])
            assert missing == 1 and db.get_email(email_id)["remote_missing"] == 1
            assert not db.list_special_folder_emails("sent")
            db.reconcile_folder("Sent", [7])
            assert db.get_email(email_id)["remote_missing"] == 0
        finally:
            config.DB_PATH, config.RAW_DIR = old_db, old_raw
    print("Special folder synchronization semantics passed")


if __name__ == "__main__":
    main()
