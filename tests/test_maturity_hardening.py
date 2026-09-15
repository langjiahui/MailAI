"""Regression coverage for restore, mailbox identity, model and resource boundaries."""
import base64
import json
import os
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import config, db, outbox, pipeline, system_settings
from app.account_context import use
from app.llm import analyze
from app.security import chains


@contextmanager
def isolated(name):
    with tempfile.TemporaryDirectory(prefix="mailai-hardening-") as root:
        data = Path(root) / "data"
        raw = data / "raw"
        raw.mkdir(parents=True)
        values = dict(ACCOUNT_ID=name, DB_PATH=str(data / "mail.db"), RAW_DIR=str(raw),
                      DATA_DIR=str(data), IMAP_USER="review@example.test",
                      IMAP_HOST="imap.example.test")
        with use(values):
            db.init_db()
            yield


def test_uid_generation():
    with isolated("uid"):
        db.observe_uid_validity("INBOX", 100)
        email_id = db.upsert_email(dict(uid=1, folder="INBOX", subject="old"))
        db.queue_seen_sync([email_id], True)
        db.queue_trash([email_id], 0)
        assert db.observe_uid_validity("INBOX", 101, reset=True)
        old = db.get_email(email_id)
        assert old["uid"] == -email_id and old["is_local_archive"] == 1
        assert not old["pending_action"] and not db.due_seen_sync_jobs()
        assert db.get_last_uid("INBOX") == 0
        assert db.upsert_email(dict(uid=1, folder="INBOX", subject="new")) != email_id
        try:
            db.observe_uid_validity("INBOX", 102, reset=False)
        except RuntimeError:
            pass
        else:
            raise AssertionError("Remote mutations must reject a changed mailbox generation")


def test_restore_is_inert():
    with isolated("restore"):
        email_id = db.upsert_email(dict(uid=7, folder="INBOX", subject="fixture"))
        db.queue_seen_sync([email_id], True)
        db.queue_trash([email_id], 0)
        outbox.enqueue("restored-send", {"subject": "fixture"}, delay=0)
        backup = system_settings.create_backup(True)
        db.cancel_pending_trash(email_id)
        system_settings.restore_backup(backup["filename"])
        assert not db.due_trash_actions() and not db.due_seen_sync_jobs()
        with db.conn() as connection:
            assert connection.execute("SELECT status FROM outbox").fetchone()[0] == "unknown"


def test_processing_checkpoint():
    with isolated("processing"):
        email_id = db.upsert_email(dict(uid=3, folder="INBOX", subject="partial",
                                        processing_complete=0, status="quarantine", action_taken=1))
        assert not db.already_processed("INBOX", 3)
        db.finish_email_processing(email_id)
        assert db.already_processed("INBOX", 3)


def test_link_boundaries_and_redirects():
    chains.follow_redirects.cache_clear()
    with patch.object(chains.socket, "getaddrinfo", return_value=[
        (2, 1, 6, "", ("127.0.0.1", 80))
    ]):
        result = chains.follow_redirects("http://localhost/internal")
    assert result["status"] == "blocked" and result["chain"][0]["status"] == 0
    with patch.object(chains.socket, "getaddrinfo") as lookup:
        try:
            chains._public_target("http://example.test:443/path")
        except ValueError:
            pass
        else:
            raise AssertionError("Scheme-mismatched ports must not be scanned")
        lookup.assert_not_called()

    with patch.object(chains, "_public_target", return_value=("public.example", ["93.184.216.34"])), \
         patch.object(chains, "_head", side_effect=[
             (302, {"Location": "https://public.example/final"}, "93.184.216.34"),
             (200, {}, "93.184.216.34"),
         ]) as head, \
         patch.object(chains, "_resolve_ip", return_value="93.184.216.34"):
        result = chains.follow_redirects("https://short.example/a", max_hops=2)
    assert result["final_url"] == "https://public.example/final"
    assert [item["status"] for item in result["chain"]] == [302, 200]
    assert head.call_count == 2


def test_strict_model_schema():
    with isolated("model"):
        invalid = {"phishing": "false", "confidence": .9, "is_spam": "false",
                   "reasons": [], "evidence": []}
        with patch.object(analyze.client, "available", return_value=True), \
             patch.object(analyze.client, "chat_json", return_value=invalid):
            assert analyze.security_review({"message_id": "<invalid@example.test>"}, "fixture") is None
        with db.conn() as connection:
            assert connection.execute("SELECT COUNT(*) FROM ai_analysis_cache").fetchone()[0] == 0


def test_list_payloads_are_metadata_only():
    with isolated("lists"):
        attachment = {"filename": "fixture.bin", "size": 1024,
                      "data_base64": base64.b64encode(b"x" * 1024).decode()}
        draft_id = db.save_draft({"subject": "draft", "attachments": [attachment]})
        sent_id = db.create_sent_message({"subject": "sent", "attachments": [attachment]})
        for row in (db.list_drafts()[0], db.list_sent_messages()[0]):
            assert "attachments_json" not in row
            assert "data_base64" not in row["attachments"][0]
        assert db.get_draft(draft_id)["attachments"][0]["data_base64"]
        assert db.get_sent_message(sent_id)["attachments"][0]["data_base64"]


def test_history_download_is_size_bounded():
    with isolated("history"):
        mail = MagicMock()
        mail.__enter__.return_value = mail
        mail.select_folder.return_value = {}
        mail.client.search.return_value = [1, 2]
        calls = []
        def fetch(uids, fields):
            calls.append((list(uids), list(fields)))
            if fields == ["RFC822.SIZE"]:
                return {uid: {b"RFC822.SIZE": 100} for uid in uids}
            return {uids[0]: {b"BODY[]": b"fixture"}}
        mail.client.fetch.side_effect = fetch
        with patch.object(pipeline, "MailClient", return_value=mail), \
             patch.object(pipeline, "process_message", return_value={"status": "inbox"}):
            assert pipeline.fetch_all(batch=50)["fetched"] == 2
        assert calls[0] == ([2, 1], ["RFC822.SIZE"])
        assert all(len(uids) == 1 for uids, fields in calls[1:] if fields == ["BODY.PEEK[]"])


def test_policy_persists_and_outbox_lock_is_honored():
    with isolated("policy"):
        pipeline.set_action_mode("review")
        pipeline._account_action_modes.clear()
        assert pipeline.get_action_policy()["mode"] == "review"

        outbox.enqueue("locked", {"subject": "fixture"}, delay=0)
        @contextmanager
        def unavailable(_path):
            yield False
        sent = []
        with patch.object(outbox, "_process_lock", side_effect=unavailable):
            outbox.process(lambda payload: sent.append(payload))
        assert not sent
        with db.conn() as connection:
            assert connection.execute("SELECT status FROM outbox").fetchone()[0] == "queued"


def main():
    test_uid_generation()
    test_restore_is_inert()
    test_processing_checkpoint()
    test_link_boundaries_and_redirects()
    test_strict_model_schema()
    test_list_payloads_are_metadata_only()
    test_history_download_is_size_bounded()
    test_policy_persists_and_outbox_lock_is_honored()
    print("Maturity hardening regressions passed")


if __name__ == "__main__":
    main()
