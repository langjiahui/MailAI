"""Unit & API tests for standalone manual todos, snooze presets, and weekly/monthly recurrence."""
from datetime import date, datetime, timedelta
from pathlib import Path
import sys
import tempfile

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import config, credential_store, db, mail_calendar, periodic_briefing, system_settings, task_planner  # noqa: E402
from app.web import server  # noqa: E402


def _setup_fixture(tmp_dir: Path):
    db_path = tmp_dir / "todo_interactions.db"
    raw_dir = tmp_dir / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    credential_store.load = lambda key: "fixture"
    credential_store.available = lambda: True
    config.MAILAI_HOME = str(tmp_dir)
    config.DB_PATH = str(db_path)
    config.RAW_DIR = str(raw_dir)
    config.IMAP_USER = "owner@example.test"
    acc_key = system_settings._account_key("imap.example.test", "owner@example.test")
    config.ACCOUNT_ID = acc_key
    system_settings._save_registry({
        "accounts": {
            acc_key: {
                "id": acc_key,
                "user": "owner@example.test",
                "host": "imap.example.test",
                "db_path": str(db_path),
                "raw_dir": str(raw_dir),
                "visible": True,
            }
        },
        "last_account": acc_key,
    })
    db.init_db()
    return acc_key


def _client(account_id: str):
    return TestClient(
        server.app,
        base_url="http://127.0.0.1:8788",
        headers={"Origin": "http://127.0.0.1:8788", "X-MailAI-Account": account_id},
    )


def test_manual_create_and_validation():
    with tempfile.TemporaryDirectory() as td:
        acc_key = _setup_fixture(Path(td))
        client = _client(acc_key)

        # Empty title rejected
        bad = client.post("/api/todos", json={"title": "   "})
        assert bad.status_code == 400

        # Invalid recurrence rejected
        bad_rec = client.post("/api/todos", json={"title": "周报", "recurrence": "hourly"})
        assert bad_rec.status_code == 400

        # Valid manual standalone create without email_id
        res = client.post("/api/todos", json={
            "title": "整理季度报销发票",
            "deadline": "2026-11-20",
            "recurrence": "monthly",
        })
        assert res.status_code == 200, res.text
        task = res.json()["task"]
        assert task["email_id"] is None
        assert task["title"] == "整理季度报销发票"
        assert task["deadline"] == "2026-11-20"
        assert task["recurrence"] == "monthly"
        assert task["status"] == "open"

        # Listed accurately via /api/todos
        listed = client.get("/api/todos").json()
        assert len(listed) == 1
        assert listed[0]["id"] == task["id"]
        assert listed[0]["email_id"] is None

        # Update manual task via PATCH
        patched = client.patch(f"/api/todos/{task['id']}", json={"title": "提交11月报销", "recurrence": "weekly"})
        assert patched.status_code == 200
        assert patched.json()["task"]["title"] == "提交11月报销"
        assert patched.json()["task"]["recurrence"] == "weekly"

        # Compatible with timeline & periodic briefing
        tl = mail_calendar.timeline(
            days=14,
            include_past_days=7,
            today=date(2026, 11, 13),
        )
        assert any(item.get("todo_id") == task["id"] for item in tl["items"])

        brief = periodic_briefing.collect_summary(
            period="this_month",
            today=date(2026, 11, 13),
        )
        assert any(t["id"] == task["id"] for t in brief["highlights"]["open_todos"])


def test_snooze_presets_and_reminder_shift():
    with tempfile.TemporaryDirectory() as td:
        acc_key = _setup_fixture(Path(td))
        client = _client(acc_key)

        future_rem = (datetime.now() + timedelta(days=2)).replace(hour=10, minute=30, second=0, microsecond=0).isoformat(timespec="seconds")
        t1 = task_planner.save(title="跟进供应商报价", deadline="2026-11-12", remind_at=future_rem)
        t2 = task_planner.save(title="核对合同条款", deadline="2026-11-12")

        # Wednesday 2026-11-11 -> tomorrow = 2026-11-12, next_monday = 2026-11-16, plus_3d = 2026-11-14 (using t2 so t1's future remind_at stays intact)
        snoozed_tom = task_planner.snooze(t2["id"], preset="tomorrow", reference_date=date(2026, 11, 11))
        assert snoozed_tom["deadline"] == "2026-11-12"

        snoozed_mon = task_planner.snooze(t2["id"], preset="next_monday", reference_date=date(2026, 11, 11))
        assert snoozed_mon["deadline"] == "2026-11-16"

        # If reference is today (or later), reminder time-of-day (10:30:00) is preserved across next_monday snooze
        snoozed_next = task_planner.snooze(t1["id"], preset="next_monday")
        expected_mon = (date.today() + timedelta(days=((7 - date.today().weekday()) % 7 or 7))).isoformat()
        assert snoozed_next["deadline"] == expected_mon
        assert snoozed_next["remind_at"] == f"{expected_mon}T10:30:00"

        # API single + bulk snooze
        api_res = client.post(f"/api/todos/{t2['id']}/snooze", json={"preset": "plus_3d"})
        assert api_res.status_code == 200
        expected_plus3 = (date.today() + timedelta(days=3)).isoformat()
        assert api_res.json()["task"]["deadline"] == expected_plus3

        bulk_res = client.post("/api/todos/bulk/snooze", json={"ids": [t1["id"], t2["id"]], "preset": "tomorrow"})
        assert bulk_res.status_code == 200
        assert bulk_res.json()["updated"] == 2
        expected_tom = (date.today() + timedelta(days=1)).isoformat()
        assert all(item["deadline"] == expected_tom for item in bulk_res.json()["tasks"])

        # Completed todo cannot be snoozed
        client.post(f"/api/todos/{t2['id']}/done")
        done_snooze = client.post(f"/api/todos/{t2['id']}/snooze", json={"preset": "tomorrow"})
        assert done_snooze.status_code == 400


def test_weekly_and_monthly_recurrence_completion():
    with tempfile.TemporaryDirectory() as td:
        acc_key = _setup_fixture(Path(td))
        client = _client(acc_key)

        # Weekly recurrence
        weekly = client.post("/api/todos", json={
            "title": "发送团队周报",
            "deadline": "2026-11-13",
            "recurrence": "weekly",
        }).json()["task"]

        done_res = client.post(f"/api/todos/{weekly['id']}/done")
        assert done_res.status_code == 200
        spawned = done_res.json()["spawned"]
        assert len(spawned) == 1
        nxt = spawned[0]
        assert nxt["status"] == "open"
        assert nxt["deadline"] == "2026-11-20"
        assert nxt["recurrence"] == "weekly"
        assert nxt["recurrence_source_id"] == weekly["id"]

        # Original remains done with completed_at recorded; reopen + re-complete must NOT duplicate spawned task
        client.post(f"/api/todos/{weekly['id']}/reopen")
        done_again = client.post(f"/api/todos/{weekly['id']}/done")
        assert done_again.status_code == 200
        assert done_again.json()["spawned"] == []
        all_rows = client.get("/api/todos?include_done=true").json()
        assert sum(1 for r in all_rows if r["title"] == "发送团队周报" and r["status"] == "open") == 1

        # Monthly month-end clamping (Jan 31 -> Feb 28 in non-leap 2026, Jan 31 -> Feb 29 in leap 2024)
        assert db.todos._next_cycle_date("2026-01-31", "monthly") == "2026-02-28"
        assert db.todos._next_cycle_date("2024-01-31", "monthly") == "2024-02-29"
        assert db.todos._next_cycle_date("2026-12-15", "monthly") == "2027-01-15"


if __name__ == "__main__":
    test_manual_create_and_validation()
    test_snooze_presets_and_reminder_shift()
    test_weekly_and_monthly_recurrence_completion()
    print("PASS: manual todo creation, snooze presets/bulk, weekly & monthly recurrence spawning")
