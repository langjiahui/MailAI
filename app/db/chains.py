"""URL 跳转链溯源记录。"""
import json
from datetime import datetime

from .core import conn


def save_url_chain(email_id: int, original_url: str, chain: list, final_url: str | None,
                   final_domain: str | None, final_ip: str | None, landing_status: str):
    now = datetime.now().isoformat(timespec="seconds")
    with conn() as c:
        c.execute(
            "INSERT INTO url_chains(email_id, original_url, chain, final_url, final_domain, final_ip, landing_status, created_at) "
            "VALUES(?,?,?,?,?,?,?,?)",
            (email_id, original_url, json.dumps(chain, ensure_ascii=False), final_url,
             final_domain, final_ip, landing_status, now),
        )


def get_url_chains(email_id: int):
    with conn() as c:
        rows = [dict(r) for r in c.execute(
            "SELECT * FROM url_chains WHERE email_id=? ORDER BY id", (email_id,)
        ).fetchall()]
        for r in rows:
            try:
                r["chain"] = json.loads(r.get("chain") or "[]")
            except (TypeError, json.JSONDecodeError):
                r["chain"] = []
        return rows
