"""Optimistic draft revisions, multi-window exit, workflow delivery and share renewal."""

import sys, tempfile, threading
from pathlib import Path
from datetime import datetime, timedelta
from unittest.mock import patch, MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import db, productivity, draft_lifecycle, share_storage, mail_calendar, outbox
from app.account_context import use


def main():
    with (
        tempfile.TemporaryDirectory() as root,
        use(
            {
                "ACCOUNT_ID": "a",
                "DB_PATH": str(Path(root) / "a.db"),
                "IMAP_USER": "me@example.test",
            }
        ),
    ):
        db.init_db()
        ident, version = db.save_draft({"subject": "first"}, return_revision=True)
        assert version == 1
        db.save_draft({"subject": "new"}, ident, expected_revision=version, strict=True)
        try:
            db.save_draft(
                {"subject": "stale"}, ident, expected_revision=version, strict=True
            )
            assert False
        except ValueError:
            pass
        assert db.get_draft(ident)["subject"] == "new"
        try:
            outbox.enqueue("stale-window", {"id": ident, "expected_revision": 1})
            assert False
        except ValueError:
            pass
        outbox.enqueue("current-window", {"id": ident, "expected_revision": 2})
        try:
            db.save_draft({"subject": "cannot edit queued draft"}, ident, strict=True)
            assert False
        except ValueError:
            pass
        scheduled_at = (datetime.now() + timedelta(days=2)).isoformat(timespec="seconds")
        outbox.reschedule("current-window", scheduled_at)
        assert db.get_draft(ident)['send_at'] == scheduled_at
        result = outbox.edit_queued("current-window")
        assert result['draft_id'] == ident
        assert db.get_draft(ident)['send_at'] == scheduled_at
        assert not outbox.draft_pending(ident)
        db.save_draft({'subject':'edited'}, ident, strict=True)
        outbox.enqueue('claimed-task', {'id':ident, 'expected_revision':db.get_draft(ident)['revision']})
        with db.conn() as c:
            c.execute("UPDATE outbox SET status='sending' WHERE token='claimed-task'")
        try:
            outbox.edit_queued('claimed-task')
            assert False, 'A claimed send cannot be withdrawn or edited'
        except ValueError:
            pass
        with db.conn() as c:
            c.execute("UPDATE outbox SET status='queued' WHERE token='claimed-task'")
        outbox.cancel('claimed-task')
        db.delete_draft(ident)
        try:
            db.save_draft(
                {"subject": "deleted"}, ident, expected_revision=db.get_draft(ident)["revision"] if db.get_draft(ident) else 2, strict=True
            )
            assert False
        except ValueError:
            pass
        email = db.upsert_email(
            dict(
                uid=1,
                subject="跟进合同",
                from_addr="client@example.test",
                date=datetime.now().isoformat(),
                message_id="<in@example.test>",
            )
        )
        at = (datetime.now() + timedelta(days=1)).isoformat()
        productivity.set_workflow(email, "waiting", followup_at=at)
        with db.conn() as c:
            c.execute(
                "UPDATE mail_workflow_notices SET at=?",
                ((datetime.now() - timedelta(minutes=1)).isoformat(),),
            )
        account = {"db_path": db.core.config.DB_PATH, "user": "me@example.test"}
        assert (
            productivity.dispatch_workflow("a", account, send=lambda *args: False) == 0
        )
        # Retrying respects the persisted lease; restart doesn't duplicate delivered alerts.
        with db.conn() as c:
            c.execute("UPDATE mail_workflow_notices SET retry_after=0")
        calls = []
        assert (
            productivity.dispatch_workflow(
                "a", account, send=lambda *args: calls.append(args) or True
            )
            == 1
        )
        assert (
            productivity.dispatch_workflow(
                "a", account, send=lambda *args: calls.append(args) or True
            )
            == 0
            and len(calls) == 1
        )
        record = {
            "name": "file.txt",
            "url": "https://example.test/old",
            "size": 2,
            "expires_at": at,
        }
        settings = {
            "bucket": "bucket-12345",
            "region": "ap-guangzhou",
            "credential_available": True,
        }
        with patch.object(share_storage, "public_config", return_value=settings):
            share_storage.remember_link(record, "mailai-shares/synthetic/file.txt")
            items = share_storage.list_links()
            assert len(items) == 1
            client = MagicMock()
            client.get_presigned_download_url.return_value = "https://example.test/new"
            with patch.object(share_storage, "_client", return_value=client):
                assert share_storage.renew_link(items[0]["id"])["url"].endswith("/new")
                client.head_object.assert_called_once()
            with patch.object(
                share_storage,
                "public_config",
                return_value={**settings, "bucket": "changed-12345"},
            ):
                try:
                    share_storage.renew_link(items[0]["id"])
                    assert False
                except ValueError:
                    pass
        with patch.object(
            mail_calendar,
            "invitations",
            return_value={
                "items": [
                    {
                        "uid": "event-id",
                        "dtstart": "20261010T090000",
                        "dtstart_tzid": "Asia/Shanghai",
                        "title": "会议",
                        "organizer": "mailto:client@example.test",
                    }
                ]
            },
        ):
            draft = mail_calendar.response_draft(email, "event-id", "accepted")
            assert draft["attachments"][0]["content_type"].startswith("text/calendar")
            import base64

            response = base64.b64decode(draft["attachments"][0]["data_base64"]).decode()
            assert (
                "METHOD:REPLY" in response
                and "PARTSTAT=ACCEPTED" in response
                and "UID:event-id" in response
            )

    class Window:
        def __init__(self):
            self.ready = threading.Event()
            self.destroyed = False

        def evaluate_js(self, script, callback):
            self.callback = callback
            self.ready.set()

        def destroy(self):
            self.destroyed = True

        def show(self):
            pass

    class Runtime:
        quitting = False

        def __init__(self):
            self.window = Window()
            self._compose_windows = {"child": Window()}

        def show_window(self):
            pass

    runtime = Runtime()
    finished = []
    draft_lifecycle.request_safe_exit(runtime, lambda: finished.append(True))
    assert runtime.window.ready.wait(2) and runtime._compose_windows[
        "child"
    ].ready.wait(2)
    runtime.window.callback(True)
    runtime.window.callback(True)
    assert not finished
    child = runtime._compose_windows["child"]
    child.callback(True)
    assert finished == [True] and child.destroyed
    child.callback(True)
    assert finished == [True]
    print(
        "PASS lifecycle: draft conflicts, deleted drafts, multi-window save, reminder leases and share expiry renewal"
    )


if __name__ == "__main__":
    main()
