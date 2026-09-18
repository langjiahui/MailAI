"""草稿箱与发件记录（含附件解码）。"""
import json
from datetime import datetime

from .core import conn
from .emails import get_email
from .trash import queue_trash


def save_draft(data: dict, draft_id: int | None = None) -> int:
    now = datetime.now().isoformat(timespec="seconds")
    fields = ("to_addr", "cc_addr", "bcc_addr", "subject", "body_html", "attachments_json",
              "reply_to_email_id", "mode", "in_reply_to", "references_header", "source_draft_email_id")
    data = dict(data)
    data["references_header"] = data.get("references", "")
    data["attachments_json"] = json.dumps(data.get("attachments") or [], ensure_ascii=False)
    values = [data.get(k) for k in fields]
    with conn() as c:
        if draft_id:
            c.execute(
                "UPDATE drafts SET to_addr=?,cc_addr=?,bcc_addr=?,subject=?,body_html=?,attachments_json=?,"
                "reply_to_email_id=?,mode=?,in_reply_to=?,references_header=?,source_draft_email_id=?,updated_at=? WHERE id=?",
                (*values, now, draft_id),
            )
            if c.execute("SELECT changes() AS n").fetchone()["n"]:
                return draft_id
        cur = c.execute(
            "INSERT INTO drafts(to_addr,cc_addr,bcc_addr,subject,body_html,attachments_json,reply_to_email_id,mode,in_reply_to,references_header,source_draft_email_id,created_at,updated_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", (*values, now, now),
        )
        return cur.lastrowid


def list_drafts():
    with conn() as c:
        rows = [dict(r) for r in c.execute(
            "SELECT id,to_addr,cc_addr,bcc_addr,subject,substr(body_html,1,1000) AS body_html,"
            "attachments_json,reply_to_email_id,mode,in_reply_to,references_header,"
            "source_draft_email_id,created_at,updated_at FROM drafts ORDER BY updated_at DESC"
        ).fetchall()]
    for row in rows:
        row["references"] = row.get("references_header") or ""
        try: attachments = json.loads(row.pop("attachments_json") or "[]")
        except json.JSONDecodeError: row["attachments"] = []
        else:
            row["attachments"] = [{k: v for k, v in item.items() if k != "data_base64"}
                                  for item in attachments if isinstance(item, dict)]
    return rows


def get_draft(draft_id: int):
    with conn() as c:
        row = c.execute("SELECT * FROM drafts WHERE id=?", (draft_id,)).fetchone()
        result = dict(row) if row else None
    if result:
        result["references"] = result.get("references_header") or ""
        try: result["attachments"] = json.loads(result.get("attachments_json") or "[]")
        except json.JSONDecodeError: result["attachments"] = []
    return result


def complete_sent_draft(draft_id):
    draft = get_draft(draft_id) if draft_id else None
    if not draft:
        return
    source_id = draft.get('source_draft_email_id')
    source = get_email(source_id) if source_id else None
    if source and source.get('status') == 'draft':
        queue_trash([source_id], delay_seconds=0)
    delete_draft(draft_id)


def delete_draft(draft_id: int):
    with conn() as c:
        c.execute("DELETE FROM drafts WHERE id=?", (draft_id,))


def create_sent_message(data: dict) -> int:
    now = datetime.now().isoformat(timespec="seconds")
    with conn() as c:
        cur = c.execute(
            "INSERT INTO sent_messages(message_id,from_addr,to_addr,cc_addr,bcc_addr,subject,body_html,attachments_json,status,created_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?)",
            (data.get("message_id"), data.get("from_addr"), data.get("to_addr"),
             data.get("cc_addr"), data.get("bcc_addr"), data.get("subject"),
             data.get("body_html"), json.dumps(data.get("attachments") or [], ensure_ascii=False), "sending", now),
        )
        record_id = cur.lastrowid
        from ..outbox import current_send_token
        if current_send_token.get():
            c.execute('UPDATE outbox SET result=? WHERE token=?', (json.dumps({'sent_record_id':record_id}), current_send_token.get()))
        return record_id


def finish_sent_message(record_id: int, *, ok: bool, error: str = "",
                        smtp_response: str = "", sent_folder: str = "", message_id: str = ""):
    with conn() as c:
        c.execute(
            "UPDATE sent_messages SET status=?,error=?,smtp_response=?,sent_folder=?,sent_at=?,"
            "message_id=COALESCE(NULLIF(?,''),message_id) WHERE id=?",
            ("sent" if ok else "failed", error, smtp_response, sent_folder,
             datetime.now().isoformat(timespec="seconds") if ok else None, message_id, record_id),
        )


def list_sent_messages(limit: int = 500):
    with conn() as c:
        rows = [dict(r) for r in c.execute(
            "SELECT id,message_id,from_addr,to_addr,cc_addr,bcc_addr,subject,"
            "substr(body_html,1,1000) AS body_html,attachments_json,status,error,smtp_response,"
            "sent_folder,created_at,sent_at FROM sent_messages "
            "ORDER BY COALESCE(sent_at,created_at) DESC LIMIT ?", (max(1, min(limit, 500)),)
        ).fetchall()]
    for row in rows:
        try:
            attachments = json.loads(row.pop("attachments_json") or "[]")
        except json.JSONDecodeError:
            row["attachments"] = []
        else:
            row["attachments"] = [{k: v for k, v in item.items() if k != "data_base64"}
                                  for item in attachments if isinstance(item, dict)]
    return rows


def get_sent_message(record_id: int):
    with conn() as c:
        row = c.execute("SELECT * FROM sent_messages WHERE id=?", (record_id,)).fetchone()
        result = dict(row) if row else None
    if result:
        try:
            result["attachments"] = json.loads(result.get("attachments_json") or "[]")
        except json.JSONDecodeError:
            result["attachments"] = []
    return result


def get_sent_attachment(record_id: int, index: int, *, draft=False):
    """Decode an attachment from this account's persisted outgoing message."""
    import base64
    import binascii
    row = get_draft(record_id) if draft else get_sent_message(record_id)
    if not row or index < 0 or index >= len(row['attachments']):
        return None
    item = row['attachments'][index]
    if not isinstance(item, dict) or 'data_base64' not in item:
        return None
    try:
        payload = base64.b64decode(item['data_base64'], validate=True)
    except (ValueError, TypeError, binascii.Error):
        return None
    return {'name': str(item.get('filename') or item.get('name') or '附件'),
            'content_type': item.get('content_type') or 'application/octet-stream',
            'payload': payload, 'size': len(payload)}
