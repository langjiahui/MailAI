"""Portable backup round-trip, integrity and cross-path regression tests."""
import json
import os
import tempfile
import zipfile
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config, db, portable_backup, system_settings


def test_portable_round_trip_and_integrity():
    with tempfile.TemporaryDirectory() as root:
        source_raw = Path(root, "mac-source", "raw")
        source_raw.mkdir(parents=True)
        values = dict(DATA_DIR=root, DB_PATH=str(Path(root, "mail.db")), RAW_DIR=str(source_raw),
                      IMAP_USER="move@example.test", IMAP_HOST="imap.old.example.test")
        with patch.multiple(config, **values):
            db.init_db()
            raw = source_raw / "folder" / "邮件.eml"
            raw.parent.mkdir(); raw.write_bytes(b"From: a@example.test\r\nSubject: portable\r\n\r\nhello")
            with db.conn() as connection:
                connection.execute("INSERT INTO emails(uid,folder,message_id,subject,raw_path,created_at,pending_action) VALUES(1,'INBOX','<portable@example.test>','portable',?,datetime('now'),'delete')", (str(raw),))
                connection.execute("INSERT INTO outbox(token,payload,status,due_at,created_at,updated_at) VALUES('send','{}','queued','','','')")
            result = portable_backup.create(password="")
            package = portable_backup.stored_path(result["filename"])
            preview = portable_backup.inspect(package)
            assert preview["format_version"] == 3 and preview["content"]["emails"] == 1
            assert portable_backup.list_stored()[0]["portable"] is True
            staged = portable_backup.stage_upload(Path(package).read_bytes())
            assert Path(portable_backup.staged_path(staged["import_token"])).is_file()
            portable_backup.discard_staged(staged["import_token"])
            assert not Path(root, "imports", staged["import_token"] + ".upload").exists()
            encrypted = portable_backup.create(password="a secure migration password")["filename"]
            encrypted_path = portable_backup.stored_path(encrypted)
            assert Path(encrypted_path).read_bytes().startswith(portable_backup.MAGIC)
            assert portable_backup.inspect(encrypted_path, password="a secure migration password")["encrypted"] is True
            try:
                portable_backup.inspect(encrypted_path, password="wrong password")
            except ValueError as exc:
                assert "密码错误" in str(exc)
            else:
                raise AssertionError("Encrypted package accepted a wrong password")
            deleted = portable_backup.delete_stored(encrypted)
            assert deleted["ok"] and not Path(encrypted_path).exists()
            unrelated = Path(root, "backups", "unrelated.txt"); unrelated.write_text("keep")
            try:
                portable_backup.delete_stored(unrelated.name)
            except ValueError:
                pass
            else:
                raise AssertionError("Unmanaged file deletion must fail")
            with zipfile.ZipFile(package) as archive:
                staged = Path(root, "snapshot.db"); staged.write_bytes(archive.read("mailai.db"))
                with sqlite_connection(staged) as connection:
                    reference = connection.execute("SELECT raw_path FROM emails").fetchone()[0]
                    assert reference.startswith("objects/")
                    assert connection.execute("SELECT pending_action FROM emails").fetchone()[0] == ""
                    assert connection.execute("SELECT status FROM outbox").fetchone()[0] == "unknown"

            target_root = Path(root, "windows-target")
            target_raw = target_root / "raw"
            target_values = dict(DB_PATH=str(target_root / "mail.db"), RAW_DIR=str(target_raw),
                                 IMAP_HOST="imap.new.example.test")
            target_root.mkdir()
            with patch.multiple(config, **target_values):
                db.init_db()
                restored = portable_backup.restore_current(package)
                message = db.get_email(1)
                assert restored["requires_resync"] is True
                assert message["raw_path"].startswith(str(target_raw) + os.sep)
                assert Path(message["raw_path"]).read_bytes() == raw.read_bytes()
                assert message["uid"] == -message["id"] and message["is_local_archive"] == 1
                rebound = db.upsert_email({"uid": 91, "folder": "INBOX", "message_id": message["message_id"], "subject": "server copy"})
                assert rebound == message["id"] and db.get_email(rebound)["uid"] == 91

            damaged = Path(root, "damaged.mailai-backup")
            with zipfile.ZipFile(package) as source, zipfile.ZipFile(damaged, "w") as target:
                for info in source.infolist():
                    payload = source.read(info.filename)
                    if info.filename == "mailai.db": payload += b"damage"
                    target.writestr(info, payload)
            try:
                portable_backup.inspect(str(damaged))
            except ValueError as exc:
                assert "校验失败" in str(exc)
            else:
                raise AssertionError("Damaged package was accepted")


class sqlite_connection:
    def __init__(self, path): self.path = path
    def __enter__(self):
        import sqlite3
        self.connection = sqlite3.connect(self.path)
        return self.connection
    def __exit__(self, *_): self.connection.close()


def test_selective_export_date_range():
    """since/until filters keep only in-range emails and prune dependents."""
    with tempfile.TemporaryDirectory() as root:
        values = dict(DATA_DIR=root, DB_PATH=str(Path(root, "mail.db")), RAW_DIR=str(Path(root, "raw")),
                      IMAP_USER="range@example.test", IMAP_HOST="imap.example.test")
        with patch.multiple(config, **values):
            db.init_db()
            with db.conn() as connection:
                connection.execute("INSERT INTO emails(uid,folder,subject,date,created_at) VALUES(1,'INBOX','old','2025-01-05T09:00:00','2025-01-05T09:00:00')")
                connection.execute("INSERT INTO emails(uid,folder,subject,date,created_at) VALUES(2,'INBOX','keep','2026-03-10T09:00:00','2026-03-10T09:00:00')")
                connection.execute("INSERT INTO emails(uid,folder,subject,date,created_at) VALUES(3,'INBOX','new','2026-09-01T09:00:00','2026-09-01T09:00:00')")
                # Unparseable date falls back to created_at; missing both is kept.
                connection.execute("INSERT INTO emails(uid,folder,subject,date,created_at) VALUES(4,'INBOX','nodate','','2026-03-11T09:00:00')")
                connection.execute("INSERT INTO todos(email_id,title,status,created_at) VALUES(1,'old todo','open','2025-01-05T09:00:00')")
                connection.execute("INSERT INTO todos(email_id,title,status,created_at) VALUES(2,'keep todo','open','2026-03-10T09:00:00')")
                connection.execute("INSERT INTO url_chains(email_id,original_url,chain) VALUES(1,'https://a.example','[]')")
                connection.execute("INSERT INTO briefing_dismissed(email_id) VALUES(1)")
            db.add_audit_log(1, "quarantine", actor="user", reason="旧邮件隔离")
            db.add_audit_log(2, "quarantine", actor="user", reason="保留邮件隔离")
            result = portable_backup.create(password="", since="2026-01-01", until="2026-06-30")
            package = portable_backup.stored_path(result["filename"])
            preview = portable_backup.inspect(package)
            assert preview["selection"]["excluded_emails"] == 2, preview["selection"]
            assert preview["content"]["emails"] == 2
            with zipfile.ZipFile(package) as archive:
                snapshot = Path(root, "range.db"); snapshot.write_bytes(archive.read("mailai.db"))
                with sqlite_connection(snapshot) as connection:
                    subjects = {row[0] for row in connection.execute("SELECT subject FROM emails")}
                    assert subjects == {"keep", "nodate"}, subjects
                    todos = [row[0] for row in connection.execute("SELECT title FROM todos")]
                    assert todos == ["keep todo"], todos
                    assert connection.execute("SELECT COUNT(*) FROM url_chains").fetchone()[0] == 0
                    assert connection.execute("SELECT COUNT(*) FROM briefing_dismissed").fetchone()[0] == 0
                    audit = connection.execute("SELECT email_id FROM audit_logs ORDER BY email_id IS NULL").fetchall()
                    # The pruned email's audit entry is retained but anonymized.
                    assert any(row[0] is None for row in audit)
            # Invalid input and inverted ranges are rejected.
            for bad in (dict(since="not-a-date"), dict(until="2026/01/01"), dict(since="2026-06-01", until="2026-01-01")):
                try:
                    portable_backup.create(password="", **bad)
                except ValueError:
                    pass
                else:
                    raise AssertionError(f"Invalid range accepted: {bad}")
            # The source database is never modified by an export.
            with db.conn() as c:
                assert c.execute("SELECT COUNT(*) FROM emails").fetchone()[0] == 4
    print("✅ 便携迁移包按日期范围选择性导出通过")


if __name__ == "__main__":
    test_portable_round_trip_and_integrity()
    test_selective_export_date_range()
    print("✅ 便携迁移包往返、跨路径恢复与完整性校验通过")
