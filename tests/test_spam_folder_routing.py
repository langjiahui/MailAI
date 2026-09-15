"""Spam actions must use the provider-designated Junk mailbox."""
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config, db, pipeline
from app.imap_client import MailClient, mailbox_role
from app.web.server import _annotate_list_identity


def main():
    assert mailbox_role({"name": "Junk E-mail", "flags": []}) == "spam"
    finder = MailClient()
    finder.client = MagicMock()
    finder.client.list_folders.return_value = [
        ([b"\\HasNoChildren"], b"/", b"INBOX"),
        ([b"\\HasNoChildren", b"\\Junk"], b"/", b"Junk E-mail"),
    ]
    assert finder.mailbox_for_role("spam") == "Junk E-mail"
    with patch.object(config, "IMAP_USER", "me@example.test"):
        outgoing = {"from_addr": "ME@example.test", "to_addr": "Alice <alice@example.test>, bob@example.test"}
        incoming = {"from_addr": "sender@example.test", "from_name": "Sender", "to_addr": "me@example.test"}
        _annotate_list_identity(outgoing)
        _annotate_list_identity(incoming)
    assert (outgoing["direction"], outgoing["counterpart_name"], outgoing["counterpart_count"]) == ("outgoing", "Alice", 2)
    assert (incoming["direction"], incoming["counterpart_name"]) == ("incoming", "Sender")

    with tempfile.TemporaryDirectory() as root, patch.object(config, "DB_PATH", os.path.join(root, "mail.db")):
        db.init_db()
        email_id = db.upsert_email({
            "uid": 17, "folder": config.INBOX_FOLDER, "status": "inbox",
            "recommended_status": "spam", "verdict": "suspicious", "score": 40,
            "subject": "Newsletter", "from_addr": "sender@example.test",
            "message_id": "<spam-route@example.test>",
        })
        mail = MagicMock()
        mail.__enter__.return_value = mail
        mail.move_to_spam.return_value = (71, "Junk E-mail")
        with patch("app.pipeline.MailClient", return_value=mail):
            result = pipeline.confirm_email(email_id)
        assert result == {"ok": True, "moved": True, "status": "spam", "folder": "Junk E-mail", "recovered": ""}
        mail.move_to_spam.assert_called_once_with(17, config.INBOX_FOLDER)
        row = db.get_email(email_id)
        assert (row["folder"], row["uid"], row["status"]) == ("Junk E-mail", 71, "spam")

        restore_mail = MagicMock()
        restore_mail.__enter__.return_value = restore_mail
        restore_mail.client.search.return_value = [71]
        restore_mail.move.return_value = 81
        with patch("app.pipeline.MailClient", return_value=restore_mail):
            assert pipeline.restore_email(email_id)
        restore_mail.client.select_folder.assert_called_once_with("Junk E-mail")
        restore_mail.move.assert_called_once_with(71, "Junk E-mail", config.INBOX_FOLDER)
        restored = db.get_email(email_id)
        assert (restored["folder"], restored["uid"], restored["status"]) == (config.INBOX_FOLDER, 81, "inbox")

        stale_id = db.upsert_email({
            "uid": 18, "folder": config.INBOX_FOLDER, "status": "inbox",
            "recommended_status": "spam", "verdict": "suspicious", "score": 40,
            "subject": "Stale UID", "from_addr": "sender@example.test",
            "message_id": "<stale-route@example.test>",
        })
        stale_mail = MagicMock()
        stale_mail.__enter__.return_value = stale_mail
        stale_mail.move_to_spam.side_effect = [RuntimeError("源邮件已不存在，请重新同步文件夹"), (72, "Junk E-mail")]
        stale_mail.find_message_uid.return_value = 28
        with patch("app.pipeline.MailClient", return_value=stale_mail):
            stale_result = pipeline.confirm_email(stale_id)
        assert stale_result["recovered"] == "stale_uid"
        assert db.get_email(stale_id)["uid"] == 72
        assert stale_mail.move_to_spam.call_args_list[1].args == (28, config.INBOX_FOLDER)

        moved_id = db.upsert_email({
            "uid": 19, "folder": config.INBOX_FOLDER, "status": "inbox",
            "recommended_status": "spam", "verdict": "suspicious", "score": 40,
            "subject": "Already moved", "from_addr": "sender@example.test",
            "message_id": "<already-route@example.test>",
        })
        moved_mail = MagicMock()
        moved_mail.__enter__.return_value = moved_mail
        moved_mail.move_to_spam.side_effect = RuntimeError("源邮件已不存在，请重新同步文件夹")
        moved_mail.ensure_spam_folder.return_value = "Junk E-mail"
        moved_mail.find_message_uid.side_effect = [None, 73]
        with patch("app.pipeline.MailClient", return_value=moved_mail):
            moved_result = pipeline.confirm_email(moved_id)
        assert moved_result["recovered"] == "already_moved"
        assert (db.get_email(moved_id)["folder"], db.get_email(moved_id)["uid"]) == ("Junk E-mail", 73)

        missing_id = db.upsert_email({
            "uid": 20, "folder": config.INBOX_FOLDER, "status": "inbox",
            "recommended_status": "spam", "verdict": "suspicious", "score": 40,
            "subject": "Removed", "from_addr": "sender@example.test",
            "message_id": "<removed-route@example.test>",
        })
        missing_mail = MagicMock()
        missing_mail.__enter__.return_value = missing_mail
        missing_mail.move_to_spam.side_effect = RuntimeError("源邮件已不存在，请重新同步文件夹")
        missing_mail.ensure_spam_folder.return_value = "Junk E-mail"
        missing_mail.find_message_uid.return_value = None
        with patch("app.pipeline.MailClient", return_value=missing_mail):
            try:
                pipeline.confirm_email(missing_id)
                raise AssertionError("Missing remote message should not be confirmed")
            except pipeline.RemoteMessageUnavailable:
                pass
        assert db.get_email(missing_id)["remote_missing"] == 1

    print("Server Junk routing and exact-folder restore tests passed")


if __name__ == "__main__":
    main()
