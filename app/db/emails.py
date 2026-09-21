"""emails 表的读写：入库、列表、检索、状态与标记。"""
import json
from datetime import datetime

from .core import conn


def upsert_email(e: dict) -> int:
    fields = (
        "uid", "folder", "message_id", "in_reply_to", "references_header", "thread_id",
        "thread_summary", "sender_profile_id", "subject", "from_addr", "from_name", "to_addr", "cc_addr", "recipient_names",
        "date", "snippet", "body_text", "body_html", "urls", "attachments", "attachment_analysis", "auth",
        "score", "verdict", "findings", "spam_score", "category", "priority", "summary",
        "llm_phishing", "llm_reasons", "status", "reviewed", "feedback", "feedback_note",
        "url_chain", "final_landing_domain", "final_landing_ip", "review_source",
        "recommended_status", "action_mode", "action_taken", "action_reason",
        "raw_path", "created_at", "arrival_kind", "processing_complete",
    )
    e = dict(e)
    e.setdefault("folder", "INBOX")
    supplied = set(e)
    for k in ("urls", "attachments", "attachment_analysis", "auth", "findings", "llm_reasons", "url_chain", "imap_flags", "recipient_names"):
        if k in e and not isinstance(e.get(k), str):
            object_default = k in {"auth", "recipient_names"}
            e[k] = json.dumps(e.get(k) or ({} if object_default else []), ensure_ascii=False)
    e.setdefault("created_at", datetime.now().isoformat(timespec="seconds"))
    fields = tuple(k for k in fields if k in e)
    values = [e.get(k) for k in fields]
    placeholders = ",".join("?" for _ in fields)
    # REPLACE deletes the old row and assigns a new id, breaking source links.
    # Update only supplied data, retaining read/star state and original creation time.
    updates = [k for k in fields if k in supplied and k not in ("uid", "folder", "created_at")]
    conflict = ("DO UPDATE SET " + ",".join(f"{k}=excluded.{k}" for k in updates)) if updates else "DO NOTHING"
    with conn() as c:
        # Portable imports deliberately discard source-server UIDs.  On the
        # first target-server sync, bind an archived copy to its new UID by the
        # stable Message-ID before the normal upsert, preserving local links.
        message_id = str(e.get("message_id") or "").strip()
        if message_id:
            occupied = c.execute("SELECT id FROM emails WHERE folder=? AND uid=?",
                                 (e.get("folder", "INBOX"), e["uid"])).fetchone()
            imported = c.execute(
                "SELECT id FROM emails WHERE is_local_archive=1 AND message_id=? AND folder=? ORDER BY id LIMIT 1",
                (message_id, e.get("folder", "INBOX")),
            ).fetchone()
            if imported and not occupied:
                c.execute("UPDATE emails SET folder=?,uid=?,is_local_archive=0,remote_missing=0 WHERE id=?",
                          (e.get("folder", "INBOX"), e["uid"], imported["id"]))
        c.execute(
            f"INSERT INTO emails({','.join(fields)}) VALUES({placeholders}) ON CONFLICT(folder,uid) {conflict}",
            values,
        )
        row = c.execute(
            "SELECT id FROM emails WHERE folder=? AND uid=?",
            (e.get("folder", "INBOX"), e["uid"]),
        ).fetchone()
        return row["id"]


def already_processed(folder: str, uid: int) -> bool:
    with conn() as c:
        return c.execute(
            "SELECT 1 FROM emails WHERE folder=? AND uid=? AND processing_complete=1", (folder, uid)
        ).fetchone() is not None


def finish_email_processing(email_id: int):
    with conn() as c:
        c.execute("UPDATE emails SET processing_complete=1 WHERE id=?", (email_id,))


def claim_mail_notification(email_id: int) -> bool:
    with conn() as c:
        return c.execute(
            "UPDATE emails SET notification_sent=1 WHERE id=? AND notification_sent=0 "
            "AND processing_complete=1 AND arrival_kind='new' AND remote_missing=0",
            (email_id,),
        ).rowcount == 1


def count_history_imported() -> int:
    """Count durable history rows so paged imports share one global AI window."""
    with conn() as c:
        row = c.execute(
            "SELECT COUNT(*) AS n FROM emails WHERE arrival_kind='history'"
        ).fetchone()
        return int(row["n"] or 0)


def folder_uids(folder: str) -> set[int]:
    """Return locally known UIDs for incremental server-folder synchronization."""
    with conn() as c:
        return {int(row["uid"]) for row in c.execute(
            "SELECT uid FROM emails WHERE folder=? AND uid>0 AND is_local_archive=0", (folder,)
        ).fetchall()}


def _decode_rows(rows):
    out = []
    for r in rows:
        d = dict(r)
        for k in ("urls", "attachments", "attachment_analysis", "findings", "llm_reasons", "url_chain", "imap_flags", "recipient_names"):
            try:
                d[k] = json.loads(d.get(k) or "[]")
            except (TypeError, json.JSONDecodeError):
                d[k] = []
        try:
            d["auth"] = json.loads(d.get("auth") or "{}")
        except (TypeError, json.JSONDecodeError):
            d["auth"] = {}
        out.append(d)
    return out


EMAIL_LIST_COLUMNS = (
    'id,uid,folder,message_id,thread_id,subject,from_addr,from_name,to_addr,date,'
    'snippet,summary,attachments,score,verdict,status,category,priority,reviewed,'
    'feedback,recommended_status,is_read,is_starred,is_favorite,is_local_archive,created_at,arrival_kind,pending_action,pending_error'
)


def list_emails(status=None, verdict=None, days=7, limit=1000, folder=None, offset=0,
                metadata_only=False, list_view=False):
    # Historical mail may be imported today. Lists and reports must follow the
    # message's real received date, not the local indexing timestamp.
    columns = ('id,thread_id,status,priority,from_addr,subject,date,verdict,score,feedback,reviewed,arrival_kind,created_at,pending_action,processing_complete'
               if metadata_only else EMAIL_LIST_COLUMNS if list_view else '*')
    visibility = "(pending_action IN ('trash','trash_copying','trash_copied','trash_locating') OR (remote_missing=0 AND status='trash'))" if status == 'trash' else 'remote_missing=0'
    sql = f"SELECT {columns} FROM emails WHERE {visibility} AND datetime(COALESCE(NULLIF(date,''),created_at)) >= datetime('now','localtime', ?)"
    args = [f"-{days} days"]
    if status == "favorites":
        sql += " AND is_favorite=1"
    elif status and status != "trash":
        sql += " AND status=?"
        args.append(status)
    if verdict:
        sql += " AND verdict=?"
        args.append(verdict)
    if folder:
        sql += " AND folder=?"
        args.append(folder)
    sql += " ORDER BY date DESC, id DESC LIMIT ? OFFSET ?"
    args.extend([limit, max(0, offset)])
    with conn() as c:
        rows = c.execute(sql, args).fetchall()
        return [dict(row) for row in rows] if metadata_only else _decode_rows(rows)


def iter_emails(batch_size=25):
    """Keyset batches for startup repair; close each cursor before any writes."""
    with conn() as c:
        ceiling = c.execute('SELECT COALESCE(MAX(id),0) FROM emails').fetchone()[0]
    cursor = 0
    while cursor < ceiling:
        with conn() as c:
            rows = _decode_rows(c.execute(
                'SELECT * FROM emails WHERE remote_missing=0 AND id>? AND id<=? ORDER BY id LIMIT ?',
                (cursor, ceiling, max(1, min(batch_size, 100))),
            ).fetchall())
        if not rows:
            return
        cursor = rows[-1]['id']
        yield from rows


def notification_candidates(after_id: int):
    """Stream only new notification metadata, never historical bodies/attachments."""
    with conn() as c:
        rows = c.execute(
            "SELECT id,thread_id,status,priority,from_addr,verdict,score,feedback,reviewed "
            "FROM emails WHERE id>? AND remote_missing=0 AND "
            "datetime(COALESCE(NULLIF(date,''),created_at)) >= datetime('now','localtime','-2 days')",
            (after_id,),
        )
        for row in rows:
            yield dict(row)


def mailbox_revision() -> dict:
    """Return a cheap token that changes when the visible local mailbox changes."""
    with conn() as c:
        row = c.execute(
            "SELECT COUNT(*) AS total, COALESCE(MAX(id),0) AS latest_id "
            "FROM emails WHERE remote_missing=0"
        ).fetchone()
        sequence = c.execute('SELECT value FROM mailbox_sequence WHERE id=1').fetchone()[0]
    total = int(row["total"] or 0)
    latest_id = int(row["latest_id"] or 0)
    return {"revision": f"{latest_id}:{total}:{sequence}", "latest_id": latest_id, "total": total}


def search_emails(terms: list[str], limit: int = 200, offset: int = 0,
                  list_view: bool = False, folder: str = "") -> list[dict]:
    """在完整本地邮箱上执行参数化全文模糊检索，不受列表页 2000 封限制。"""
    cleaned = [str(term).strip().lower()[:80] for term in terms if str(term).strip()][:12]
    if not cleaned:
        return list_emails(days=9999, limit=limit, offset=offset, list_view=list_view)
    columns = EMAIL_LIST_COLUMNS if list_view else '*'
    with conn() as c:
        from ..mail_search import predicate
        condition, args = predicate(c, cleaned)
        if folder:
            condition += ' AND folder=?'
            args.append(folder)
        sql = f"SELECT {columns} FROM emails WHERE remote_missing=0 AND {condition} ORDER BY date DESC,id DESC LIMIT ? OFFSET ?"
        args.extend([max(1, min(limit, 1000)), max(0, offset)])
        return _decode_rows(c.execute(sql, args).fetchall())


def list_correspondence_emails(address: str, limit: int = 50) -> list[dict]:
    """Return locally stored mail exchanged with one exact email address."""
    target = str(address or "").strip().casefold()
    if not target:
        return []
    with conn() as c:
        candidates = _decode_rows(c.execute(
            "SELECT * FROM emails WHERE remote_missing=0 AND "
            "(lower(coalesce(from_addr,''))=? OR lower(coalesce(to_addr,'')) LIKE ?) "
            "ORDER BY date DESC,id DESC LIMIT ?",
            (target, f"%{target}%", max(20, min(int(limit) * 4, 400))),
        ).fetchall())
    import re
    address_pattern = re.compile(r"[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}", re.I)
    result = []
    for row in candidates:
        sender = str(row.get("from_addr") or "").strip().casefold()
        recipients = {value.casefold() for value in address_pattern.findall(str(row.get("to_addr") or ""))}
        if sender == target or target in recipients:
            result.append(row)
        if len(result) >= max(1, min(int(limit), 100)):
            break
    return result


def list_attachments(limit: int = 500) -> list[dict]:
    """汇总本地邮件附件元数据，供附件中心检索与下载。"""
    with conn() as c:
        rows = _decode_rows(c.execute(
            "SELECT id,subject,from_addr,date,attachments,score,verdict,feedback,reviewed FROM emails "
            "WHERE remote_missing=0 AND attachments IS NOT NULL AND attachments NOT IN ('','[]') ORDER BY date DESC LIMIT 2000"
        ).fetchall())
    result = []
    for row in rows:
        for index, item in enumerate(row.get("attachments") or []):
            result.append({"email_id": row["id"], "index": index,
                           "name": item.get("name") or "未命名附件",
                           "content_type": item.get("content_type") or "application/octet-stream",
                           "size": item.get("size") or 0, "subject": row.get("subject") or "",
                           "from_addr": row.get("from_addr") or "", "date": row.get("date") or "",
                           "score": row.get("score") or 0, "verdict": row.get("verdict") or "clean",
                           "feedback": row.get("feedback"), "reviewed": row.get("reviewed")})
            if len(result) >= limit:
                return result
    return result


def list_inline_attachment_candidates() -> list[dict]:
    """列出可能混入签名图片的历史邮件，供一次性元数据修复。"""
    patterns = ("%image/%", "%.jpg%", "%.jpeg%", "%.png%", "%.gif%", "%.webp%")
    with conn() as c:
        rows = c.execute(
            "SELECT id,raw_path,attachments FROM emails WHERE remote_missing=0 "
            "AND raw_path IS NOT NULL AND raw_path<>'' AND attachments IS NOT NULL "
            "AND attachments NOT IN ('','[]') AND (" +
            " OR ".join("lower(attachments) LIKE ?" for _ in patterns) + ")",
            patterns,
        ).fetchall()
    return _decode_rows(rows)


def update_attachment_metadata(email_id: int, attachments: list[dict]):
    with conn() as c:
        c.execute(
            "UPDATE emails SET attachments=? WHERE id=?",
            (json.dumps(attachments or [], ensure_ascii=False), email_id),
        )


def get_email(email_id: int):
    with conn() as c:
        rows = _decode_rows(c.execute("SELECT * FROM emails WHERE id=?", (email_id,)).fetchall())
    return rows[0] if rows else None


def get_email_by_folder_uid(folder: str, uid: int):
    with conn() as c:
        rows = _decode_rows(c.execute(
            "SELECT * FROM emails WHERE folder=? AND uid=?", (folder, uid)
        ).fetchall())
    return rows[0] if rows else None


def list_special_folder_emails(status: str, limit: int = 1000):
    """Historical server-side Sent/Drafts imported from IMAP folders."""
    if status not in ("sent", "draft"):
        return []
    with conn() as c:
        return _decode_rows(c.execute(
            "SELECT * FROM emails WHERE remote_missing=0 AND status=? ORDER BY date DESC,id DESC LIMIT ?",
            (status, max(1, min(limit, 5000))),
        ).fetchall())


def set_status(email_id: int, status: str, folder: str | None = None):
    with conn() as c:
        if folder:
            c.execute("UPDATE emails SET status=?, folder=? WHERE id=?", (status, folder, email_id))
        else:
            c.execute("UPDATE emails SET status=? WHERE id=?", (status, email_id))


def reconcile_folder(folder: str, present_uids: list[int]) -> int:
    """Hide messages removed elsewhere while retaining local evidence and todo links."""
    uids = list(dict.fromkeys(int(uid) for uid in present_uids))
    with conn() as c:
        before = c.execute(
            "SELECT COUNT(*) AS n FROM emails WHERE folder=? AND remote_missing=0", (folder,)
        ).fetchone()["n"]
        c.execute("UPDATE emails SET remote_missing=1 WHERE folder=? AND is_local_archive=0", (folder,))
        c.executemany("UPDATE emails SET remote_missing=0 WHERE folder=? AND uid=? AND COALESCE(pending_action,'')=''",
                      ((folder, uid) for uid in uids))
        after = c.execute(
            "SELECT COUNT(*) AS n FROM emails WHERE folder=? AND remote_missing=0", (folder,)
        ).fetchone()["n"]
    return max(0, before - after)


def set_remote_missing(email_id: int, value: bool = True):
    """Hide a server-removed row while preserving its local evidence and audit links."""
    with conn() as c:
        c.execute("UPDATE emails SET remote_missing=? WHERE id=? AND is_local_archive=0", (int(value), email_id))


def set_mail_state(email_id: int, *, is_read: bool | None = None,
                   is_starred: bool | None = None, folder: str | None = None,
                   uid: int | None = None):
    """更新邮件客户端状态；只修改明确传入的字段。"""
    sets, args = [], []
    for column, value in (("is_read", is_read), ("is_starred", is_starred)):
        if value is not None:
            sets.append(f"{column}=?")
            args.append(1 if value else 0)
    if folder is not None:
        sets.append("folder=?")
        args.append(folder)
    if uid is not None:
        sets.append("uid=?")
        args.append(uid)
    if not sets:
        return
    args.append(email_id)
    with conn() as c:
        c.execute(f"UPDATE emails SET {', '.join(sets)} WHERE id=?", args)


def sync_mail_flags(email_id: int, *, is_read: bool, is_starred: bool):
    """Refresh server flags without overwriting a newer queued local read choice."""
    with conn() as c:
        c.execute(
            "UPDATE emails SET is_read=CASE WHEN EXISTS(SELECT 1 FROM seen_sync_jobs "
            "WHERE email_id=?) THEN is_read ELSE ? END,is_starred=? WHERE id=? AND is_local_archive=0",
            (int(email_id), int(bool(is_read)), int(bool(is_starred)), int(email_id)),
        )


def set_reviewed(email_id: int):
    with conn() as c:
        c.execute("UPDATE emails SET reviewed=1 WHERE id=?", (email_id,))


def update_llm(email_id: int, category=None, priority=None, summary=None,
               llm_phishing=None, llm_reasons=None):
    sets, args = [], []
    for col, val in (("category", category), ("priority", priority), ("summary", summary),
                     ("llm_phishing", llm_phishing)):
        if val is not None:
            sets.append(f"{col}=?")
            args.append(val)
    if llm_reasons is not None:
        sets.append("llm_reasons=?")
        args.append(json.dumps(llm_reasons, ensure_ascii=False))
    if not sets:
        return
    args.append(email_id)
    with conn() as c:
        c.execute(f"UPDATE emails SET {', '.join(sets)} WHERE id=?", args)


def frequent_sender_domains(limit=30):
    """历史邮件里的高频发件域名，用于仿冒检测白名单。"""
    with conn() as c:
        rows = c.execute(
            "SELECT lower(substr(from_addr, instr(from_addr,'@')+1)) AS d, COUNT(*) AS n "
            "FROM emails WHERE remote_missing=0 AND from_addr LIKE '%@%' "
            "GROUP BY d ORDER BY n DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [r["d"] for r in rows if r["d"]]


def record_feedback(email_id: int, feedback: str, note: str = ""):
    with conn() as c:
        c.execute("UPDATE emails SET feedback=?, feedback_note=? WHERE id=?",
                  (feedback, note, email_id))
