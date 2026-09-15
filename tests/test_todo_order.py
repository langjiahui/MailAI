"""Todo center should read newest-first while keeping unfinished work visible."""
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config, db


def add_email(uid: int, subject: str, received_at: str) -> int:
    return db.upsert_email({
        "uid": uid,
        "folder": "INBOX",
        "subject": subject,
        "date": received_at,
    })


def main():
    with tempfile.TemporaryDirectory() as root, patch.object(config, "DB_PATH", os.path.join(root, "mail.db")):
        db.init_db()
        old_id = add_email(1, "较早邮件", "2026-08-30T09:00:00+08:00")
        new_id = add_email(2, "最新邮件", "2026-09-02T18:30:00+08:00")
        db.add_todos(old_id, [{"title": "较早待办", "deadline": "2026-09-10"}])
        db.add_todos(new_id, [{"title": "最新待办", "deadline": "2026-09-03"}])

        rows = db.list_todos(include_done=True)
        assert [row["title"] for row in rows] == ["最新待办", "较早待办"]
        assert rows[0]["email_date"] == "2026-09-02T18:30:00+08:00"

        for row in rows:
            db.set_todo_status(row["id"], "done")
        assert [row["title"] for row in db.list_todos(include_done=True)] == ["最新待办", "较早待办"]

        db.set_todo_status(rows[1]["id"], "open")
        mixed = db.list_todos(include_done=True)
        assert mixed[0]["status"] == "open"
        assert db.list_todos(include_done=False)[0]["title"] == "较早待办"
    print("✅ 待办按来源邮件时间倒序测试通过")


if __name__ == "__main__":
    main()
