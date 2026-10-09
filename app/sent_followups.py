"""Account-local reminders for successfully sent mail; never sends a follow-up email."""

import time
from datetime import datetime, timedelta
from . import db, config
from .productivity import local_time


def initialize(c):
    c.execute(
        "CREATE TABLE IF NOT EXISTS sent_followups(sent_id INTEGER PRIMARY KEY,at TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'scheduled',reply_id INTEGER,sent INTEGER NOT NULL DEFAULT 0,retry_after REAL NOT NULL DEFAULT 0,created_at TEXT NOT NULL)"
    )
    c.execute(
        "CREATE INDEX IF NOT EXISTS idx_sent_followups_due ON sent_followups(state,at,retry_after)"
    )


def register(sent_id, days=0, at=""):
    if not days and not at:
        return
    row = db.get_sent_message(sent_id)
    if not row or row.get("status") != "sent" or not row.get("message_id"):
        raise ValueError("仅成功发送且带邮件标识的记录可安排跟进")
    sent_at = datetime.fromisoformat(row["sent_at"])
    when = (
        local_time(at)
        if at
        else (sent_at + timedelta(days=days)).isoformat(timespec="seconds")
    )
    with db.conn() as c:
        c.execute(
            "INSERT OR IGNORE INTO sent_followups(sent_id,at,created_at) VALUES(?,?,?)",
            (sent_id, when, datetime.now().isoformat()),
        )


def refresh():
    with db.conn() as c:
        c.execute(
            "UPDATE sent_followups SET state='replied',reply_id=(SELECT r.id FROM emails r JOIN sent_messages s ON s.id=sent_followups.sent_id WHERE r.remote_missing=0 AND r.status='inbox' AND (r.verdict='clean' OR r.feedback='fp') AND lower(r.from_addr)<>? AND s.message_id<>'' AND (lower(trim(r.in_reply_to))=lower(trim(s.message_id)) OR instr(lower(r.references_header),lower(trim(s.message_id)))>0) AND datetime(r.date)>datetime(s.sent_at) ORDER BY r.date LIMIT 1) WHERE state='scheduled' AND EXISTS(SELECT 1 FROM emails r JOIN sent_messages s ON s.id=sent_followups.sent_id WHERE r.remote_missing=0 AND r.status='inbox' AND (r.verdict='clean' OR r.feedback='fp') AND lower(r.from_addr)<>? AND s.message_id<>'' AND (lower(trim(r.in_reply_to))=lower(trim(s.message_id)) OR instr(lower(r.references_header),lower(trim(s.message_id)))>0) AND datetime(r.date)>datetime(s.sent_at))",
            ((config.IMAP_USER or "").casefold(),) * 2,
        )


def items():
    refresh()
    with db.conn() as c:
        return [
            dict(row)
            for row in c.execute(
                "SELECT f.*,s.subject,s.to_addr,s.sent_at FROM sent_followups f JOIN sent_messages s ON s.id=f.sent_id ORDER BY f.created_at DESC LIMIT 200"
            )
        ]


def arrange(sent_id, at="", cancel=False):
    when = local_time(at, future=True) if not cancel else ""
    with db.conn() as c:
        c.execute("BEGIN IMMEDIATE")
        row = c.execute(
            "SELECT state FROM sent_followups WHERE sent_id=?", (sent_id,)
        ).fetchone()
        if not row:
            raise ValueError("跟进记录不存在")
        if not cancel and row["state"] == "replied":
            raise ValueError("已同步到回复，请核对会话后再安排新的待办")
        c.execute(
            "UPDATE sent_followups SET state=?,at=CASE WHEN ?<>'' THEN ? ELSE at END,sent=0,retry_after=0 WHERE sent_id=?",
            ("canceled" if cancel else "scheduled", when, when, sent_id),
        )
    return {"ok": True}


def dispatch(account_id, account, send=None):
    from .account_context import use
    from .task_notifications import deliver
    from .ui_copy import ui_text

    send = send or deliver
    with use(
        {
            "ACCOUNT_ID": account_id,
            "DB_PATH": account["db_path"],
            "IMAP_USER": account.get("user", ""),
        }
    ):
        with db.conn() as c:
            initialize(c)
        refresh()
        with db.conn() as c:
            c.execute("BEGIN IMMEDIATE")
            rows = c.execute(
                "SELECT f.sent_id,f.at,s.subject FROM sent_followups f JOIN sent_messages s ON s.id=f.sent_id WHERE f.state='scheduled' AND f.sent=0 AND f.retry_after<=? AND f.at<=? AND s.status='sent' ORDER BY f.at LIMIT 20",
                (time.time(), datetime.now().isoformat()),
            ).fetchall()
            for row in rows:
                c.execute(
                    "UPDATE sent_followups SET retry_after=? WHERE sent_id=? AND at=?",
                    (time.time() + 60, row["sent_id"], row["at"]),
                )
        delivered = 0
        for row in rows:
            try:
                accepted = send(
                    ui_text('MailAI · 发出的邮件需要跟进'),
                    ui_text('本机尚未同步到回复：') + (row["subject"] or ui_text('邮件'))[:120],
                    {"accountId": account_id, "sentFollowupId": row["sent_id"]},
                )
            except Exception:
                accepted = False
            if accepted:
                with db.conn() as c:
                    c.execute(
                        "UPDATE sent_followups SET sent=1 WHERE sent_id=? AND at=? AND state='scheduled'",
                        (row["sent_id"], row["at"]),
                    )
                delivered += 1
        return delivered
