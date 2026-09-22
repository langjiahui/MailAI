"""邮件读取：列表、搜索、详情、内嵌资源与附件。"""
import logging
import os
import re

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from ... import db, pipeline, profiles, system_settings, threads
from ...parser import extract_attachment, extract_inline_resource, extract_rich_body, cc_from_raw_path
from ...security import campaigns, evidence, policy
from ..helpers import (annotate_list_identities, campaign_groups,
                       resolved_contact_name)

log = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/emails")
def api_emails(status: str | None = None, verdict: str | None = None, days: int = 7,
               folder: str | None = None, offset: int = 0):
    emails = db.list_emails(status=status, verdict=verdict, days=days, folder=folder,
                            offset=offset, list_view=True)
    annotate_list_identities(emails)
    for e in emails:  # 列表页不返回全文
        if status == "trash" and e.get("pending_action"):
            e["status"] = "trash"
        e.pop("body_text", None)
        e.pop("body_html", None)
    return emails


@router.get("/api/mailbox/revision")
def api_mailbox_revision():
    """Lightweight browser heartbeat used to reveal background-delivered mail."""
    import sqlite3
    revisions = []
    for account_id, account in system_settings._load_registry().get('accounts', {}).items():
        if not account.get('visible', True) or not os.path.isfile(account.get('db_path', '')):
            continue
        try:
            with system_settings._sqlite_connection(account['db_path']) as c:
                row = c.execute('SELECT COUNT(*),COALESCE(MAX(id),0) FROM emails WHERE remote_missing=0').fetchone()
                seq = c.execute('SELECT value FROM mailbox_sequence WHERE id=1').fetchone()[0]
            revisions.append(f'{account_id}:{row[0]}:{row[1]}:{seq}')
        except sqlite3.Error:
            continue
    return {**db.mailbox_revision(), 'revision': '|'.join(sorted(revisions)) or db.mailbox_revision()['revision'], "syncing": pipeline.is_fetch_running()}


# 必须在 /api/emails/{email_id} 之前注册，否则 search 会被当作数字 id 匹配。
@router.get("/api/emails/search")
def api_search_emails(q: str = "", limit: int = 1000, offset: int = 0, folder: str = ""):
    emails = db.search_emails([part for part in re.split(r"\s+", q.strip()) if part],
                              max(1, min(limit, 1000)), offset=offset, list_view=True, folder=folder)
    annotate_list_identities(emails)
    for item in emails:
        item.pop("body_text", None)
    return emails


@router.get("/api/attachments")
def api_attachments(limit: int = 500):
    return db.list_attachments(max(1, min(limit, 1000)))


@router.get("/api/emails/{email_id}")
def api_email_detail(email_id: int):
    row = db.get_email(email_id)
    if not row:
        raise HTTPException(404, "邮件不存在")
    if row.get("cc_addr") is None:
        recovered_cc = cc_from_raw_path(row.get("raw_path"))
        if recovered_cc is not None:
            with db.conn() as connection:
                connection.execute('UPDATE emails SET cc_addr=? WHERE id=? AND cc_addr IS NULL', (recovered_cc, email_id))
            row["cc_addr"] = recovered_cc
    names = db.contact_display_names([row.get("from_addr"), row.get("to_addr"), row.get("cc_addr")])
    resolved_name, _source = resolved_contact_name(row.get("from_addr"), row.get("from_name"), names)
    if resolved_name:
        row["from_name"] = resolved_name
    row["recipient_names"] = {address: item["name"] for address, item in names.items() if item.get("name")}
    row["findings"] = policy.present_findings(row.get("findings"))
    for attachment in row.get("attachment_analysis") or []:
        if isinstance(attachment, dict):
            attachment["findings"] = policy.present_findings(attachment.get("findings"))
    row["thread_context"] = threads.build_thread_context(row)
    row["sender_profile"] = profiles.get_profile_for_display(row.get("from_addr", ""))
    row["evidence_summary"] = evidence.summarize(row.get("findings"), row.get("score", 0))
    row["campaign"] = campaigns.for_email(email_id, campaign_groups(90)) if (
        row.get("verdict") in ("phishing", "suspicious") or int(row.get("score") or 0) >= 30
    ) else None
    row["body_html"] = row.get("body_html") or extract_rich_body(row.get("raw_path"), email_id)
    row["has_rich_body"] = bool(row["body_html"])
    row["has_remote_images"] = bool(re.search(r'<img[^>]+src=["\']https?://', row["body_html"], re.I))
    return row


@router.get("/api/emails/{email_id}/progress")
def api_conversation_progress(email_id: int):
    from ...conversation_progress import build
    try:
        return build(email_id)
    except ValueError as error:
        raise HTTPException(404, str(error)) from error


@router.get("/api/emails/{email_id}/inline/{inline_index}")
def api_inline_resource(email_id: int, inline_index: int):
    row = db.get_email(email_id)
    if not row:
        raise HTTPException(404, "邮件不存在")
    item = extract_inline_resource(row.get("raw_path"), inline_index)
    if not item:
        raise HTTPException(404, "内嵌资源不存在")
    return Response(content=item["payload"], media_type=item["content_type"], headers={
        "Cache-Control": "private, max-age=3600", "Content-Length": str(item["size"]),
    })


@router.get("/api/emails/{email_id}/attachments/{att_index}/preview")
def api_preview_attachment(email_id: int, att_index: int, page: int = 0):
    from ...attachment_preview import preview_attachment
    row = db.get_email(email_id)
    if not row:
        raise HTTPException(404, "邮件不存在")
    att = extract_attachment(row.get("raw_path"), att_index)
    if not att:
        raise HTTPException(404, "附件不存在或已删除")
    return preview_attachment(att, page=page)


@router.get("/api/emails/{email_id}/attachments/{att_index}")
def api_download_attachment(email_id: int, att_index: int):
    row = db.get_email(email_id)
    if not row:
        raise HTTPException(404, "邮件不存在")
    att = extract_attachment(row.get("raw_path"), att_index)
    if not att:
        raise HTTPException(404, "附件不存在或已删除")
    from urllib.parse import quote
    filename = quote(att["name"])
    return Response(
        content=att["payload"],
        media_type=att["content_type"],
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{filename}",
            "Content-Length": str(att["size"]),
        },
    )


@router.get("/api/senders/{sender}")
def api_sender_profile(sender: str):
    return profiles.get_profile_for_display(sender)
