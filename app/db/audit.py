"""审计日志与自动处置记录。"""
import json
from datetime import datetime

from .core import conn


def add_audit_log(email_id: int | None, action: str, old_status: str | None = None,
                  new_status: str | None = None, actor: str = "system",
                  reason: str = "", meta: dict | None = None):
    now = datetime.now().isoformat(timespec="seconds")
    with conn() as c:
        c.execute(
            "INSERT INTO audit_logs(email_id, action, old_status, new_status, actor, reason, meta, created_at) "
            "VALUES(?,?,?,?,?,?,?,?)",
            (email_id, action, old_status, new_status, actor, reason,
             json.dumps(meta or {}, ensure_ascii=False), now),
        )


def list_audit_logs(email_id: int | None = None, limit: int = 100):
    sql = "SELECT * FROM audit_logs"
    args = []
    if email_id is not None:
        sql += " WHERE email_id=?"
        args.append(email_id)
    sql += " ORDER BY created_at DESC LIMIT ?"
    args.append(limit)
    with conn() as c:
        rows = [dict(r) for r in c.execute(sql, args).fetchall()]
        for r in rows:
            try:
                r["meta"] = json.loads(r.get("meta") or "{}")
            except (TypeError, json.JSONDecodeError):
                r["meta"] = {}
        return rows


def audit_action_exists(action: str) -> bool:
    with conn() as c:
        return c.execute("SELECT 1 FROM audit_logs WHERE action=? LIMIT 1", (action,)).fetchone() is not None


def list_auto_action_candidates(limit: int = 10):
    """返回仍处于自动移动目标文件夹、可安全回滚的最近邮件。"""
    with conn() as c:
        return [dict(r) for r in c.execute(
            "SELECT * FROM emails "
            "WHERE action_mode='auto' AND action_taken=1 "
            "AND status IN ('quarantine','spam') "
            "ORDER BY created_at DESC, id DESC LIMIT ?",
            (max(1, min(int(limit), 50)),),
        ).fetchall()]
