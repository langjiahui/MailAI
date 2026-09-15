"""Mailbox rows should reuse exact local contact names without changing addresses."""
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import config, db
from app.web import server


def main():
    with tempfile.TemporaryDirectory() as root, patch.multiple(
        config,
        DB_PATH=os.path.join(root, "mail.db"),
        IMAP_USER="me@example.test",
    ):
        db.init_db()
        db.upsert_email({
            "uid": 1, "folder": "INBOX", "from_addr": "person@example.test",
            "from_name": "张三", "to_addr": "me@example.test", "subject": "较早邮件",
            "date": "2026-09-01T10:00:00", "status": "inbox",
        })
        newest = db.upsert_email({
            "uid": 2, "folder": "INBOX", "from_addr": "PERSON@example.test",
            "from_name": "person", "to_addr": "me@example.test", "subject": "最新邮件",
            "date": "2026-09-10T10:00:00", "status": "inbox",
        })

        learned = next(row for row in server.api_emails(days=9999) if row["id"] == newest)
        assert learned["counterpart_name"] == "张三"
        assert learned["counterpart_addr"] == "PERSON@example.test"
        assert learned["counterpart_name_source"] == "history"

        db.save_contact("person@example.test", "李经理", "研发部")
        manual = next(row for row in server.api_emails(days=9999) if row["id"] == newest)
        assert manual["counterpart_name"] == "李经理"
        assert manual["counterpart_addr"] == "PERSON@example.test"
        assert server.api_email_detail(newest)["from_name"] == "李经理"

        sent_id = db.create_sent_message({
            "from_addr": "me@example.test", "to_addr": "person@example.test",
            "subject": "发送测试", "body_html": "<p>您好</p>",
        })
        sent = next(row for row in server.api_sent_messages() if row["id"] == sent_id)
        assert sent["counterpart_name"] == "李经理"
        assert sent["counterpart_addr"] == "person@example.test"
        assert sent["counterpart_name_source"] == "manual"
        assert sent["recipient_names"] == {"person@example.test": "李经理"}

        raw = Path(root, "recipient-names.eml")
        raw.write_bytes(
            "From: sender@example.test\r\n"
            "To: 陈乐媛 <chenleyuan@example.test>, 陈军红 <chenjunhong@example.test>\r\n"
            "Subject: names\r\n\r\nbody".encode("utf-8")
        )
        header_mail = db.upsert_email({
            "uid": 3, "folder": "INBOX", "from_addr": "sender@example.test",
            "to_addr": "chenleyuan <chenleyuan@example.test>, chenjunhong@example.test",
            "subject": "names", "date": "2026-09-10T12:00:00", "status": "inbox",
            "raw_path": str(raw), "recipient_names": {},
        })
        detail = server.api_email_detail(header_mail)
        assert detail["recipient_names"]["chenleyuan@example.test"] == "陈乐媛"
        assert detail["recipient_names"]["chenjunhong@example.test"] == "陈军红"
        suggestion = db.search_contacts("chenleyuan@example.test")[0]
        assert suggestion["name"] == "陈乐媛"
        db.upsert_email({
            "uid": 4, "folder": "INBOX", "from_addr": "other@example.test",
            "to_addr": "李四 <li@example.test>", "recipient_names": {"li@example.test": "李四"},
            "subject": "structured names", "date": "2026-09-10T13:00:00", "status": "inbox",
        })
        assert db.contact_display_names(["li@example.test"])["li@example.test"]["name"] == "李四"

        names = {
            "chenleyuan@example.test": {"name": "陈乐媛", "source": "header"},
        }
        assert server._resolved_contact_name(
            "chenleyuan@example.test", "chenleyuan", names
        ) == ("陈乐媛", "header")
        assert server._resolved_contact_name(
            "chenleyuan@example.test", "陈老师", names
        ) == ("陈老师", "message")

    print("Inbox, sent mail and detail reuse exact local contact names")


if __name__ == "__main__":
    main()
