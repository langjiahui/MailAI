"""Local-only regressions for folder sync and backup restore; no live mailbox writes."""
import os
import sys
import tempfile
import json
import stat
import zipfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import config, db, system_settings
from app.web.server import api_sync_mail_folder


class FakeMail:
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def list_mailboxes(self): return [{"name": "Drafts"}]
    def fetch_folder(self, folder, limit, known_uids=None):
        if known_uids and 11 in known_uids:
            return [(11, None, ["\\Seen"])]
        return [(11, b"From: sender@example.com\r\nSubject: Example\r\n\r\nHello", ["\\Seen"])]


def main():
    with tempfile.TemporaryDirectory() as root:
        with patch.multiple(config, DB_PATH=os.path.join(root, "mail.db"), DATA_DIR=root,
                            RAW_DIR=os.path.join(root, "raw"), IMAP_USER="test@example.com",
                            IMAP_HOST="imap.example.com"):
            db.init_db()
            assert db.mailbox_revision() == {"revision": "0:0:0", "latest_id": 0, "total": 0}
            with patch("app.pipeline.MailClient", FakeMail):
                api_sync_mail_folder("Drafts")
                first = db.list_emails(days=9999, folder="Drafts")[0]
                assert db.mailbox_revision()["total"] == 1
                assert first["verdict"] == "clean" and first["status"] == "draft"
                db.add_todos(first["id"], [{"title": "Keep source", "deadline": "2026-09-01"}])
                with db.conn() as connection:
                    connection.execute("UPDATE emails SET summary='Keep analysis',verdict='phishing' WHERE id=?", (first["id"],))
                api_sync_mail_folder("Drafts")
                second = db.list_emails(days=9999, folder="Drafts")[0]
                assert second["id"] == first["id"]
                assert second["summary"] == "Keep analysis" and second["verdict"] == "phishing"
                assert db.list_todos()[0]["email_id"] == first["id"]
                assert db.list_emails(days=9999, folder='Drafts', offset=1) == []
                assert db.list_emails(days=9999, folder='Drafts', offset=0)[0]['id'] == first['id']
                with db.conn() as connection:
                    connection.execute(
                        "UPDATE emails SET status='quarantine',score=60,action_taken=1,reviewed=0,feedback=NULL WHERE id=?",
                        (first["id"],),
                    )
                dashboard = db.dashboard_operations(7)
                assert dashboard["pending_review"] == 1
                assert dashboard["pending_period"] == 1
                assert dashboard["risk_count"] == 1 and dashboard["auto_handled"] == 1
                assert dashboard["attention"][0]["id"] == first["id"]
                assert dashboard["risky_senders"][0]["risk_count"] == 1
            backup = system_settings.create_backup()
            backup_file = os.path.join(root, "backups", backup["filename"])
            if os.name == "nt":
                # Windows uses ACLs instead of POSIX permission bits, so
                # stat.S_IMODE() cannot be expected to report 0600 there.
                assert os.path.isfile(backup_file)
                assert os.access(backup_file, os.R_OK | os.W_OK)
            else:
                assert stat.S_IMODE(os.stat(backup_file).st_mode) == 0o600
            foreign_name = "MailAI-ffffffffffffffff-20260901-000000-000000.zip"
            Path(root, "backups", foreign_name).write_bytes(b"foreign")
            assert foreign_name not in {item["filename"] for item in system_settings.list_backups()}
            try:
                system_settings.backup_path(foreign_name)
            except ValueError:
                pass
            else:
                raise AssertionError("Cross-account backup download must fail")
            todo = db.list_todos()[0]
            db.set_todo_status(todo["id"], "done")
            restored = system_settings.restore_backup(backup["filename"])
            assert restored["safety_backup"] != backup["filename"]
            assert db.list_todos()[0]["title"] == "Keep source"
            assert os.path.isfile(first["raw_path"])
            with zipfile.ZipFile(os.path.join(root, "backups", backup["filename"])) as archive:
                assert json.loads(archive.read("manifest.json"))["version"] == 2
            # A database write failure after the raw-tree swap must restore both
            # the previous database and raw source tree.
            before_email = db.get_email(first["id"])
            before_todos = db.list_todos()
            before_raw = Path(first["raw_path"]).read_bytes()
            real_copy = system_settings._copy_database
            def fail_live_restore(source, target):
                if target == config.DB_PATH and source.endswith("mailai.db"):
                    raise OSError("simulated disk failure")
                return real_copy(source, target)
            with patch("app.system_settings._copy_database", side_effect=fail_live_restore):
                try:
                    system_settings.restore_backup(backup["filename"])
                except OSError:
                    pass
                else:
                    raise AssertionError("Restore failure was swallowed")
            after_email = db.get_email(first["id"])
            assert after_email["subject"] == before_email["subject"]
            assert after_email["summary"] == before_email["summary"]
            assert db.list_todos() == before_todos
            assert Path(first["raw_path"]).read_bytes() == before_raw
            assert not os.path.exists(os.path.join(os.path.dirname(config.RAW_DIR), ".mailai-restore-rollback"))
            # A different install directory must not retain the old absolute path.
            with patch.object(config, "RAW_DIR", os.path.join(root, "new-computer", "raw")):
                # Safety snapshot needs the original source tree until restore starts.
                with patch("app.system_settings.create_backup", return_value={"filename": "safety.zip"}):
                    system_settings.restore_backup(backup["filename"])
                migrated = db.get_email(first["id"])
                assert migrated["raw_path"].startswith(config.RAW_DIR + os.sep)
                assert Path(migrated["raw_path"]).read_bytes() == Path(first["raw_path"]).read_bytes()
            with patch.object(config, "IMAP_USER", "other@example.com"):
                try:
                    system_settings.restore_backup(backup["filename"])
                except ValueError:
                    pass
                else:
                    raise AssertionError("Cross-account restore must fail")
            with patch.object(config, "IMAP_USER", "test@example.com"):
                deleted = system_settings.delete_backup(backup["filename"])
                assert deleted["ok"] and not Path(root, "backups", backup["filename"]).exists()
                try:
                    system_settings.delete_backup(foreign_name)
                except ValueError:
                    pass
                else:
                    raise AssertionError("Cross-account backup deletion must fail")
    print("✅ 文件夹重复同步、来源关联、特殊文件夹角色与备份恢复回归通过")


if __name__ == "__main__": main()
