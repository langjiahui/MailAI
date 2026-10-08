"""Search pagination, migration, no duplicate sends, local states and account isolation."""

import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import db, productivity, outbox, mail_calendar, mail_evidence
from app.account_context import use


def main():
    with tempfile.TemporaryDirectory() as root:
        with use(
            {
                "ACCOUNT_ID": "a",
                "DB_PATH": str(Path(root) / "a.db"),
                "IMAP_USER": "me@example.test",
            }
        ):
            db.init_db()
            db.init_db()
            first = db.upsert_email(
                dict(
                    uid=1,
                    subject="合同100%_审查",
                    from_addr="client@example.test",
                    to_addr="me@example.test",
                    body_text="交期为2026年10月10日。合同金额100元。",
                    date=datetime.now().isoformat(),
                    message_id="<a@example.test>",
                    attachments=[{"name": "合同-final.pdf", "size": 10}],
                )
            )
            other = db.upsert_email(
                dict(
                    uid=2,
                    subject="合同100xx审查",
                    from_addr="other@example.test",
                    body_text="内容",
                    date=datetime.now().isoformat(),
                    message_id="<other@example.test>",
                )
            )
            assert db.search_emails(["合同-final.pdf"])[0]["id"] == first
            assert [
                r["id"]
                for r in productivity.search(
                    {"query": "from:client@example.test filename:pdf subject:100%_"}
                )["items"]
            ] == [first]
            assert productivity.search({"query": "' OR 1=1 -- '"})["items"] == []
            draft = db.save_draft(
                {"subject": "draft-unique", "body_html": "draft body"}
            )
            sent = db.create_sent_message(
                {
                    "message_id": "<sent@example.test>",
                    "subject": "sent-unique",
                    "from_addr": "me@example.test",
                    "to_addr": "client@example.test",
                    "body_html": "hello",
                    "reply_to_email_id": first,
                    "in_reply_to": "<a@example.test>",
                }
            )
            db.finish_sent_message(sent, ok=True)
            db.upsert_email(
                dict(
                    uid=3,
                    status="sent",
                    message_id="<sent@example.test>",
                    subject="sent-unique",
                    date=datetime.now().isoformat(),
                )
            )
            rows = productivity.search({})["items"]
            assert sum(r["subject"] == "sent-unique" for r in rows) == 1
            assert {r["kind"] for r in rows} == {"email", "sent", "draft"}
            full = productivity.search({}, limit=50)["items"]
            pages = [
                productivity.search({}, offset=i, limit=1)["items"][0]
                for i in range(len(full))
            ]
            assert [(r["kind"], r["id"]) for r in full] == [
                (r["kind"], r["id"]) for r in pages
            ]
            assert productivity.search({"mailbox": "drafts"})["items"][0]["id"] == draft
            for bad in (
                {"after": "no-date"},
                {"after": "2026-10-10", "before": "2026-01-01"},
                {"mailbox": "inbox'"},
                {"state": "bogus"},
            ):
                try:
                    productivity.search(bad)
                    assert False, bad
                except ValueError:
                    pass
            later = (datetime.now() + timedelta(days=1)).isoformat()
            productivity.set_workflow(first, "later", later)
            assert db.get_email(first)["status"] == "inbox"
            with db.conn() as c:
                c.execute(
                    "UPDATE emails SET snoozed_until=? WHERE id=?",
                    ((datetime.now() - timedelta(seconds=1)).isoformat(), first),
                )
            productivity.refresh_workflow()
            assert db.get_email(first)["handle_state"] == "unhandled"
            productivity.set_workflow(first, "waiting", followup_at=later)
            reply = db.upsert_email(
                dict(
                    uid=4,
                    from_addr="client@example.test",
                    date=(datetime.now() + timedelta(seconds=1)).isoformat(),
                    message_id="<reply@example.test>",
                    in_reply_to="<sent@example.test>",
                    body_text="交期为2026年10月12日。合同金额120元。",
                )
            )
            productivity.refresh_workflow()
            assert db.get_email(first)["handle_state"] == "unhandled"
            with db.conn() as c:
                assert not c.execute(
                    "SELECT 1 FROM mail_workflow_notices WHERE email_id=?", (first,)
                ).fetchone()
            evidence = mail_evidence.compare(first)["items"]
            assert {r["value"] for r in evidence} >= {
                "2026年10月10日",
                "2026年10月12日",
                "100元",
                "120元",
            }
            before = db.mailbox_revision()
            mail_evidence.compare(first)
            assert before == db.mailbox_revision()
            a = productivity.save_named(
                "templates",
                {
                    "name": "test",
                    "subject": "hello",
                    "body": "<script>alert(1)</script>",
                },
            )["id"]
            assert productivity.named_items("templates")[0]["id"] == a
            db.save_contact("existing@example.test", "原始姓名")
            text = "email,name,company,group_name\nexisting@example.test,新姓名,公司,组\nnew@example.test,新联系人,公司,组\nbad,坏人,,\n"
            preview = productivity.import_contacts(text)
            assert (
                preview["accepted"] == 1
                and preview["skipped"] == 1
                and preview["invalid_rows"] == [3]
            )
            assert not any(
                r["email"] == "new@example.test" for r in db.search_contacts("new")
            )
            productivity.import_contacts(text, apply=True)
            assert db.search_contacts("existing")[0]["name"] == "原始姓名"
            productivity.import_contacts(text, apply=True, overwrite=True)
            assert db.search_contacts("existing")[0]["name"] == "新姓名"
            productivity.import_contacts(
                "BEGIN:VCARD\nVERSION:3.0\nFN:张三\nEMAIL:zhang@example.test\nEND:VCARD\n",
                format="vcard",
                apply=True,
            )
            assert "zhang@example.test" in productivity.export_contacts("vcard")
            when = (datetime.now() + timedelta(hours=1)).isoformat()
            outbox.enqueue("scheduled", {"subject": "later", "send_at": when})
            called = []
            outbox.process(lambda payload: called.append(payload))
            assert not called
            outbox.reschedule(
                "scheduled", (datetime.now() + timedelta(hours=2)).isoformat()
            )
            assert outbox.items()[0]["status"] == "queued"
            outbox.cancel("scheduled")
            outbox.process(lambda p: called.append(p))
            assert not called
            # Due selection raced with rescheduling: claim rechecks due_at atomically.
            outbox.enqueue("race", {"subject": "race"}, delay=-1)
            original = db.conn
            counter = [0]
            from contextlib import contextmanager

            @contextmanager
            def raced():
                counter[0] += 1
                if counter[0] == 2:
                    with original() as c:
                        c.execute(
                            "UPDATE outbox SET due_at=? WHERE token='race'", (when,)
                        )
                with original() as c:
                    yield c

            with patch.object(db, "conn", raced):
                outbox._process_locked(lambda p: called.append(p))
            assert not called
            ics = mail_calendar.export_event(
                {
                    "title": "会议\nBEGIN:BAD",
                    "start": when,
                    "end": (datetime.now() + timedelta(hours=2)).isoformat(),
                }
            )
            assert "\nBEGIN:BAD" not in ics and "SUMMARY:会议\\nBEGIN:BAD" in ics
            events = mail_calendar.parse_ics(
                "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:test\nDTSTART;TZID=Asia/Shanghai:20261010T090000\nSUMMARY:示例会议\nEND:VEVENT\nEND:VCALENDAR\n"
            )
            assert events[0]["dtstart_tzid"] == "Asia/Shanghai"
        with use(
            {
                "ACCOUNT_ID": "b",
                "DB_PATH": str(Path(root) / "b.db"),
                "IMAP_USER": "other@example.test",
            }
        ):
            db.init_db()
            assert (
                productivity.named_items("templates") == []
                and productivity.search({})["items"] == []
            )
    print(
        "PASS productivity: migration, search, duplicate prevention, workflow, contacts, calendar and account isolation"
    )


if __name__ == "__main__":
    main()
