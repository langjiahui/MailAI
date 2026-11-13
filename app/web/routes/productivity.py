"""Account-scoped advanced search, workflow, templates and local office tools."""

import json
import sqlite3
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from ... import db, productivity

router = APIRouter()


def checked(action, *args, **kwargs):
    try:
        result = action(*args, **kwargs)
        from ...companion_growth import safe_record, _now
        safe_record('tool', key=f"{_now().date()}:productivity:{getattr(action, '__name__', 'tool')}")
        return result
    except (ValueError, TypeError) as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post('/api/productivity/search/interpret')
def interpret_search(payload: dict):
    from ...search_query import interpret_query
    try:
        return interpret_query(payload.get('query') or '')
    except (ValueError, TypeError) as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get('/api/productivity/search/interpret')
def interpret_search_text(q: str = ''):
    return interpret_search({'query':q})


@router.post("/api/productivity/search")
def search(payload: dict):
    criteria = payload.get("criteria") or {}
    try:
        criteria = productivity.normalize_search_criteria(criteria)
        offset = max(0, int(payload.get('offset', 0)))
        limit = max(1, min(int(payload.get('limit', 50)), 200))
    except (ValueError, TypeError) as exc:
        raise HTTPException(400, str(exc)) from exc
    if payload.get("all_accounts"):
        import os
        from ... import system_settings
        from ...account_context import use

        if offset > 10000:
            raise HTTPException(400, "请缩小搜索范围")
        items, failed, more = [], [], False
        for account_id, account in (
            system_settings._load_registry().get("accounts", {}).items()
        ):
            if not account.get("visible", True) or not os.path.isfile(
                account.get("db_path", "")
            ):
                continue
            try:
                with use(
                    {
                        "ACCOUNT_ID": account_id,
                        "DB_PATH": account["db_path"],
                        "RAW_DIR": account["raw_dir"],
                        "IMAP_USER": account["user"],
                    }
                ):
                    db.init_db()
                    # Collect enough rows per account before global ordering.
                    account_more = False
                    for start in range(0, offset + limit + 1, 200):
                        result = productivity.search(
                            criteria,
                            offset=start,
                            limit=min(200, offset + limit + 1 - start),
                        )
                        items.extend(
                            {
                                **row,
                                "account_id": account_id,
                                "account_user": account["user"],
                            }
                            for row in result["items"]
                        )
                        account_more = result["has_more"]
                        if not result["has_more"]:
                            break
                    more |= account_more
            except (ValueError, OSError, sqlite3.Error):
                failed.append(account["user"])
        items.sort(
            key=lambda r: (r["date"] or "", r["id"], r["kind"], r["account_id"]),
            reverse=True,
        )
        return {
            "items": items[offset : offset + limit],
            "has_more": len(items) > offset + limit or more,
            "failed_accounts": failed,
            "scope": "所有可见账号，仅已同步到本机的邮件",
            "criteria": criteria,
        }
    return checked(
        productivity.search,
        criteria,
        offset=offset,
        limit=limit,
        mailbox_rows=bool(payload.get('mailbox_rows')) and criteria.get('mailbox') in {'sent','drafts'},
    )


@router.get("/api/productivity/workflow")
def workflow():
    productivity.refresh_workflow()
    with db.conn() as c:
        rows = [
            dict(r)
            for r in c.execute(
                "SELECT id,handle_state,snoozed_until,followup_at,focus_override FROM emails WHERE remote_missing=0 AND (handle_state<>'unhandled' OR focus_override<>'')"
            )
        ]
        senders = [
            dict(r) for r in c.execute("SELECT address,choice FROM focus_senders")
        ]
        choices = {r["address"] for r in senders}
        senders.extend(
            {"address": r[0].casefold(), "choice": "focus"}
            for r in c.execute(
                "SELECT email FROM contacts WHERE favorite=1 AND hidden=0"
            )
            if r[0].casefold() not in choices
        )
    return {"items": rows, "senders": senders}


@router.patch("/api/productivity/workflow/{email_id}")
def save_workflow(email_id: int, payload: dict):
    return checked(
        productivity.set_workflow,
        email_id,
        str(payload.get("state") or ""),
        payload.get("at") or "",
        payload.get("followup_at") or "",
    )


@router.patch("/api/productivity/focus/{email_id}")
def focus(email_id: int, payload: dict):
    choice = payload.get("choice")
    if choice not in ("focus", "other", ""):
        raise HTTPException(400, "请选择重点、其他或恢复自动判断")
    row = db.get_email(email_id)
    if not row or row.get("remote_missing"):
        raise HTTPException(404, "邮件不存在")
    with db.conn() as c:
        c.execute("UPDATE emails SET focus_override=? WHERE id=?", (choice, email_id))
        if payload.get("sender"):
            if choice:
                c.execute(
                    "INSERT OR REPLACE INTO focus_senders VALUES(?,?)",
                    (str(row.get("from_addr") or "").casefold(), choice),
                )
            else:
                c.execute(
                    "DELETE FROM focus_senders WHERE address=?",
                    (str(row.get("from_addr") or "").casefold(),),
                )
    return {"ok": True}


@router.get("/api/productivity/{kind}")
def named_items(kind: str):
    if kind not in ("templates", "searches", "snippets"):
        raise HTTPException(404, "没有此功能")
    return productivity.named_items(kind)


@router.post("/api/productivity/{kind}")
def save_named(kind: str, payload: dict):
    if kind not in ("templates", "searches", "snippets"):
        raise HTTPException(404, "没有此功能")
    return checked(productivity.save_named, kind, payload)


@router.delete("/api/productivity/{kind}/{ident}")
def delete_named(kind: str, ident: int):
    if kind not in ("templates", "searches", "snippets"):
        raise HTTPException(404, "没有此功能")
    table = {"templates":"mail_templates","snippets":"mail_snippets","searches":"saved_mail_searches"}[kind]
    with db.conn() as c:
        c.execute(f"DELETE FROM {table} WHERE id=?", (ident,))
    return {"ok": True}


@router.post("/api/productivity/contacts/import")
def import_contacts(payload: dict):
    return checked(
        productivity.import_contacts,
        str(payload.get("text") or ""),
        payload.get("format", "csv"),
        bool(payload.get("apply")),
        bool(payload.get("overwrite")),
    )


@router.get("/api/productivity/contacts/export")
def export_contacts(format: str = "csv"):
    text = checked(productivity.export_contacts, format)
    return Response(
        text,
        media_type="text/csv; charset=utf-8"
        if format == "csv"
        else "text/vcard; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="contacts.{"csv" if format == "csv" else "vcf"}"',
            "Cache-Control": "no-store",
        },
    )


@router.post("/api/productivity/attachments/{email_id}/{index}/index")
def index_attachment(email_id: int, index: int):
    from ...attachment_text import extract_local, save_cache

    item = checked(extract_local, email_id, index)
    if item.get("image"):
        raise HTTPException(400, "图片暂不建立文字索引，可使用现有图片分析")
    save_cache(email_id, index, item["digest"], item["name"], item["text"], item["note"])
    return {"ok": True, "name": item["name"], "note": item["note"]}


@router.post('/api/productivity/attachments/{email_id}/{index}/search')
def search_file_contents(email_id: int, index: int, payload: dict):
    from ...attachment_text import extract_local, search_excerpts, limited_text
    query = payload.get('query')
    checked(search_excerpts, '', query)  # Validate before launching a parser.
    item = checked(extract_local, email_id, index, cache=True)
    return {**checked(search_excerpts, item['text'], query), 'name':item['name'], 'note':item['note'], 'limited':limited_text(item)}


@router.post("/api/productivity/attachments/compare")
def compare_attachments(payload: dict):
    import difflib
    from ...attachment_text import extract_local, limited_text

    refs = payload.get("items")
    if (
        not isinstance(refs, list)
        or len(refs) != 2
        or any(
            not isinstance(r, dict)
            or not isinstance(r.get("email_id"), int)
            or not isinstance(r.get("index"), int)
            or r["index"] < 0
            for r in refs
        )
    ):
        raise HTTPException(400, "请选择两个有效附件")
    if (refs[0]['email_id'], refs[0]['index']) == (refs[1]['email_id'], refs[1]['index']):
        raise HTTPException(400, "请选择两份不同的附件")
    before, after = [checked(extract_local, r["email_id"], r["index"]) for r in refs]
    lines = list(
        __import__("itertools").islice(
            difflib.unified_diff(
                before["text"].splitlines(),
                after["text"].splitlines(),
                fromfile=before["name"],
                tofile=after["name"],
                lineterm="",
            ),
            201,
        )
    )
    return {
        "identical": before["digest"] == after["digest"],
        "text_equal": before["text"] == after["text"],
        "diff": "\n".join(lines[:200]),
        "diff_truncated": len(lines) > 200,
        "limited": limited_text(before) or limited_text(after),
        "notes": [before["note"], after["note"]],
        "scope": "仅比较提取到的文字，最多 200 行差异；图表、格式及截断范围外内容未核对",
    }


@router.get("/api/productivity/attachments/search")
def search_attachments(q: str):
    if not q.strip():
        return {"items": []}
    with db.conn() as c:
        rows = c.execute(
            "SELECT a.email_id,a.attachment_index,a.name,a.note,a.digest,substr(a.body,max(1,instr(lower(a.body),?)-40),180) AS excerpt,e.subject,e.date FROM attachment_text_index a JOIN emails e ON e.id=a.email_id WHERE e.remote_missing=0 AND e.status NOT IN ('trash','quarantine','spam') AND lower(a.body) LIKE ? ESCAPE '\\' ORDER BY e.date DESC LIMIT 100",
            (q[:200].lower(), "%" + productivity._like(q[:200].lower()) + "%"),
        ).fetchall()
    return {
        "items": [dict(r) for r in rows],
        "scope": "仅手动建立索引的附件文字；最多 100 项，解析可能不完整",
    }


@router.get("/api/productivity/attachments/versions")
def attachment_versions(name: str):
    # A name match is only a candidate, never proof of content equivalence.
    if not name or len(name) > 240:
        raise HTTPException(400, "文件名无效")
    with db.conn() as c:
        rows = c.execute(
            "SELECT e.id AS email_id,j.key AS attachment_index,j.value AS attachment,e.subject,e.date FROM emails e,json_each(CASE WHEN json_valid(e.attachments) THEN e.attachments ELSE '[]' END) j WHERE e.remote_missing=0 AND e.status NOT IN ('trash','spam','quarantine') AND lower(coalesce(json_extract(CASE WHEN json_valid(j.value) THEN j.value ELSE '{}' END,'$.name'),json_extract(CASE WHEN json_valid(j.value) THEN j.value ELSE '{}' END,'$.filename')))=? ORDER BY e.date DESC,e.id DESC LIMIT 100",
            (name.lower(),),
        ).fetchall()
    return {
        "items": [{**dict(r), "attachment": json.loads(r["attachment"])} for r in rows],
        "scope": "同名附件候选，按邮件时间排列；最新邮件不保证文件内容最新",
    }


@router.get("/api/productivity/calendar/timeline")
def calendar_timeline(
    days: int = 14,
    include_past_days: int = 7,
    include_done: bool = False,
):
    from ...mail_calendar import timeline

    return checked(timeline, days, include_past_days, include_done)


@router.post("/api/productivity/calendar/events")
def calendar_event_create(payload: dict):
    from ...mail_calendar import create_custom_event

    return checked(create_custom_event, payload)


@router.delete("/api/productivity/calendar/events/{event_id}")
def calendar_event_delete(event_id: int):
    from fastapi import HTTPException
    from ...mail_calendar import delete_custom_event

    if not checked(delete_custom_event, event_id):
        raise HTTPException(status_code=404, detail="日程不存在")
    return {"ok": True}


@router.post("/api/productivity/calendar/export-batch")
def calendar_export_batch(payload: dict):
    from ...mail_calendar import export_batch_ics

    items = payload.get("items") or []
    return Response(
        checked(export_batch_ics, items),
        media_type="text/calendar; charset=utf-8",
        headers={
            "Content-Disposition": 'attachment; filename="schedule.ics"',
            "Cache-Control": "no-store",
        },
    )


@router.get("/api/productivity/calendar/system-calendars")
def calendar_system_calendars():
    from ...mail_calendar import list_macos_calendars

    return checked(list_macos_calendars)


@router.post("/api/productivity/calendar/system-add")
def calendar_system_add(payload: dict):
    from ...mail_calendar import write_macos_calendar

    items = payload.get("items") or []
    calendar_name = str(payload.get("calendar_name") or "")
    return checked(write_macos_calendar, items, calendar_name)


@router.get("/api/productivity/calendar/{email_id}")
def calendar(email_id: int):
    from ...mail_calendar import invitations

    return checked(invitations, email_id)


@router.post("/api/productivity/calendar/export")
def calendar_export(payload: dict):
    from ...mail_calendar import export_event

    return Response(
        checked(export_event, payload),
        media_type="text/calendar; charset=utf-8",
        headers={
            "Content-Disposition": 'attachment; filename="meeting.ics"',
            "Cache-Control": "no-store",
        },
    )


@router.post("/api/productivity/calendar/import")
def calendar_import(payload: dict):
    from ...mail_calendar import parse_ics

    return {"items": checked(parse_ics, str(payload.get("text") or ""))}


@router.post("/api/productivity/calendar/{email_id}/response")
def calendar_response(email_id: int, payload: dict):
    from ...mail_calendar import response_draft

    return checked(
        response_draft,
        email_id,
        str(payload.get("uid") or ""),
        str(payload.get("response") or ""),
    )


@router.get("/api/productivity/evidence/{email_id}")
def evidence(email_id: int):
    from ...mail_evidence import compare

    return checked(compare, email_id)


@router.get("/api/productivity/shares/list")
def list_shares():
    from ...share_storage import list_links

    return list_links()


@router.post("/api/productivity/shares/{ident}/renew")
def renew_share(ident: int, payload: dict):
    from ...share_storage import renew_link

    try:
        return renew_link(ident, payload.get("days", 7))
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except Exception:
        raise HTTPException(
            502, "下载链接未能重新生成，请检查文件是否存在和存储权限；已有记录仍保留"
        )


@router.get('/api/productivity/followups/list')
def sent_followups():
    from ...sent_followups import items
    return items()


@router.post('/api/productivity/followups/{sent_id}')
def schedule_followup(sent_id: int, payload: dict):
    from ...sent_followups import schedule
    try:
        days = int(payload.get('days') or 0)
    except (ValueError, TypeError) as exc:
        raise HTTPException(400, '无效跟进天数') from exc
    return checked(schedule, sent_id, days=days, at=str(payload.get('at') or ''))


@router.patch('/api/productivity/followups/{sent_id}')
def arrange_followup(sent_id:int,payload:dict):
    from ...sent_followups import arrange
    return checked(arrange,sent_id,str(payload.get('at') or ''),bool(payload.get('cancel')))


@router.post('/api/productivity/evidence/{email_id}/ai')
def ai_evidence(email_id:int):
    from ...mail_evidence import semantic_compare
    return checked(semantic_compare,email_id)


@router.get('/api/productivity/triage/subscriptions')
def triage_subscriptions(days: int = 45, min_count: int = 2):
    from ...triage_rules import scan_subscriptions

    return checked(scan_subscriptions, days, min_count)


@router.post('/api/productivity/triage/sender-batch')
def triage_sender_batch_route(payload: dict):
    from ...triage_rules import triage_sender_batch

    return checked(
        triage_sender_batch,
        str(payload.get('sender_addr') or ''),
        str(payload.get('mode') or 'keep_latest_done'),
        int(payload.get('days') or 45),
    )


@router.get('/api/productivity/triage/rules')
def triage_rules_list():
    from ...triage_rules import list_rules

    return {'rules': checked(list_rules)}


@router.post('/api/productivity/triage/rules')
def triage_rule_save(payload: dict):
    from ...triage_rules import save_rule

    return checked(save_rule, payload)


@router.patch('/api/productivity/triage/rules/{rule_id}')
def triage_rule_toggle(rule_id: int, payload: dict):
    from ...triage_rules import toggle_rule

    return checked(toggle_rule, rule_id, bool(payload.get('enabled', True)))


@router.delete('/api/productivity/triage/rules/{rule_id}')
def triage_rule_delete(rule_id: int):
    from fastapi import HTTPException
    from ...triage_rules import delete_rule

    if not checked(delete_rule, rule_id):
        raise HTTPException(404, '规则不存在')
    return {'ok': True}


@router.post('/api/productivity/triage/rules/preview')
def triage_rule_preview(payload: dict):
    from ...triage_rules import preview_rule

    return checked(preview_rule, payload)


@router.post('/api/productivity/triage/rules/apply')
def triage_rules_apply(payload: dict | None = None):
    from ...triage_rules import apply_rules_existing

    raw_id = (payload or {}).get('rule_id')
    rule_id = int(raw_id) if raw_id is not None else None
    return checked(apply_rules_existing, rule_id)
