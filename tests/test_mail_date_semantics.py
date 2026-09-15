"""Historical imports must not appear as mail received today."""
import os
import sys
import tempfile
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import config, db


def record(uid, received_at):
    return {
        "uid": uid, "folder": "INBOX", "subject": f"mail-{uid}",
        "from_addr": "sender@example.test", "to_addr": "me@example.test",
        "date": received_at, "status": "inbox", "verdict": "clean",
        "score": 0, "findings": [], "attachments": [], "urls": [],
    }


def main():
    original = config.DB_PATH
    with tempfile.TemporaryDirectory() as td:
        try:
            config.DB_PATH = os.path.join(td, "mailai.db")
            db.init_db()
            now = datetime.now()
            db.upsert_email(record(1, now.isoformat(timespec="seconds")))
            db.upsert_email(record(2, (now - timedelta(days=40)).isoformat(timespec="seconds")))
            db.upsert_email(record(3, ""))  # malformed/missing date safely falls back to indexed time

            recent = db.list_emails(days=1, limit=20)
            assert {row["uid"] for row in recent} == {1, 3}, recent
            assert db.stats_today()["today"] == 2
            assert db.stats_range(7)["total"] == 2
            trend = db.daily_trend(7)
            assert sum(item.get("clean", 0) for item in trend.values()) == 2
        finally:
            config.DB_PATH = original
    print("Mail received-date semantics passed")


if __name__ == "__main__":
    main()
