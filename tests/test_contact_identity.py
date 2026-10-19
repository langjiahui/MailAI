"""Mailbox rows should reuse exact local contact names without changing addresses."""
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch
from email.header import Header
from email.utils import formataddr, getaddresses

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import config, db, smtp_client
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

        # Historical SMTP receipts contain RFC 2047 names. Both API paths must
        # return readable, reusable fields without rewriting the stored receipt.
        fields = {
            "to_addr": ", ".join([
                formataddr(("测试姓名", "named@example.test")),
                formataddr(("张三, 采购;项目", "team@example.test")),
            ]),
            "cc_addr": f'{Header("抄送姓名", "gb2312").encode()} <cc@example.test>',
            "bcc_addr": '=?utf-8?q?=E5=AF=86=E9=80=81=E5=A7=93=E5=90=8D?= <bcc@example.test>',
        }
        encoded_id = db.create_sent_message({
            **fields, "from_addr": "me@example.test", "subject": "历史编码姓名",
        })
        listed = next(row for row in server.api_sent_messages() if row["id"] == encoded_id)
        detail = server.api_sent_message(encoded_id)
        expected_names = {
            "named@example.test": "测试姓名", "team@example.test": "张三, 采购;项目",
            "cc@example.test": "抄送姓名", "bcc@example.test": "密送姓名",
        }
        for row in (listed, detail):
            assert row["counterpart_name"] == "测试姓名"
            assert row["counterpart_addr"] == "named@example.test"
            assert row["recipient_names"] == expected_names
            for key in fields:
                assert "=?" not in row[key], row[key]
            assert getaddresses([row["to_addr"]]) == [
                ("测试姓名", "named@example.test"), ("张三, 采购;项目", "team@example.test"),
            ]
            # Again-editing these API values must preserve delivery recipients.
            assert smtp_client.normalize_recipient_fields(row)["recipients"] == [
                "named@example.test", "team@example.test", "cc@example.test", "bcc@example.test",
            ]
        with db.conn() as c:
            stored = c.execute("SELECT to_addr,cc_addr,bcc_addr FROM sent_messages WHERE id=?", (encoded_id,)).fetchone()
            assert dict(stored) == fields

        db.save_contact("named@example.test", "人工姓名")
        assert server.api_sent_message(encoded_id)["recipient_names"]["named@example.test"] == "人工姓名"
        # Unknown legacy charset labels must not prevent opening the sent folder.
        broken_id = db.create_sent_message({
            "from_addr": "me@example.test",
            "to_addr": "=?unknown-charset?b?5rWL6K+V?= <broken@example.test>",
        })
        broken = next(row for row in server.api_sent_messages() if row["id"] == broken_id)
        assert broken["to_addr"] == "测试 <broken@example.test>"
        assert server.api_sent_message(broken_id)["counterpart_name"] == "测试"

        # Reusing displayed fields must still generate correct MIME headers and
        # an identical SMTP envelope, with Bcc excluded from message headers.
        with patch.multiple(config, SMTP_HOST="smtp.example.test", SMTP_USE_IMAP_CREDENTIALS=True,
                            IMAP_PASSWORD="test-only"):
            message, envelope = smtp_client.build_message({**detail, "body_html": "<p>离线测试</p>"})
        assert envelope == ["named@example.test", "team@example.test", "cc@example.test", "bcc@example.test"]
        assert [(item.display_name, item.addr_spec) for item in message["To"].addresses] == [
            ("测试姓名", "named@example.test"), ("张三, 采购;项目", "team@example.test"),
        ]
        assert message["Bcc"] is None

        # Encoded names can also survive in old contacts or imported metadata.
        encoded_name = Header("历史姓名", "utf-8").encode()
        assert server._resolved_contact_name("old@example.test", encoded_name, {}) == ("历史姓名", "message")
        assert server._resolved_contact_name("old@example.test", "old", {
            "old@example.test": {"name": encoded_name, "source": "manual"},
        }) == ("历史姓名", "manual")

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
