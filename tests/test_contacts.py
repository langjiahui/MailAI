"""Address book merges learned correspondents with user-managed contact data."""
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config, db


def main():
    with tempfile.TemporaryDirectory() as root, patch.object(config, "DB_PATH", os.path.join(root, "mail.db")), \
         patch.object(config, "IMAP_USER", "me@example.com"):
        db.init_db()
        with db.conn() as connection:
            connection.execute(
                "INSERT INTO emails(uid,folder,from_addr,from_name,to_addr,date,created_at) VALUES(1,'INBOX',?,?,?,?,?)",
                ("alice@example.com", "Alice History", "Me <me@example.com>", "2026-09-01T10:00:00", "2026-09-01T10:00:00"),
            )
            connection.execute(
                "INSERT INTO sent_messages(to_addr,cc_addr,status,created_at,sent_at) VALUES(?,?,'sent',?,?)",
                ("Alice <alice@example.com>", "bob@example.com", "2026-09-02T10:00:00", "2026-09-02T10:00:00"),
            )
            connection.execute(
                "INSERT INTO emails(uid,folder,from_addr,from_name,to_addr,date,created_at) VALUES(2,'INBOX',?,?,?,?,?)",
                ("changed@example.com", "旧姓名", "me@example.com", "2026-09-01T10:00:00", "2026-09-01T10:00:00"),
            )
            connection.execute(
                "INSERT INTO emails(uid,folder,from_addr,from_name,to_addr,date,created_at) VALUES(3,'INBOX',?,?,?,?,?)",
                ("changed@example.com", "新姓名", "me@example.com", "2026-09-03T10:00:00", "2026-09-03T10:00:00"),
            )

        learned = db.search_contacts()
        assert [item["email"] for item in learned] == ["alice@example.com", "changed@example.com", "bob@example.com"]
        assert learned[0]["count"] == 2 and learned[0]["name"] == "Alice History"
        assert db.search_contacts("changed@example.com")[0]["name"] == "新姓名"
        assert all(item["email"] != "me@example.com" for item in learned)

        saved = db.save_contact("ALICE@example.com", "Alice Zhang", "Example Co", "采购负责人", True)
        assert saved["name"] == "Alice Zhang" and saved["company"] == "Example Co"
        assert saved["favorite"] is True and saved["manual"] is True and saved["count"] == 2
        assert db.search_contacts(favorites_only=True)[0]["email"] == "alice@example.com"

        starred = db.set_contact_favorite("bob@example.com", True)
        assert starred["favorite"] is True and starred["manual"] is False
        assert db.save_contact("bob@example.com", "bob")["name"] == "bob"
        db.hide_contact("alice@example.com")
        assert not db.search_contacts("alice@example.com")
        assert db.contact_history(["alice@example.com"])["alice@example.com"] == 2
    print("✅ 通讯录历史学习、收藏、覆盖与隐藏测试通过")


if __name__ == "__main__":
    main()
