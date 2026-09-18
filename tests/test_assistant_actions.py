"""助手受控操作：意图识别、白名单校验、执行与审计。"""
import os
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import assistant_actions, config, db, mail_assistant


def _insert_email(uid, sender="boss@example.com", subject="合同审批", is_read=0):
    with db.conn() as c:
        c.execute(
            "INSERT INTO emails(uid,folder,from_addr,subject,date,is_read,message_id,"
            "created_at,remote_missing) VALUES(?,?,?,?,?,?,?,?,0)",
            (uid, "INBOX", sender, subject, "2026-09-18T10:00:00", is_read,
             f"<m{uid}@example.com>", "2026-09-18T10:00:00"),
        )
        return c.execute("SELECT id FROM emails WHERE uid=?", (uid,)).fetchone()[0]


def _audit_rows(action=None):
    with db.conn() as c:
        if action:
            return [dict(r) for r in c.execute(
                "SELECT * FROM audit_logs WHERE action=?", (action,)).fetchall()]
        return [dict(r) for r in c.execute("SELECT * FROM audit_logs").fetchall()]


def main():
    with tempfile.TemporaryDirectory() as root, \
            patch.object(config, "DB_PATH", os.path.join(root, "mail.db")), \
            patch.object(config, "IMAP_USER", "me@example.com"):
        db.init_db()
        email_id = _insert_email(1)

        # ---- 意图识别 ----
        p = assistant_actions.detect_proposal("帮我建个待办：周五前确认合同交期")
        assert p and p["type"] == "create_todo" and p["requires_confirmation"]
        assert "确认合同交期" in p["params"]["title"]
        assert p["params"]["deadline"] is not None
        weekday = datetime.fromisoformat(p["params"]["deadline"]).weekday()
        assert weekday == 4, p["params"]["deadline"]  # 周五

        p = assistant_actions.detect_proposal("把这几封标记已读", [email_id])
        assert p and p["type"] == "mark_read" and p["params"]["email_ids"] == [email_id]

        p = assistant_actions.detect_proposal("帮我回复这封邮件", [email_id])
        assert p and p["type"] == "draft_reply" and "boss@example.com" in p["summary"]

        assert assistant_actions.detect_proposal("帮我回复这封邮件") is None  # 无上下文邮件
        assert assistant_actions.detect_proposal("这周有什么重要邮件？") is None
        assert assistant_actions.detect_proposal("") is None

        # ---- create_todo 执行 + 审计 ----
        result = assistant_actions.execute_action("create_todo", dict(p and {"title": "确认合同交期", "deadline": "2026-09-25", "email_id": email_id} or {}))
        assert result["ok"] and result["deadline"] == "2026-09-25"
        with db.conn() as c:
            todos = [dict(r) for r in c.execute("SELECT * FROM todos").fetchall()]
        assert len(todos) == 1 and todos[0]["title"] == "确认合同交期"
        assert todos[0]["email_id"] == email_id
        logs = _audit_rows("assistant_create_todo")
        assert len(logs) == 1 and logs[0]["actor"] == "assistant_confirmed"

        # ---- mark_read 执行 + 审计 ----
        result = assistant_actions.execute_action("mark_read", {"email_ids": [email_id]})
        assert result["ok"] and result["marked"] == 1
        assert db.get_email(email_id)["is_read"] == 1
        logs = _audit_rows("assistant_mark_read")
        assert logs and logs[0]["actor"] == "assistant_confirmed"

        # ---- draft_reply：收件人/主题由服务端推导，篡改参数无效 ----
        result = assistant_actions.execute_action("draft_reply", {
            "email_id": email_id, "to_addr": "evil@attacker.test", "subject": "tampered"})
        assert result["ok"] and result["to_addr"] == "boss@example.com"
        draft = db.get_draft(result["draft_id"])
        assert draft["to_addr"] == "boss@example.com"
        assert draft["subject"] == "Re: 合同审批"
        assert draft["mode"] == "reply" and draft["reply_to_email_id"] == email_id
        logs = _audit_rows("assistant_draft_reply")
        assert logs and logs[0]["actor"] == "assistant_confirmed"

        # ---- 白名单与参数校验 ----
        for bad_type in ("delete_email", "send_mail", "move_folder", "quarantine"):
            try:
                assistant_actions.execute_action(bad_type, {"email_id": email_id})
                raise AssertionError(f"{bad_type} 不应通过白名单")
            except ValueError as e:
                assert "白名单" in str(e)
        for bad_call in (
            lambda: assistant_actions.execute_action("create_todo", {"title": ""}),
            lambda: assistant_actions.execute_action("create_todo", {"title": "x", "deadline": "2026-13-99"}),
            lambda: assistant_actions.execute_action("mark_read", {"email_ids": []}),
            lambda: assistant_actions.execute_action("mark_read", {"email_ids": [99999]}),
            lambda: assistant_actions.execute_action("draft_reply", {"email_id": 99999}),
        ):
            try:
                bad_call()
                raise AssertionError("非法参数应被拒绝")
            except ValueError:
                pass

        # ---- ask() 附带 action 提议 ----
        answer = mail_assistant.ask("帮我建个待办：明天跟进合同")
        assert answer.get("action", {}).get("type") == "create_todo"
        answer = mail_assistant.ask("本周有什么风险邮件？")
        assert "action" not in answer

        # ---- ask_stream 先下发 action 事件 ----
        events = list(mail_assistant.ask_stream("把这几封标记已读", [], [email_id]))
        kinds = [k for k, _ in events]
        assert "action" in kinds and kinds.index("action") < kinds.index("sources"), kinds

    print("✅ 助手受控操作：意图识别、白名单、执行与审计测试通过")


if __name__ == "__main__":
    main()
