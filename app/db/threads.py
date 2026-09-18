"""会话线程与发件人行为画像。"""
import json
from datetime import datetime

from .core import conn
from .emails import _decode_rows


# ---------- threads ----------

def upsert_thread(thread_id: str, message_ids: list, participant_domains: list,
                  summary: str | None, last_email_id: int):
    now = datetime.now().isoformat(timespec="seconds")
    with conn() as c:
        c.execute(
            "INSERT INTO threads(thread_id, message_ids, participant_domains, summary, last_email_id, updated_at) "
            "VALUES(?,?,?,?,?,?) "
            "ON CONFLICT(thread_id) DO UPDATE SET "
            "message_ids=excluded.message_ids, participant_domains=excluded.participant_domains, "
            "summary=excluded.summary, last_email_id=excluded.last_email_id, updated_at=excluded.updated_at",
            (thread_id, json.dumps(message_ids, ensure_ascii=False),
             json.dumps(participant_domains, ensure_ascii=False), summary, last_email_id, now),
        )


def get_thread(thread_id: str):
    with conn() as c:
        row = c.execute("SELECT * FROM threads WHERE thread_id=?", (thread_id,)).fetchone()
        if not row:
            return None
        d = dict(row)
        for k in ("message_ids", "participant_domains"):
            try:
                d[k] = json.loads(d.get(k) or "[]")
            except (TypeError, json.JSONDecodeError):
                d[k] = []
        return d


def list_thread_emails(thread_id: str, limit: int = 10):
    with conn() as c:
        return _decode_rows(
            c.execute(
                "SELECT * FROM emails WHERE thread_id=? ORDER BY date DESC LIMIT ?",
                (thread_id, limit),
            ).fetchall()
        )


# ---------- sender_profiles ----------

def get_or_create_sender_profile(sender_key: str):
    now = datetime.now().isoformat(timespec="seconds")
    with conn() as c:
        row = c.execute("SELECT * FROM sender_profiles WHERE sender_key=?", (sender_key.lower(),)).fetchone()
        if row:
            d = dict(row)
            for k in ("hour_histogram", "attachment_names", "attachment_types", "typical_categories", "linguistic_signature"):
                try:
                    d[k] = json.loads(d.get(k) or ("{}" if "signature" in k or "histogram" in k else "[]"))
                except (TypeError, json.JSONDecodeError):
                    d[k] = {} if "signature" in k or "histogram" in k else []
            return d
        c.execute(
            "INSERT INTO sender_profiles(sender_key, created_at, updated_at) VALUES(?,?,?)",
            (sender_key.lower(), now, now),
        )
        # 插入后直接查询，避免递归导致的事务嵌套/锁竞争
        row = c.execute("SELECT * FROM sender_profiles WHERE sender_key=?", (sender_key.lower(),)).fetchone()
        d = dict(row) if row else {"sender_key": sender_key.lower()}
        for k in ("hour_histogram", "attachment_names", "attachment_types", "typical_categories", "linguistic_signature"):
            try:
                d[k] = json.loads(d.get(k) or ("{}" if "signature" in k or "histogram" in k else "[]"))
            except (TypeError, json.JSONDecodeError):
                d[k] = {} if "signature" in k or "histogram" in k else []
        return d


def update_sender_profile(profile: dict):
    now = datetime.now().isoformat(timespec="seconds")
    profile = dict(profile)
    for k in ("hour_histogram", "attachment_names", "attachment_types", "typical_categories", "linguistic_signature"):
        if not isinstance(profile.get(k), str):
            profile[k] = json.dumps(profile.get(k) or ({} if "signature" in k or "histogram" in k else []), ensure_ascii=False)
    with conn() as c:
        c.execute(
            "UPDATE sender_profiles SET "
            "from_domain=?, first_seen=?, last_seen=?, message_count=?, internal_count=?, "
            "external_count=?, hour_histogram=?, attachment_names=?, attachment_types=?, "
            "typical_categories=?, avg_body_length=?, linguistic_signature=?, risk_score=?, updated_at=? "
            "WHERE sender_key=?",
            (profile.get("from_domain"), profile.get("first_seen"), profile.get("last_seen"),
             profile.get("message_count", 0), profile.get("internal_count", 0),
             profile.get("external_count", 0), profile.get("hour_histogram"),
             profile.get("attachment_names"), profile.get("attachment_types"),
             profile.get("typical_categories"), profile.get("avg_body_length", 0),
             profile.get("linguistic_signature"), profile.get("risk_score", 0), now,
             profile["sender_key"].lower()),
        )


def sender_risk_top(n: int = 5):
    with conn() as c:
        return [dict(r) for r in c.execute(
            "SELECT * FROM sender_profiles ORDER BY risk_score DESC, message_count DESC LIMIT ?",
            (n,),
        ).fetchall()]
