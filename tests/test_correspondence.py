"""Correspondence history includes exact inbound and outbound matches only."""
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config, db
from app.web import server


def main():
    with tempfile.TemporaryDirectory() as root, patch.object(config, "DB_PATH", os.path.join(root, "mail.db")), patch.object(config, "IMAP_USER", "me@example.com"):
        db.init_db()
        rows = [
            (1, "INBOX", "alice@example.com", "me@example.com", "收到的邮件", "2026-09-03T10:00:00"),
            (2, "Sent", "me@example.com", "Alice <alice@example.com>", "发出的邮件", "2026-09-02T10:00:00"),
            (3, "INBOX", "alice@example.com.invalid", "me@example.com", "相似地址不应命中", "2026-09-01T10:00:00"),
        ]
        with db.conn() as connection:
            for uid, folder, sender, recipient, subject, date in rows:
                connection.execute(
                    "INSERT INTO emails(uid,folder,from_addr,to_addr,subject,date,created_at,remote_missing) VALUES(?,?,?,?,?,?,?,0)",
                    (uid, folder, sender, recipient, subject, date, date),
                )
        result = db.list_correspondence_emails("ALICE@example.com", limit=20)
        assert [item["subject"] for item in result] == ["收到的邮件", "发出的邮件"]
        assert not db.list_correspondence_emails("", limit=20)
        payload = server.api_contact_correspondence("alice@example.com", limit=20)
        assert payload["counterpart"] == "alice@example.com"
        assert [item["direction"] for item in payload["emails"]] == ["received", "sent"]
        # Count beyond the first page, omit deleted/unavailable copies and
        # count each matching message once even when the address repeats.
        with db.conn() as connection:
            for uid in range(4, 110):
                connection.execute("INSERT INTO emails(uid,folder,from_addr,to_addr,subject,date,created_at,remote_missing,status) VALUES(?,?,?,?,?,?,?,0,'inbox')",
                                   (uid, 'INBOX', 'alice@example.com', 'alice@example.com, me@example.com', 'Page ' + str(uid), '2026-10-01', '2026-10-01'))
            connection.execute("UPDATE emails SET status='trash' WHERE uid=4")
            connection.execute("UPDATE emails SET remote_missing=1 WHERE uid=5")
        from app.db.emails import correspondence_page
        first = correspondence_page('alice@example.com')
        assert first['total'] == 106 and len(first['emails']) == 50 and first['has_more']
        second = correspondence_page('alice@example.com', 50, 50)
        third = correspondence_page('alice@example.com', 50, 100)
        assert len(second['emails']) == 50 and len(third['emails']) == 6 and not third['has_more']
        assert len({row['id'] for page in [first, second, third] for row in page['emails']}) == 106
        contact = next(row for row in db.search_contacts('alice@example.com') if row['email'] == 'alice@example.com')
        assert contact['correspondence_count'] == first['total']
    print("✅ 往来邮件双向匹配、排序与精确地址过滤测试通过")


if __name__ == "__main__":
    main()
