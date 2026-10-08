"""Conditional sent reminders, preserved draft options, snippets and grounded AI changes."""

import sys, tempfile, json
from pathlib import Path
from datetime import datetime, timedelta
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import db, config, sent_followups, productivity, mail_evidence, outbox
from app.account_context import use


def main():
    with (
        tempfile.TemporaryDirectory() as root,
        use(
            {
                "ACCOUNT_ID": "a",
                "DB_PATH": str(Path(root) / "a.db"),
                "IMAP_USER": "me@example.test",
                "SMTP_HOST": "smtp.example.test",
            }
        ),
    ):
        db.init_db()
        draft = db.save_draft(
            {"subject": "test", "followup_days": 3, "followup_at": ""}
        )
        assert db.get_draft(draft)["followup_days"] == 3
        sent = db.create_sent_message(
            {
                "subject": "确认交期",
                "from_addr": "me@example.test",
                "to_addr": "client@example.test",
            }
        )
        db.finish_sent_message(sent, ok=True, message_id="<sent@example.test>")
        sent_followups.register(sent, 1)
        assert len(sent_followups.items()) == 1
        future = (datetime.now() + timedelta(seconds=1)).isoformat()
        db.upsert_email(
            dict(
                uid=1,
                status="inbox",
                from_addr="client@example.test",
                message_id="<unrelated@example.test>",
                subject="确认交期",
                date=future,
            )
        )
        sent_followups.refresh()
        assert sent_followups.items()[0]["state"] == "scheduled", (
            "Same subject cannot cancel a follow-up"
        )
        db.upsert_email(
            dict(
                uid=2,
                status="quarantine",
                from_addr="client@example.test",
                message_id="<risky@example.test>",
                in_reply_to="<sent@example.test>",
                date=future,
            )
        )
        sent_followups.refresh()
        assert sent_followups.items()[0]["state"] == "scheduled"
        db.upsert_email(
            dict(
                uid=3,
                status="inbox",
                verdict="clean",
                from_addr="client@example.test",
                message_id="<reply@example.test>",
                in_reply_to="<sent@example.test>",
                date=future,
            )
        )
        sent_followups.refresh()
        assert sent_followups.items()[0]["state"] == "replied"
        other = db.create_sent_message(
            {
                "subject": "other",
                "from_addr": "me@example.test",
                "to_addr": "client@example.test",
            }
        )
        db.finish_sent_message(other, ok=True, message_id="<other@example.test>")
        sent_followups.register(
            other, at=(datetime.now() - timedelta(seconds=1)).isoformat()
        )
        calls = []
        account = {"db_path": config.DB_PATH, "user": "me@example.test"}
        assert (
            sent_followups.dispatch(
                "a", account, send=lambda *args: calls.append(args) or True
            )
            == 1
        )
        assert (
            sent_followups.dispatch(
                "a", account, send=lambda *args: calls.append(args) or True
            )
            == 0
            and len(calls) == 1
        )
        try:
            outbox.enqueue(
                "invalid",
                {
                    "send_at": (datetime.now() + timedelta(days=3)).isoformat(),
                    "followup_at": (datetime.now() + timedelta(days=1)).isoformat(),
                },
            )
            assert False
        except ValueError:
            pass
        # An uncertain SMTP result must retain the identity and restore the chosen
        # reminder only after the user verifies delivery; it must never resend.
        outbox.enqueue("verified-later", {"followup_days": 3}, delay=-1)

        def uncertain(payload):
            db.create_sent_message(
                {
                    "subject": "uncertain",
                    "message_id": "<uncertain@example.test>",
                    "to_addr": "client@example.test",
                }
            )
            raise TimeoutError("result unknown")

        outbox.process(uncertain)
        assert (
            next(r for r in outbox.items() if r["token"] == "verified-later")["status"]
            == "unknown"
        )
        outbox.resolve("verified-later", True)
        assert any(
            r["subject"] == "uncertain" and r["state"] == "scheduled"
            for r in sent_followups.items()
        )
        from app import smtp_client, mail_calendar

        with patch.object(
            smtp_client, "_credentials", return_value=("me@example.test", "fixture")
        ):
            message, _ = smtp_client.build_message(
                {
                    "to_addr": "client@example.test",
                    "subject": "ID",
                    "body_html": "hello",
                    "_delivery_message_id": "<stable@example.test>",
                }
            )
            assert message["Message-ID"] == "<stable@example.test>"
        with patch.object(
            mail_calendar,
            "invitations",
            return_value={
                "items": [
                    {
                        "uid": "all-day",
                        "title": "会议",
                        "dtstart": "20261010",
                        "dtstart_value": "DATE",
                        "organizer": "mailto:organizer@example.test",
                        "sequence": "2",
                    }
                ]
            },
        ):
            draft = mail_calendar.response_draft(1, "all-day", "accepted")
            import base64

            response = base64.b64decode(draft["attachments"][0]["data_base64"]).decode()
            assert (
                "DTSTART;VALUE=DATE:20261010" in response and "SEQUENCE:2" in response
            )
            assert draft["to_addr"] == "organizer@example.test"
        productivity.save_named(
            "snippets", {"name": "确认收到", "body": "已收到，谢谢。"}
        )
        assert productivity.named_items("snippets")[0][
            "body"
        ] == "已收到，谢谢。" and not productivity.named_items("templates")
        first = db.upsert_email(
            dict(
                uid=4,
                status="inbox",
                message_id="<a@example.test>",
                body_text="项目 A 的交付日期为10月10日。",
                date="2026-10-01T09:00:00",
            )
        )
        second = db.upsert_email(
            dict(
                uid=5,
                status="inbox",
                message_id="<b@example.test>",
                in_reply_to="<a@example.test>",
                body_text="建议项目 A 的交付日期改到10月12日，待你确认。",
                date="2026-10-02T09:00:00",
            )
        )
        good = {
            "kind": "date",
            "label": "项目 A 交付",
            "before_key": "email:" + str(first),
            "after_key": "email:" + str(second),
            "before": "10月10日",
            "after": "10月12日",
            "before_quote": "项目 A 的交付日期为10月10日。",
            "after_quote": "建议项目 A 的交付日期改到10月12日，待你确认。",
            "note": "只是提议，需确认",
        }
        bad = {**good, "after_quote": "已经确认改到10月12日。"}
        malformed = {**good, "before_key": []}
        response = {
            "choices": [
                {
                    "message": {
                        "content": json.dumps({"changes": [good, bad, malformed]})
                    }
                }
            ]
        }
        before = db.mailbox_revision()
        from app.llm import client

        with (
            patch.object(client, "available", return_value=True),
            patch.object(client, "chat_completion", return_value=response),
        ):
            result = mail_evidence.semantic_compare(second)
            assert len(result["items"]) == 1 and result["rejected"] == 2
            assert (
                result["items"][0]["needs_verification"]
                and result["items"][0]["note"] == "只是提议，需确认"
            )
        assert before == db.mailbox_revision(), (
            "AI comparison must not update mail state"
        )
        with patch.object(client, "available", return_value=False):
            try:
                mail_evidence.semantic_compare(second)
                assert False
            except ValueError:
                pass
    with (
        tempfile.TemporaryDirectory() as root,
        use({"ACCOUNT_ID": "b", "DB_PATH": str(Path(root) / "b.db")}),
    ):
        db.init_db()
        assert not sent_followups.items() and not productivity.named_items("snippets")
    print(
        "PASS completion: conditional follow-ups, retry deduplication, draft persistence, snippets, AI quotation validation and account isolation"
    )


if __name__ == "__main__":
    main()
