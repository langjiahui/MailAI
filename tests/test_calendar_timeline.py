"""Calendar timeline aggregation, conflict detection, batch ICS export, macOS JXA mock & API routes."""
import json
import subprocess
import sys
import tempfile
from datetime import date, datetime, timedelta
from email.message import EmailMessage
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import db, mail_calendar
from app.account_context import use
from app.web.routes.productivity import router as productivity_router


def _write_eml(path: Path, subject: str, sender: str, ics_text: str, filename: str = "invite.ics", subtype: str = "calendar") -> str:
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = "me@corp.test"
    msg.set_content("请查收日历附件。")
    msg.add_attachment(ics_text.encode("utf-8"), maintype="text", subtype=subtype, filename=filename)
    path.write_bytes(msg.as_bytes())
    return str(path)


def _seed_timeline_data(root: str, today: date):
    today_iso = today.isoformat()
    yesterday_iso = (today - timedelta(days=1)).isoformat()
    tomorrow_iso = (today + timedelta(days=1)).isoformat()
    today_compact = today.strftime("%Y%m%d")
    tomorrow_compact = (today + timedelta(days=1)).strftime("%Y%m%d")
    eml_dir = Path(root) / "eml"
    eml_dir.mkdir(parents=True, exist_ok=True)

    # 1. Clean inbox email with a meeting ICS attachment (tomorrow 14:00-15:00 local)
    ics_meeting = "\r\n".join([
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "METHOD:REQUEST",
        "BEGIN:VEVENT",
        "UID:ics-meet-301@corp.test",
        f"DTSTART:{tomorrow_compact}T140000",
        f"DTEND:{tomorrow_compact}T150000",
        "SUMMARY:周度项目评审会",
        "LOCATION:A302会议室",
        "ORGANIZER;CN=PM:mailto:pm@corp.test",
        "END:VEVENT",
        "END:VCALENDAR",
    ])
    e_meet = db.upsert_email({
        "uid": 301,
        "folder": "INBOX",
        "message_id": "<meet-301@corp.test>",
        "subject": "邀请：周度项目评审会",
        "from_addr": "pm@corp.test",
        "from_name": "项目经理",
        "to_addr": "me@corp.test",
        "date": f"{today_iso}T09:00:00",
        "snippet": "周度项目评审会邀请",
        "body_text": "请准时参会",
        "attachments": json.dumps([{"filename": "invite.ics", "content_type": "text/calendar"}]),
        "raw_path": _write_eml(eml_dir / "301.eml", "邀请：周度项目评审会", "pm@corp.test", ics_meeting),
        "status": "inbox",
        "verdict": "clean",
    })

    # 2. Quarantine/phishing email with ICS must NEVER appear on timeline
    ics_evil = "\r\n".join([
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "BEGIN:VEVENT",
        "UID:ics-evil-302@evil.test",
        f"DTSTART:{tomorrow_compact}T100000",
        f"DTEND:{tomorrow_compact}T110000",
        "SUMMARY:钓鱼恶意会议",
        "END:VEVENT",
        "END:VCALENDAR",
    ])
    db.upsert_email({
        "uid": 302,
        "folder": "INBOX",
        "message_id": "<evil-302@evil.test>",
        "subject": "虚假薪资调整会议",
        "from_addr": "phish@evil.test",
        "from_name": "Evil",
        "to_addr": "me@corp.test",
        "date": f"{today_iso}T09:10:00",
        "snippet": "恶意日程",
        "body_text": "恶意日程",
        "attachments": json.dumps([{"filename": "evil.ics", "content_type": "text/calendar"}]),
        "raw_path": _write_eml(eml_dir / "302.eml", "虚假薪资调整会议", "phish@evil.test", ics_evil, filename="evil.ics"),
        "status": "quarantine",
        "verdict": "phishing",
    })

    # 3. Clean email with all-day DATE ICS event for today
    ics_allday = "\r\n".join([
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "BEGIN:VEVENT",
        "UID:ics-allday-303@corp.test",
        f"DTSTART;VALUE=DATE:{today_compact}",
        f"DTEND;VALUE=DATE:{tomorrow_compact}",
        "SUMMARY:全员安全演练日",
        "END:VEVENT",
        "END:VCALENDAR",
    ])
    db.upsert_email({
        "uid": 303,
        "folder": "INBOX",
        "message_id": "<allday-303@corp.test>",
        "subject": "全员安全演练日",
        "from_addr": "sec@corp.test",
        "from_name": "安全团队",
        "to_addr": "me@corp.test",
        "date": f"{today_iso}T08:00:00",
        "snippet": "全天演练",
        "body_text": "全天演练",
        "attachments": json.dumps([{"filename": "drill.ics", "content_type": "application/ics"}]),
        "raw_path": _write_eml(eml_dir / "303.eml", "全员安全演练日", "sec@corp.test", ics_allday, filename="drill.ics"),
        "status": "inbox",
        "verdict": "clean",
    })

    # 4. Todos: overdue open, today timed reminder, completed todo
    db.add_todos(e_meet, [
        {"title": "补交昨日监控巡检记录", "deadline": yesterday_iso},
        {"title": "确认发布审批单", "deadline": tomorrow_iso, "remind_at": f"{tomorrow_iso}T16:00"},
        {"title": "已完成的前置准备", "deadline": today_iso},
    ])
    todos = db.list_todos(include_done=True)
    done_todo = next(t for t in todos if t["title"] == "已完成的前置准备")
    db.set_todo_status(done_todo["id"], "done")

    # 5. Sent followups: one scheduled tomorrow morning, one already replied (ignored)
    with db.conn() as c:
        cur1 = c.execute(
            "INSERT INTO sent_messages(message_id,from_addr,to_addr,subject,body_html,status,created_at,sent_at) "
            "VALUES(?,?,?,?,?,?,?,?)",
            ("<s-1@corp.test>", "me@corp.test", "vendor@partner.test", "接口联调时间确认", "<p>hi</p>", "sent",
             f"{today_iso}T09:00:00", f"{today_iso}T09:00:00"),
        )
        s1 = cur1.lastrowid
        c.execute(
            "INSERT INTO sent_followups(sent_id,at,state,created_at) VALUES(?,?,?,?)",
            (s1, f"{tomorrow_iso}T09:30", "scheduled", f"{today_iso}T09:01:00"),
        )
        cur2 = c.execute(
            "INSERT INTO sent_messages(message_id,from_addr,to_addr,subject,body_html,status,created_at,sent_at) "
            "VALUES(?,?,?,?,?,?,?,?)",
            ("<s-2@corp.test>", "me@corp.test", "boss@corp.test", "已回复跟进", "<p>ok</p>", "sent",
             f"{today_iso}T09:00:00", f"{today_iso}T09:00:00"),
        )
        s2 = cur2.lastrowid
        c.execute(
            "INSERT INTO sent_followups(sent_id,at,state,reply_id,created_at) VALUES(?,?,?,?,?)",
            (s2, f"{tomorrow_iso}T14:30", "replied", e_meet, f"{today_iso}T09:01:00"),
        )

    # 6. Custom event overlapping tomorrow 14:30-15:30 with 周度项目评审会 (14:00-15:00)
    ev = mail_calendar.create_custom_event({
        "title": "架构对齐闭门会",
        "start": f"{tomorrow_iso}T14:30",
        "end": f"{tomorrow_iso}T15:30",
        "location": "线上腾讯会议",
        "description": "讨论二期微服务拆分",
    })
    return e_meet, ev["id"]


def main():
    today = date.today()
    tomorrow_iso = (today + timedelta(days=1)).isoformat()

    with tempfile.TemporaryDirectory() as root:
        account = dict(
            ACCOUNT_ID="calendar-timeline-test",
            DB_PATH=str(Path(root) / "cal.db"),
            DATA_DIR=str(Path(root) / "cal"),
            IMAP_USER="me@corp.test",
        )
        with use(account):
            db.init_db()

            # Empty timeline check
            empty = mail_calendar.timeline(days=14, today=today)
            assert empty["summary"]["total"] == 0
            assert empty["groups"] == []

            # Custom event validation
            try:
                mail_calendar.create_custom_event({"title": "", "start": f"{tomorrow_iso}T10:00"})
                raise AssertionError("Expected ValueError for blank title")
            except ValueError:
                pass

            e_meet, custom_id = _seed_timeline_data(root, today)

            # Aggregated timeline check (done todo excluded by default)
            tl = mail_calendar.timeline(days=14, include_past_days=7, include_done=False, today=today)
            s = tl["summary"]
            assert s["todo_count"] == 2, f"Expected 2 open todos, got {s}"
            assert s["followup_count"] == 1
            assert s["ics_count"] == 2  # meet + allday; phishing excluded!
            assert s["custom_count"] == 1
            assert s["overdue"] >= 1
            assert s["conflicts"] == 1, f"Expected 1 conflict pair, got {s}"

            titles = [it["title"] for it in tl["items"]]
            assert "钓鱼恶意会议" not in titles
            assert "已完成的前置准备" not in titles
            assert any("接口联调时间确认" in t for t in titles)
            assert "周度项目评审会" in titles
            assert "架构对齐闭门会" in titles
            assert "全员安全演练日" in titles

            # Verify conflict pairing accuracy
            meet_item = next(it for it in tl["items"] if it["title"] == "周度项目评审会")
            arch_item = next(it for it in tl["items"] if it["title"] == "架构对齐闭门会")
            allday_item = next(it for it in tl["items"] if it["title"] == "全员安全演练日")
            confirm_todo = next(it for it in tl["items"] if it["title"] == "确认发布审批单")
            assert meet_item["conflict"] is True and "架构对齐闭门会" in meet_item["conflict_with"]
            assert arch_item["conflict"] is True and "周度项目评审会" in arch_item["conflict_with"]
            assert allday_item["conflict"] is False
            assert confirm_todo["conflict"] is False  # 16:00-16:30 does not overlap 14:30-15:30

            # Include done todo check
            tl_done = mail_calendar.timeline(days=14, include_done=True, today=today)
            assert any(it["title"] == "已完成的前置准备" for it in tl_done["items"])

            # Batch ICS export
            ics_text = mail_calendar.export_batch_ics([meet_item, arch_item, allday_item])
            assert "BEGIN:VCALENDAR" in ics_text
            assert ics_text.count("BEGIN:VEVENT") == 3
            assert ics_text.count("END:VEVENT") == 3
            assert "SUMMARY:周度项目评审会" in ics_text
            assert "DTSTART;VALUE=DATE:" in ics_text

            try:
                mail_calendar.export_batch_ics([])
                raise AssertionError("Expected ValueError for empty export")
            except ValueError:
                pass

            # macOS calendar JXA mocks (never mutate real host Calendar.app)
            mock_list_proc = MagicMock(returncode=0, stdout=json.dumps({"calendars": ["工作", "个人"]}), stderr="")
            with patch("app.mail_calendar.sys.platform", "darwin"), patch(
                "app.mail_calendar.subprocess.run", return_value=mock_list_proc
            ):
                listed = mail_calendar.list_macos_calendars()
                assert listed["supported"] is True and listed["calendars"] == ["工作", "个人"]

            mock_add_proc = MagicMock(
                returncode=0,
                stdout=json.dumps({"calendar": "工作", "created": 2, "skipped": 1}),
                stderr="",
            )
            with patch("app.mail_calendar.sys.platform", "darwin"), patch(
                "app.mail_calendar.subprocess.run", return_value=mock_add_proc
            ) as sub_mock:
                added = mail_calendar.write_macos_calendar([meet_item, arch_item, allday_item], calendar_name="工作")
                assert added == {"ok": True, "calendar": "工作", "created": 2, "skipped": 1}
                sent_env = sub_mock.call_args.kwargs["env"]
                payload = json.loads(sent_env["MAILAI_CAL_PAYLOAD"])
                assert payload["calendar_name"] == "工作" and len(payload["events"]) == 3

            # TCC -1743 denied error translation
            mock_denied = MagicMock(returncode=1, stdout="", stderr="execution error: Not authorized (-1743)")
            with patch("app.mail_calendar.sys.platform", "darwin"), patch(
                "app.mail_calendar.subprocess.run", return_value=mock_denied
            ):
                try:
                    mail_calendar.write_macos_calendar([meet_item], calendar_name="工作")
                    raise AssertionError("Expected ValueError for -1743")
                except ValueError as exc:
                    assert "系统设置" in str(exc)

            # Non-macOS fallback check
            with patch("app.mail_calendar.sys.platform", "linux"):
                assert mail_calendar.list_macos_calendars()["supported"] is False
                try:
                    mail_calendar.write_macos_calendar([meet_item])
                    raise AssertionError("Expected ValueError on linux")
                except ValueError as exc:
                    assert ".ics" in str(exc)

            # FastAPI routes (verifying static routes take precedence over /{email_id})
            test_app = FastAPI()
            test_app.include_router(productivity_router)
            with TestClient(test_app) as client:
                r_tl = client.get("/api/productivity/calendar/timeline")
                assert r_tl.status_code == 200
                assert r_tl.json()["summary"]["ics_count"] == 2

                # Existing email_id route remains intact
                r_email = client.get(f"/api/productivity/calendar/{e_meet}")
                assert r_email.status_code == 200
                assert r_email.json()["items"][0]["summary"] == "周度项目评审会"

                r_create = client.post("/api/productivity/calendar/events", json={
                    "title": "临时复盘会",
                    "start": f"{tomorrow_iso}T17:00",
                    "end": f"{tomorrow_iso}T17:45",
                    "location": "会议室 B",
                })
                assert r_create.status_code == 200
                new_ev_id = r_create.json()["id"]

                r_bad = client.post("/api/productivity/calendar/events", json={"title": "", "start": tomorrow_iso})
                assert r_bad.status_code == 400

                r_batch = client.post("/api/productivity/calendar/export-batch", json={"items": [meet_item, allday_item]})
                assert r_batch.status_code == 200
                assert "text/calendar" in r_batch.headers.get("content-type", "")
                assert r_batch.text.count("BEGIN:VEVENT") == 2

                with patch("app.mail_calendar.sys.platform", "darwin"), patch(
                    "app.mail_calendar.subprocess.run", return_value=mock_list_proc
                ):
                    r_sys_list = client.get("/api/productivity/calendar/system-calendars")
                    assert r_sys_list.status_code == 200
                    assert r_sys_list.json()["calendars"] == ["工作", "个人"]

                with patch("app.mail_calendar.sys.platform", "darwin"), patch(
                    "app.mail_calendar.subprocess.run", return_value=mock_add_proc
                ):
                    r_sys_add = client.post(
                        "/api/productivity/calendar/system-add",
                        json={"calendar_name": "工作", "items": [meet_item]},
                    )
                    assert r_sys_add.status_code == 200
                    assert r_sys_add.json()["created"] == 2

                r_del = client.delete(f"/api/productivity/calendar/events/{new_ev_id}")
                assert r_del.status_code == 200 and r_del.json()["ok"] is True
                assert client.delete(f"/api/productivity/calendar/events/{new_ev_id}").status_code == 404
                assert mail_calendar.delete_custom_event(custom_id) is True

    print("PASS test_calendar_timeline: multi-source aggregation, conflict detection, batch ICS, mocked JXA & routes")


if __name__ == "__main__":
    main()
