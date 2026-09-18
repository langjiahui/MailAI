"""日报历史记录。"""
from datetime import datetime

from .core import conn


def save_digest(content: str, digest_date: str | None = None):
    now = datetime.now().isoformat(timespec="seconds")
    if digest_date is None:
        digest_date = now[:10]
    with conn() as c:
        cur = c.execute(
            "INSERT INTO digest_history(digest_date, content, created_at) VALUES(?,?,?)",
            (digest_date, content, now),
        )
        return cur.lastrowid


def list_digests(limit: int = 30):
    with conn() as c:
        return [dict(r) for r in c.execute(
            "SELECT id, digest_date, created_at FROM digest_history ORDER BY digest_date DESC, id DESC LIMIT ?",
            (limit,),
        ).fetchall()]


def get_digest(digest_id: int):
    with conn() as c:
        row = c.execute("SELECT * FROM digest_history WHERE id=?", (digest_id,)).fetchone()
        return dict(row) if row else None
