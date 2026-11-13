"""Periodic work briefing: window aggregation, todos/followups/mail signals, AI/local fallback, streaming & history CRUD."""
import json
import sys
import tempfile
from datetime import date, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import db, periodic_briefing, sent_followups, work_assistant, work_memory
from app.account_context import use
from app.web.routes.reports import router as reports_router


def _seed_sample_data(today: date):
    today_iso = today.isoformat()
    yesterday_iso = (today - timedelta(days=1)).isoformat()
    ten_days_ago_iso = (today - timedelta(days=10)).isoformat()

    # 1. Work inbox emails in current week/7d window
    e_proj = db.upsert_email({
        "uid": 101,
        "folder": "INBOX",
        "message_id": "<msg-101@corp.test>",
        "subject": "宝信运维平台月度汇报定稿通知",
        "from_addr": "boss@corp.test",
        "from_name": "张总",
        "to_addr": "me@corp.test",
        "date": f"{today_iso}T09:30:00",
        "snippet": "请周四前提交运维平台改造进展摘要",
        "body_text": "请周四前提交运维平台改造进展摘要。",
        "status": "inbox",
        "verdict": "clean",
        "priority": "高",
        "category": "项目推进",
        "summary": "要求周四前汇总运维平台二期节点并确认风险。",
    })
    work_assistant.save_context(e_proj, project="运维平台改造", role="项目负责人", note="周五前对齐交付节点", revision=0)

    # 2. Phishing/quarantine email must NEVER leak into work briefing
    db.upsert_email({
        "uid": 102,
        "folder": "INBOX",
        "message_id": "<msg-102@evil.test>",
        "subject": "异常账单钓鱼邮件",
        "from_addr": "fake@evil.test",
        "from_name": "Fake",
        "to_addr": "me@corp.test",
        "date": f"{today_iso}T10:00:00",
        "snippet": "点击重置密码",
        "body_text": "点击重置密码",
        "status": "quarantine",
        "verdict": "phishing",
        "priority": "高",
        "summary": "高危钓鱼邮件",
    })

    # 3. Older email (10 days ago, outside last_7_days, inside last_30_days)
    e_old = db.upsert_email({
        "uid": 103,
        "folder": "INBOX",
        "message_id": "<msg-103@corp.test>",
        "subject": "月初服务器扩容预算沟通",
        "from_addr": "ops@corp.test",
        "from_name": "运维部",
        "to_addr": "me@corp.test",
        "date": f"{ten_days_ago_iso}T14:00:00",
        "snippet": "下周确定扩容预算",
        "body_text": "确定扩容预算。",
        "status": "inbox",
        "verdict": "clean",
        "priority": "中",
        "summary": "讨论月初扩容预算。",
    })

    # 4. Todos: 1 done in window, 1 overdue open, 1 upcoming open
    db.add_todos(e_proj, [
        {"title": "提交运维平台一期验收材料", "deadline": today_iso},
        {"title": "核对线上监控告警阈值", "deadline": yesterday_iso},
        {"title": "梳理下周巡检排班表", "deadline": (today + timedelta(days=3)).isoformat()},
    ])
    todos = db.list_todos(include_done=True)
    done_todo = next(t for t in todos if t["title"] == "提交运维平台一期验收材料")
    db.set_todo_status(done_todo["id"], "done")

    # 5. Sent message & follow-ups (1 due waiting, 1 replied in window)
    with db.conn() as c:
        cur1 = c.execute(
            "INSERT INTO sent_messages(message_id,from_addr,to_addr,subject,body_html,status,created_at,sent_at) "
            "VALUES(?,?,?,?,?,?,?,?)",
            ("<sent-1@corp.test>", "me@corp.test", "partner@vendor.test", "接口联调接口字段确认", "<p>请确认字段定义</p>", "sent",
             f"{yesterday_iso}T10:00:00", f"{yesterday_iso}T10:00:00"),
        )
        sent_waiting_id = cur1.lastrowid
        c.execute(
            "INSERT INTO sent_followups(sent_id,at,state,created_at) VALUES(?,?,?,?)",
            (sent_waiting_id, f"{yesterday_iso}T18:00:00", "scheduled", f"{yesterday_iso}T10:01:00"),
        )
        cur2 = c.execute(
            "INSERT INTO sent_messages(message_id,from_addr,to_addr,subject,body_html,status,created_at,sent_at) "
            "VALUES(?,?,?,?,?,?,?,?)",
            ("<sent-2@corp.test>", "me@corp.test", "boss@corp.test", "Q4 汇报提纲初稿", "<p>附件为初稿</p>", "sent",
             f"{today_iso}T08:00:00", f"{today_iso}T08:00:00"),
        )
        sent_replied_id = cur2.lastrowid
        c.execute(
            "INSERT INTO sent_followups(sent_id,at,state,reply_id,created_at) VALUES(?,?,?,?,?)",
            (sent_replied_id, f"{today_iso}T18:00:00", "replied", e_proj, f"{today_iso}T08:01:00"),
        )

    return e_proj, e_old, done_todo["id"]


def main():
    today = date.today()
    today_iso = today.isoformat()

    with tempfile.TemporaryDirectory() as root:
        account = dict(
            ACCOUNT_ID="briefing-test",
            DB_PATH=str(Path(root) / "briefing.db"),
            DATA_DIR=str(Path(root) / "briefing"),
            IMAP_USER="me@corp.test",
        )
        with use(account):
            db.init_db()

            # Empty window should produce valid non-empty guidance rather than crashing
            empty_res = periodic_briefing.generate_briefing(
                period="last_7_days", mode="local", save=False, today=today
            )
            assert empty_res["source"] == "local"
            assert "暂无可汇总的工作记录" in empty_res["content"]

            # Window validation checks
            for bad_kwargs in (
                dict(period="invalid"),
                dict(period="custom", start_date="", end_date=""),
                dict(period="custom", start_date="2026-11-10", end_date="2026-11-01"),
                dict(period="custom", start_date="2026-01-01", end_date="2026-08-01"),
            ):
                try:
                    periodic_briefing.resolve_window(**bad_kwargs, today=today)
                    raise AssertionError(f"Expected ValueError for {bad_kwargs}")
                except ValueError:
                    pass

            e_proj, e_old, _ = _seed_sample_data(today)

            # Collect 7d summary: phishing isolated, high-priority & work_context included
            summary_7d = periodic_briefing.collect_summary("last_7_days", today=today)
            m7 = summary_7d["metrics"]
            assert m7["received_count"] == 1, f"Expected 1 clean email in 7d, got {m7}"
            assert m7["sent_count"] == 2
            assert m7["todos_done_count"] == 1
            assert m7["todos_open_count"] == 2
            assert m7["todos_overdue_count"] == 1
            assert m7["followups_waiting_count"] == 1
            assert m7["followups_due_count"] == 1
            assert m7["followups_replied_count"] == 1
            assert "运维平台改造" in summary_7d["highlights"]["projects"]
            subjects_7d = [e["subject"] for e in summary_7d["highlights"]["key_emails"]]
            assert "异常账单钓鱼邮件" not in subjects_7d
            assert "月初服务器扩容预算沟通" not in subjects_7d

            # 30d window includes older email too
            summary_30d = periodic_briefing.collect_summary("last_30_days", today=today)
            assert summary_30d["metrics"]["received_count"] == 2

            # Offline auto / local generation auto-saves into history
            with patch("app.periodic_briefing.llm_client.available", return_value=False):
                local_res = periodic_briefing.generate_briefing(
                    period="last_7_days", style="leader", focus="重点看运维平台验收", mode="auto", today=today
                )
            assert local_res["source"] == "local"
            assert local_res["briefing"] and local_res["briefing"]["id"] > 0
            assert f"[email_id:{e_proj}]" in local_res["content"]
            assert "[⚠️过期]" in local_res["content"]
            assert "提交运维平台一期验收材料" in local_res["content"]
            assert "重点看运维平台验收" in local_res["content"]

            # mode='ai' errors cleanly when LLM unavailable
            with patch("app.periodic_briefing.llm_client.available", return_value=False):
                try:
                    periodic_briefing.generate_briefing(period="last_7_days", mode="ai", today=today)
                    raise AssertionError("Expected ValueError when AI unavailable")
                except ValueError as exc:
                    assert "模型尚未配置" in str(exc)

            # AI generation passes writing memory + role preset when include_preferences=True,
            # and skips them when include_preferences=False
            work_assistant.save_preferences("周报优先量化里程碑完成率", 0)
            mem_settings = work_memory.settings()
            work_memory.save_settings(True, False, mem_settings["revision"])
            captured = []

            def fake_stream(messages, **kwargs):
                captured.append(messages)
                yield "## 本周工作简报\n\n### 一、核心推进\n- 运维平台改造按期提交"
                yield f" [email_id:{e_proj}]\n"

            with (
                patch("app.periodic_briefing.llm_client.available", return_value=True),
                patch("app.periodic_briefing.llm_client.chat_completion_stream", side_effect=fake_stream),
            ):
                events = list(periodic_briefing.stream_briefing(
                    period="last_7_days", style="leader", include_preferences=True, mode="ai", today=today
                ))
            assert events[0]["type"] == "meta"
            assert events[-1]["type"] == "done" and events[-1]["source"] == "ai"
            assert events[-1]["briefing"]["source"] == "ai"
            assert "周报优先量化里程碑完成率" in captured[0][0]["content"]

            with (
                patch("app.periodic_briefing.llm_client.available", return_value=True),
                patch("app.periodic_briefing.llm_client.chat_completion_stream", side_effect=fake_stream),
            ):
                list(periodic_briefing.stream_briefing(
                    period="last_7_days", style="team", include_preferences=False, mode="ai", today=today
                ))
            assert "周报优先量化里程碑完成率" not in captured[1][0]["content"]

            # Edit & re-save existing briefing, list & delete via FastAPI endpoints
            test_app = FastAPI()
            test_app.include_router(reports_router)
            with TestClient(test_app) as client:
                resp = client.get("/api/work/briefings/preview?period=last_7_days")
                assert resp.status_code == 200
                assert resp.json()["metrics"]["sent_count"] == 2

                resp_bad = client.get("/api/work/briefings/preview?period=custom")
                assert resp_bad.status_code == 400

                resp_hist = client.get("/api/work/briefings")
                assert resp_hist.status_code == 200
                hist = resp_hist.json()
                assert len(hist) == 3  # 1 local + 2 ai streams

                bid = hist[0]["id"]
                resp_update = client.post("/api/work/briefings", json={
                    "briefing_id": bid,
                    "period": "last_7_days",
                    "start_date": today_iso,
                    "end_date": today_iso,
                    "style": "leader",
                    "title": "【工作周报】已微调版",
                    "content": "## 已修改内容\n- 完成联调确认",
                    "metrics": {"sent_count": 2},
                    "source": "ai",
                })
                assert resp_update.status_code == 200
                assert resp_update.json()["title"] == "【工作周报】已微调版"

                resp_detail = client.get(f"/api/work/briefings/{bid}")
                assert resp_detail.status_code == 200
                assert "完成联调确认" in resp_detail.json()["content"]

                resp_stream = client.post("/api/work/briefings/stream", json={
                    "period": "this_month",
                    "style": "log",
                    "mode": "local",
                    "save": True,
                })
                assert resp_stream.status_code == 200
                stream_events = [json.loads(line) for line in resp_stream.text.strip().splitlines() if line.strip()]
                assert any(e["type"] == "done" for e in stream_events)

                resp_del = client.delete(f"/api/work/briefings/{bid}")
                assert resp_del.status_code == 200
                assert client.get(f"/api/work/briefings/{bid}").status_code == 404

    print("PASS test_periodic_briefing: window validation, aggregation, AI/local fallback, streaming, privacy & API CRUD")


if __name__ == "__main__":
    main()
