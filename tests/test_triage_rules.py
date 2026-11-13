"""Subscription noise detection, safe batch triage, auto-triage rules & ingest integration."""
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import db, triage_rules
from app.account_context import use
from app.db import mail_tags
from app.web.routes.productivity import router as productivity_router


def _seed_inbox_messages(root: str):
    now = datetime.now()
    eml_dir = Path(root) / "eml"
    eml_dir.mkdir(parents=True, exist_ok=True)

    # 1. Automated subscription with List-Unsubscribe + repeated pushes (3 clean inbox messages)
    eml1 = eml_dir / "sub1.eml"
    eml1.write_text(
        "From: Newsletter <noreply@news.example.com>\n"
        "Subject: 每周技术推送 #101\n"
        "List-Unsubscribe: <https://news.example.com/unsub?u=1>, <mailto:unsub@news.example.com>\n"
        "Precedence: bulk\n\n"
        "本期精选文章。",
        encoding="utf-8",
    )
    e1 = db.upsert_email({
        "uid": 501,
        "folder": "INBOX",
        "message_id": "<sub-1@news.example.com>",
        "subject": "每周技术推送 #101",
        "from_addr": "noreply@news.example.com",
        "from_name": "技术周刊",
        "to_addr": "me@corp.test",
        "date": (now - timedelta(days=2)).isoformat(timespec="seconds"),
        "snippet": "本期精选",
        "body_text": "本期精选文章。",
        "raw_path": str(eml1),
        "list_unsubscribe": "<https://news.example.com/unsub?u=1>, <mailto:unsub@news.example.com>",
        "is_automated": 1,
        "status": "inbox",
        "verdict": "clean",
    })
    e2 = db.upsert_email({
        "uid": 502,
        "folder": "INBOX",
        "message_id": "<sub-2@news.example.com>",
        "subject": "每周技术推送 #102",
        "from_addr": "noreply@news.example.com",
        "from_name": "技术周刊",
        "to_addr": "me@corp.test",
        "date": (now - timedelta(days=1)).isoformat(timespec="seconds"),
        "snippet": "本期精选",
        "body_text": "本期精选文章。",
        "list_unsubscribe": "<https://news.example.com/unsub?u=1>",
        "is_automated": 1,
        "status": "inbox",
        "verdict": "clean",
    })
    e3 = db.upsert_email({
        "uid": 503,
        "folder": "INBOX",
        "message_id": "<sub-3@news.example.com>",
        "subject": "每周技术推送 #103",
        "from_addr": "noreply@news.example.com",
        "from_name": "技术周刊",
        "to_addr": "me@corp.test",
        "date": now.isoformat(timespec="seconds"),
        "snippet": "最新一期",
        "body_text": "最新精选文章。",
        "is_automated": 1,
        "status": "inbox",
        "verdict": "clean",
    })

    # 2. Normal 1:1 human email must NOT be treated as subscription noise
    e_human = db.upsert_email({
        "uid": 504,
        "folder": "INBOX",
        "message_id": "<human@partner.test>",
        "subject": "下周项目排期沟通",
        "from_addr": "alice@partner.test",
        "from_name": "Alice",
        "to_addr": "me@corp.test",
        "date": now.isoformat(timespec="seconds"),
        "snippet": "麻烦看下排期表",
        "body_text": "麻烦确认下下周排期表。",
        "status": "inbox",
        "verdict": "clean",
    })

    # 3. Quarantine phishing email must NEVER appear in subscriptions or auto-triage
    e_evil = db.upsert_email({
        "uid": 505,
        "folder": "INBOX",
        "message_id": "<evil@phish.test>",
        "subject": "系统订阅异常通知",
        "from_addr": "noreply@news.example.com",
        "from_name": "Fake News",
        "to_addr": "me@corp.test",
        "date": now.isoformat(timespec="seconds"),
        "snippet": "点击验证账号",
        "body_text": "点击验证账号",
        "status": "quarantine",
        "verdict": "phishing",
    })

    # 4. System report email for auto-triage rules test
    e_report = db.upsert_email({
        "uid": 506,
        "folder": "INBOX",
        "message_id": "<rep@ops.corp.test>",
        "subject": "【系统日报】今日平台巡检统计",
        "from_addr": "ops-bot@ops.corp.test",
        "from_name": "运维机器人",
        "to_addr": "me@corp.test",
        "date": now.isoformat(timespec="seconds"),
        "snippet": "各项指标正常",
        "body_text": "CPU 与数据库指标正常。",
        "status": "inbox",
        "verdict": "clean",
    })

    return e1, e2, e3, e_human, e_evil, e_report


def main():
    with tempfile.TemporaryDirectory() as root:
        account = dict(
            ACCOUNT_ID="triage-test",
            DB_PATH=str(Path(root) / "triage.db"),
            DATA_DIR=str(Path(root) / "triage"),
            IMAP_USER="me@corp.test",
        )
        with use(account):
            db.init_db()
            e1, e2, e3, e_human, e_evil, e_report = _seed_inbox_messages(root)

            # 1. Scan subscriptions
            scan = triage_rules.scan_subscriptions(days=45, min_count=2)
            assert scan["summary"]["total_groups"] == 1
            grp = scan["groups"][0]
            assert grp["sender_addr"] == "noreply@news.example.com"
            assert grp["total_count"] == 3  # phishing e_evil excluded!
            assert len(grp["unsubscribe_links"]) == 2
            assert grp["unsubscribe_links"][0]["kind"] == "url"

            # 2. Safe batch triage: keep_latest_done
            batch = triage_rules.triage_sender_batch("noreply@news.example.com", mode="keep_latest_done")
            assert batch["ok"] is True
            assert batch["kept_latest_id"] == e3
            assert batch["updated_count"] == 2
            assert set(batch["email_ids"]) == {e1, e2}
            assert db.get_email(e3)["is_read"] == 0
            assert db.get_email(e3)["handle_state"] == "unhandled"
            assert db.get_email(e1)["is_read"] == 1
            assert db.get_email(e1)["handle_state"] == "done"
            assert db.get_email(e_evil)["is_read"] == 0

            # 3. Rule validation checks
            for bad in (
                {"name": "", "conditions": [{"field": "sender", "value": "x"}], "actions": {"mark_read": True}},
                {"name": "no-action", "conditions": [{"field": "sender", "value": "x"}], "actions": {}},
                {"name": "bad-field", "conditions": [{"field": "bogus", "value": "x"}], "actions": {"mark_read": True}},
            ):
                try:
                    triage_rules.save_rule(bad)
                    raise AssertionError(f"Expected ValueError for {bad}")
                except ValueError:
                    pass

            # 4. Save tag + auto-triage rule with preview + apply + auto-on-ingest
            tag_res = mail_tags.save_tag("巡检归档", "#3b82f6")
            tag_id = tag_res["id"]
            rule_payload = {
                "name": "平台系统日报自动已读归档",
                "match_mode": "all",
                "conditions": [
                    {"field": "domain", "operator": "equals", "value": "ops.corp.test"},
                    {"field": "subject", "operator": "contains", "value": "系统日报"},
                ],
                "actions": {
                    "handle_state": "done",
                    "mark_read": True,
                    "mark_starred": False,
                    "tag_ids": [tag_id],
                },
            }
            preview = triage_rules.preview_rule(rule_payload)
            assert preview["matched_count"] == 1 and preview["items"][0]["id"] == e_report

            saved = triage_rules.save_rule(rule_payload)
            assert saved["enabled"] is True and saved["hit_count"] == 0

            applied = triage_rules.apply_rules_existing(saved["id"])
            assert applied["matched"] == 1 and applied["updated"] == 1
            rep_row = db.get_email(e_report)
            assert rep_row["is_read"] == 1
            assert rep_row["handle_state"] == "done"
            assert db.get_email(e_human)["handle_state"] == "unhandled"

            # 5. Newly ingested clean email matching rule triggers automatically inside upsert_email
            e_new = db.upsert_email({
                "uid": 507,
                "folder": "INBOX",
                "message_id": "<rep-2@ops.corp.test>",
                "subject": "【系统日报】晚间平台巡检统计",
                "from_addr": "ops-bot@ops.corp.test",
                "from_name": "运维机器人",
                "to_addr": "me@corp.test",
                "date": datetime.now().isoformat(timespec="seconds"),
                "snippet": "晚间巡检",
                "body_text": "全部正常",
                "status": "inbox",
                "verdict": "clean",
            })
            new_row = db.get_email(e_new)
            assert new_row["is_read"] == 1
            assert new_row["handle_state"] == "done"
            with db.conn() as c:
                tagged = c.execute("SELECT tag_id FROM email_tags WHERE email_id=?", (e_new,)).fetchall()
                assert [r[0] for r in tagged] == [tag_id]

            # Quarantined email matching same text MUST NOT be auto-triaged
            e_evil_ops = db.upsert_email({
                "uid": 508,
                "folder": "INBOX",
                "message_id": "<evil-rep@ops.corp.test>",
                "subject": "【系统日报】恶意钓鱼",
                "from_addr": "ops-bot@ops.corp.test",
                "from_name": "运维机器人",
                "to_addr": "me@corp.test",
                "date": datetime.now().isoformat(timespec="seconds"),
                "snippet": "点击登录",
                "body_text": "点击登录",
                "status": "quarantine",
                "verdict": "phishing",
            })
            assert db.get_email(e_evil_ops)["is_read"] == 0
            assert db.get_email(e_evil_ops)["handle_state"] == "unhandled"

            # 6. FastAPI endpoints test
            test_app = FastAPI()
            test_app.include_router(productivity_router)
            with TestClient(test_app) as client:
                r_subs = client.get("/api/productivity/triage/subscriptions")
                assert r_subs.status_code == 200
                sub_addrs = {g["sender_addr"] for g in r_subs.json()["groups"]}
                assert "noreply@news.example.com" in sub_addrs and "ops-bot@ops.corp.test" in sub_addrs
                assert "alice@partner.test" not in sub_addrs

                r_list = client.get("/api/productivity/triage/rules")
                assert r_list.status_code == 200
                assert len(r_list.json()["rules"]) == 1 and r_list.json()["rules"][0]["hit_count"] == 2

                r_toggle = client.patch(f"/api/productivity/triage/rules/{saved['id']}", json={"enabled": False})
                assert r_toggle.status_code == 200 and r_toggle.json()["enabled"] is False

                r_batch = client.post("/api/productivity/triage/sender-batch", json={
                    "sender_addr": "noreply@news.example.com",
                    "mode": "all_done",
                })
                assert r_batch.status_code == 200 and r_batch.json()["updated_count"] == 1

                r_del = client.delete(f"/api/productivity/triage/rules/{saved['id']}")
                assert r_del.status_code == 200
                assert client.delete(f"/api/productivity/triage/rules/{saved['id']}").status_code == 404

            # 7. Regression guard: batch triage must respect `days` window & preserve starred/favorite/followup/snoozed
            guard_sender = "digest@guard.example.com"
            recent_ids = []
            for idx in range(4):
                recent_ids.append(db.upsert_email({
                    "uid": 600 + idx,
                    "folder": "INBOX",
                    "message_id": f"<guard-recent-{idx}@guard.example.com>",
                    "subject": f"产品周报 #{idx + 1}",
                    "from_addr": guard_sender,
                    "from_name": "产品周报",
                    "to_addr": "me@corp.test",
                    "date": (datetime.now() - timedelta(days=idx + 1)).isoformat(timespec="seconds"),
                    "snippet": "周期推送",
                    "body_text": "本周产品更新。",
                    "list_unsubscribe": "<https://guard.example.com/unsub>",
                    "is_automated": 1,
                    "status": "inbox",
                    "verdict": "clean",
                }))
            old_starred_id = db.upsert_email({
                "uid": 610,
                "folder": "INBOX",
                "message_id": "<guard-old-starred@guard.example.com>",
                "subject": "重要历史存档（60天前）",
                "from_addr": guard_sender,
                "from_name": "产品周报",
                "to_addr": "me@corp.test",
                "date": (datetime.now() - timedelta(days=60)).isoformat(timespec="seconds"),
                "snippet": "星标存档",
                "body_text": "长期留存。",
                "is_automated": 1,
                "status": "inbox",
                "verdict": "clean",
            })
            old_unstarred_id = db.upsert_email({
                "uid": 611,
                "folder": "INBOX",
                "message_id": "<guard-old-plain@guard.example.com>",
                "subject": "60天前普通旧邮件",
                "from_addr": guard_sender,
                "from_name": "产品周报",
                "to_addr": "me@corp.test",
                "date": (datetime.now() - timedelta(days=55)).isoformat(timespec="seconds"),
                "snippet": "窗口外",
                "body_text": "超出列表时间窗口。",
                "is_automated": 1,
                "status": "inbox",
                "verdict": "clean",
            })
            followup_id = db.upsert_email({
                "uid": 612,
                "folder": "INBOX",
                "message_id": "<guard-followup@guard.example.com>",
                "subject": "本周周报（待跟进）",
                "from_addr": guard_sender,
                "from_name": "产品周报",
                "to_addr": "me@corp.test",
                "date": (datetime.now() - timedelta(days=2)).isoformat(timespec="seconds"),
                "snippet": "待跟进",
                "body_text": "带跟进提醒。",
                "is_automated": 1,
                "status": "inbox",
                "verdict": "clean",
            })
            snoozed_id = db.upsert_email({
                "uid": 613,
                "folder": "INBOX",
                "message_id": "<guard-snooze@guard.example.com>",
                "subject": "本周周报（稍后提醒）",
                "from_addr": guard_sender,
                "from_name": "产品周报",
                "to_addr": "me@corp.test",
                "date": (datetime.now() - timedelta(days=3)).isoformat(timespec="seconds"),
                "snippet": "稍后提醒",
                "body_text": "带稍后提醒。",
                "is_automated": 1,
                "status": "inbox",
                "verdict": "clean",
            })
            recent_starred_id = db.upsert_email({
                "uid": 614,
                "folder": "INBOX",
                "message_id": "<guard-recent-starred@guard.example.com>",
                "subject": "本周周报（已加星标）",
                "from_addr": guard_sender,
                "from_name": "产品周报",
                "to_addr": "me@corp.test",
                "date": (datetime.now() - timedelta(days=1)).isoformat(timespec="seconds"),
                "snippet": "星标保留",
                "body_text": "最近且已加星标。",
                "is_automated": 1,
                "status": "inbox",
                "verdict": "clean",
            })
            with db.conn() as c:
                c.execute(
                    "UPDATE emails SET is_starred=1, is_favorite=1 WHERE id=?",
                    (old_starred_id,),
                )
                c.execute(
                    "UPDATE emails SET is_starred=1 WHERE id=?",
                    (recent_starred_id,),
                )
                c.execute(
                    "UPDATE emails SET followup_at=? WHERE id=?",
                    ((datetime.now() + timedelta(days=2)).isoformat(timespec="minutes"), followup_id),
                )
                c.execute(
                    "UPDATE emails SET snoozed_until=? WHERE id=?",
                    ((datetime.now() + timedelta(days=1)).isoformat(timespec="minutes"), snoozed_id),
                )

            guard_scan = triage_rules.scan_subscriptions(days=45, min_count=2)
            guard_grp = next(g for g in guard_scan["groups"] if g["sender_addr"] == guard_sender)
            assert guard_grp["total_count"] == 4, guard_grp

            guard_batch = triage_rules.triage_sender_batch(guard_sender, mode="all_done", days=45)
            assert guard_batch["updated_count"] == 4, guard_batch
            assert set(guard_batch["email_ids"]) == set(recent_ids)
            for rid in recent_ids:
                row = db.get_email(rid)
                assert row["is_read"] == 1 and row["handle_state"] == "done"
            for pid in (old_starred_id, old_unstarred_id, followup_id, snoozed_id, recent_starred_id):
                row = db.get_email(pid)
                assert row["is_read"] == 0, (pid, row)
                assert row["handle_state"] == "unhandled", (pid, row)
            assert db.get_email(followup_id)["followup_at"] != ""
            assert db.get_email(snoozed_id)["snoozed_until"] != ""

            # 8. The batch endpoint rejects invalid windows and shares the scan's candidate limit.
            with TestClient(test_app) as client:
                for bad_days in ('"bad"', 'true', '7.9', '1e309'):
                    r_bad = client.post(
                        "/api/productivity/triage/sender-batch",
                        content=f'{{"sender_addr":"{guard_sender}","mode":"all_done","days":{bad_days}}}',
                        headers={"Content-Type": "application/json"},
                    )
                    assert r_bad.status_code == 400, (bad_days, r_bad.status_code, r_bad.text)
                    assert r_bad.json()["detail"] == "统计天数参数无效"

            cap_sender = "cap@limit.example.com"
            base_dt = datetime.now() - timedelta(days=1)
            with db.conn() as c:
                # 1 oldest email (#1202 overall inside 45d window) + 1,199 filler emails + 2 newer cap emails
                old_extra_dt = (base_dt - timedelta(days=20)).isoformat(timespec="seconds")
                c.execute(
                    "INSERT INTO emails(uid, folder, message_id, subject, from_addr, from_name, to_addr, date, snippet, body_text, is_automated, status, verdict, created_at) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (5000, "INBOX", "<cap-old@limit.example.com>", "超窗第3封", cap_sender, "Cap", "me@corp.test",
                     old_extra_dt, "cap", "cap", 1, "inbox", "clean", old_extra_dt),
                )
                cap_extra_id = c.execute("SELECT last_insert_rowid()").fetchone()[0]
                filler_rows = []
                for idx in range(1199):
                    dt_iso = (base_dt - timedelta(seconds=1200 - idx)).isoformat(timespec="seconds")
                    filler_rows.append((
                        5001 + idx, "INBOX", f"<filler-{idx}@bulk.example.com>", f"Filler {idx}",
                        "filler@bulk.example.com", "Filler", "me@corp.test",
                        dt_iso, "filler", "filler", 1, "inbox", "clean", dt_iso,
                    ))
                c.executemany(
                    "INSERT INTO emails(uid, folder, message_id, subject, from_addr, from_name, to_addr, date, snippet, body_text, is_automated, status, verdict, created_at) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    filler_rows,
                )
                for idx in range(2):
                    dt_iso = (datetime.now() - timedelta(minutes=2 - idx)).isoformat(timespec="seconds")
                    c.execute(
                        "INSERT INTO emails(uid, folder, message_id, subject, from_addr, from_name, to_addr, date, snippet, body_text, is_automated, status, verdict, created_at) "
                        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (7000 + idx, "INBOX", f"<cap-new-{idx}@limit.example.com>", f"列表内推送 #{idx}",
                         cap_sender, "Cap", "me@corp.test", dt_iso, "cap", "cap", 1, "inbox", "clean", dt_iso),
                    )

            cap_scan = triage_rules.scan_subscriptions(days=45, min_count=2)
            cap_grp = next(g for g in cap_scan["groups"] if g["sender_addr"] == cap_sender)
            assert cap_grp["total_count"] == 2, cap_grp

            with TestClient(test_app) as client:
                response = client.post("/api/productivity/triage/sender-batch", json={
                    "sender_addr": cap_sender,
                    "mode": "all_done",
                    "days": "45",
                })
                assert response.status_code == 200, response.text
                cap_batch = response.json()
            assert cap_batch["days"] == 45
            assert cap_batch["updated_count"] == 2, cap_batch
            assert cap_extra_id not in cap_batch["email_ids"]
            assert db.get_email(cap_extra_id)["is_read"] == 0
            assert db.get_email(cap_extra_id)["handle_state"] == "unhandled"

    print("PASS test_triage_rules: subscription scan, safe batch cleanup, rule preview/apply, ingest hook & API CRUD")


if __name__ == "__main__":
    main()
