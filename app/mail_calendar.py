"""Bounded local iCalendar parsing and reviewed export; no remote calendar access."""

import json
import os
import re
import base64
import sqlite3
import subprocess
import sys
from datetime import date, datetime, time, timedelta
from email import policy
from email.parser import BytesParser
from pathlib import Path
from uuid import uuid4
from . import db, productivity, config


def parse_ics(text):
    if len(text) > 500000:
        raise ValueError("日历文件过大")
    text = re.sub(r"\r?\n[ \t]", "", text)
    items = []
    for block in re.findall(r"BEGIN:VEVENT\s*\n(.*?)END:VEVENT", text, re.S | re.I)[
        :30
    ]:
        event = {}
        for line in block.splitlines():
            prop, sep, value = line.partition(":")
            key = prop.split(";")[0].upper()
            if sep and key in (
                "UID",
                "SUMMARY",
                "DTSTART",
                "DTEND",
                "LOCATION",
                "DESCRIPTION",
                "ORGANIZER",
                "STATUS",
                "SEQUENCE",
                "RECURRENCE-ID",
            ):
                event[key.lower()] = (
                    value.replace("\\n", "\n")
                    .replace("\\,", ",")
                    .replace("\\;", ";")[:3000]
                )
                if key in ("DTSTART", "DTEND", "RECURRENCE-ID"):
                    if ";VALUE=DATE" in prop.upper():
                        event[key.lower() + "_value"] = "DATE"
                    match = re.search(r"TZID=([^;:]+)", prop, re.I)
                    if match:
                        event[key.lower() + "_tzid"] = match[1]
        if event.get("dtstart"):
            # Retain source timezone. Do not reinterpret ambiguous floating time.
            event["time_note"] = (
                "Z 表示 UTC；TZID 为原始时区；无时区按导入日历的本地时区处理"
            )
            event["title"] = event.get("summary") or "会议"
            items.append(event)
    return items


def invitations(email_id):
    row = db.get_email(email_id)
    if not row or row.get("remote_missing"):
        raise ValueError("邮件不存在")
    path = Path(row.get("raw_path") or "")
    items = []
    if path.is_file():
        if path.stat().st_size > 40 * 1024 * 1024:
            raise ValueError("原始邮件过大，请单独导入 ICS")
        message = BytesParser(policy=policy.default).parsebytes(path.read_bytes())
        for part in message.walk():
            if part.get_content_type() == "text/calendar" or str(
                part.get_filename() or ""
            ).lower().endswith(".ics"):
                raw = part.get_payload(decode=True) or b""
                if len(raw) > 500000:
                    continue
                items.extend(
                    parse_ics(
                        raw.decode(
                            part.get_content_charset() or "utf-8", errors="replace"
                        )
                    )
                )
    return {
        "items": items[:30],
        "subject": row.get("subject"),
        "scope": "仅解析本地 ICS 邀请；没有 ICS 时可手动核对时间后创建事件",
    }


def export_event(payload):
    title = str(payload.get("title") or "").strip()[:300]
    if not title:
        raise ValueError("请填写会议标题")
    start = productivity.local_time(payload.get("start"))
    end = productivity.local_time(payload.get("end"))
    if end <= start:
        raise ValueError("结束时间必须晚于开始时间")

    def escape(value):
        return (
            str(value or "")[:3000]
            .replace("\\", "\\\\")
            .replace("\r", "")
            .replace("\n", "\\n")
            .replace(";", "\\;")
            .replace(",", "\\,")
        )

    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//MailAI//Local Calendar//ZH",
        "BEGIN:VEVENT",
        "UID:" + str(uuid4()) + "@mailai.local",
        "DTSTAMP:" + datetime.utcnow().strftime("%Y%m%dT%H%M%SZ"),
        "DTSTART:" + datetime.fromisoformat(start).strftime("%Y%m%dT%H%M%S"),
        "DTEND:" + datetime.fromisoformat(end).strftime("%Y%m%dT%H%M%S"),
        "SUMMARY:" + escape(title),
        "LOCATION:" + escape(payload.get("location")),
        "DESCRIPTION:" + escape(payload.get("description")),
        "END:VEVENT",
        "END:VCALENDAR",
    ]
    return "\r\n".join(lines) + "\r\n"


def response_draft(email_id, uid, response):
    if response not in ("accepted", "declined", "tentative"):
        raise ValueError("请选择接受、拒绝或待定")
    events = invitations(email_id)["items"]
    event = next((e for e in events if e.get("uid") == uid and uid), None)
    if not event:
        raise ValueError("邀请已变化或缺少 UID，请重新核对")
    row = db.get_email(email_id)
    label = {"accepted": "接受", "declined": "拒绝", "tentative": "暂定"}[response]

    def safe(value):
        return re.sub(r"[\r\n\x00-\x1f]", "", str(value))[:500]

    attendee = safe(config.IMAP_USER)
    if not attendee or "@" not in attendee:
        raise ValueError("当前邮箱身份未就绪")
    partstat = {
        "accepted": "ACCEPTED",
        "declined": "DECLINED",
        "tentative": "TENTATIVE",
    }[response]
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//MailAI//Calendar Reply//ZH",
        "METHOD:REPLY",
        "BEGIN:VEVENT",
        "UID:" + safe(uid),
        "DTSTAMP:" + datetime.utcnow().strftime("%Y%m%dT%H%M%SZ"),
        "DTSTART"
        + (
            ";VALUE=DATE"
            if event.get("dtstart_value") == "DATE"
            or re.fullmatch(r"\d{8}", event["dtstart"])
            else ";TZID=" + safe(event["dtstart_tzid"])
            if event.get("dtstart_tzid")
            else ""
        )
        + ":"
        + safe(event["dtstart"]),
        "ATTENDEE;PARTSTAT=" + partstat + ":mailto:" + attendee,
    ]
    if event.get("organizer"):
        lines.append("ORGANIZER:" + safe(event["organizer"]))
    if str(event.get("sequence", "")).isdigit():
        lines.append("SEQUENCE:" + str(event["sequence"]))
    if event.get("recurrence-id"):
        lines.append(
            "RECURRENCE-ID"
            + (
                ";VALUE=DATE"
                if event.get("recurrence-id_value") == "DATE"
                else ";TZID=" + safe(event["recurrence-id_tzid"])
                if event.get("recurrence-id_tzid")
                else ""
            )
            + ":"
            + safe(event["recurrence-id"])
        )
    lines += ["END:VEVENT", "END:VCALENDAR"]
    attachment = {
        "filename": "meeting-response.ics",
        "content_type": "text/calendar; method=REPLY; charset=utf-8",
        "data_base64": base64.b64encode(
            ("\r\n".join(lines) + "\r\n").encode()
        ).decode(),
    }
    recipient = row.get("from_addr") or ""
    if str(event.get("organizer") or "").lower().startswith("mailto:"):
        from urllib.parse import urlsplit, unquote
        from .web.helpers import valid_contact_email

        try:
            recipient = valid_contact_email(unquote(urlsplit(event["organizer"]).path))
        except Exception:
            pass
    return {
        "to_addr": recipient,
        "subject": "Re: " + (row.get("subject") or event["title"]),
        "body": f"您好，我对会议“{event['title']}”的回复是：{label}。\n会议时间：{event.get('dtstart', '')}\n请核对日历安排。",
        "attachments": [attachment],
        "reply_to_email_id": email_id,
        "mode": "reply",
        "in_reply_to": row.get("message_id") or "",
        "references": row.get("references_header") or "",
        "notice": "已准备包含 ICS 日历回复的草稿，需你核对后发送；对方日历是否更新取决于其服务",
    }


_WEEKDAYS_ZH = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]


def _safe_rows(c: sqlite3.Connection, sql: str, params: tuple = ()) -> list[dict]:
    try:
        return [dict(r) for r in c.execute(sql, params).fetchall()]
    except sqlite3.OperationalError as exc:
        if "no such table" in str(exc) or "no such column" in str(exc):
            return []
        raise


def _parse_ics_dt(raw: str | None, value_type: str | None = None) -> dict | None:
    text = str(raw or "").strip()
    if not text:
        return None
    if re.fullmatch(r"\d{8}", text) or (value_type == "DATE" and re.match(r"^\d{8}", text)):
        try:
            d = datetime.strptime(text[:8], "%Y%m%d").date()
            return {"date": d.isoformat(), "iso": d.isoformat(), "time": "", "all_day": True}
        except ValueError:
            return None
    match = re.match(r"^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$", text, re.I)
    if not match:
        return None
    y, m, d, hh, mm, ss, is_utc = match.groups()
    try:
        dt = datetime(int(y), int(m), int(d), int(hh), int(mm), int(ss))
    except ValueError:
        return None
    if is_utc:
        from datetime import timezone
        dt = dt.replace(tzinfo=timezone.utc).astimezone().replace(tzinfo=None)
    return {
        "date": dt.date().isoformat(),
        "iso": dt.isoformat(timespec="minutes"),
        "time": dt.strftime("%H:%M"),
        "all_day": False,
        "_dt": dt,
    }


def _parse_local_dt(value: str | None) -> dict | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
        try:
            d = date.fromisoformat(raw)
            return {"date": d.isoformat(), "iso": d.isoformat(), "time": "", "all_day": True}
        except ValueError:
            return None
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if dt.tzinfo is not None:
            dt = dt.astimezone().replace(tzinfo=None)
        return {
            "date": dt.date().isoformat(),
            "iso": dt.isoformat(timespec="minutes"),
            "time": dt.strftime("%H:%M"),
            "all_day": False,
            "_dt": dt,
        }
    except ValueError:
        return None


def _minutes_of_day(hhmm: str) -> int | None:
    match = re.fullmatch(r"(\d{2}):(\d{2})", str(hhmm or ""))
    if not match:
        return None
    return int(match.group(1)) * 60 + int(match.group(2))


def _format_ics_escape(value: str | None) -> str:
    return (
        str(value or "")[:3000]
        .replace("\\", "\\\\")
        .replace("\r", "")
        .replace("\n", "\\n")
        .replace(";", "\\;")
        .replace(",", "\\,")
    )


def create_custom_event(payload: dict) -> dict:
    """在本地日程时间线创建自定义日程事件。"""
    title = str(payload.get("title") or "").strip()[:300]
    if not title:
        raise ValueError("请填写日程标题")
    all_day = bool(payload.get("all_day"))
    location = str(payload.get("location") or "").strip()[:300]
    description = str(payload.get("description") or "").strip()[:2000]
    source_email_id = payload.get("source_email_id")
    if source_email_id is not None:
        try:
            source_email_id = int(source_email_id)
            if source_email_id <= 0:
                source_email_id = None
        except (TypeError, ValueError):
            source_email_id = None

    if all_day:
        start_raw = str(payload.get("start") or "")[:10]
        end_raw = str(payload.get("end") or start_raw)[:10]
        try:
            start_d = date.fromisoformat(start_raw)
            end_d = date.fromisoformat(end_raw)
        except ValueError as exc:
            raise ValueError("全天日程需要有效的 YYYY-MM-DD 日期") from exc
        if end_d < start_d:
            raise ValueError("结束日期不能早于开始日期")
        start_at = start_d.isoformat()
        end_at = end_d.isoformat()
    else:
        start_at = productivity.local_time(payload.get("start"))
        end_raw = payload.get("end")
        if end_raw:
            end_at = productivity.local_time(end_raw)
        else:
            end_at = (datetime.fromisoformat(start_at) + timedelta(hours=1)).isoformat(timespec="seconds")
        if end_at <= start_at:
            raise ValueError("结束时间必须晚于开始时间")

    now = datetime.now().isoformat(timespec="seconds")
    with db.conn() as c:
        cur = c.execute(
            "INSERT INTO calendar_events(title,start_at,end_at,all_day,location,description,source_email_id,created_at) "
            "VALUES(?,?,?,?,?,?,?,?)",
            (title, start_at, end_at, int(all_day), location, description, source_email_id, now),
        )
        row = c.execute("SELECT * FROM calendar_events WHERE id=?", (cur.lastrowid,)).fetchone()
    return dict(row)


def delete_custom_event(event_id: int) -> bool:
    with db.conn() as c:
        cur = c.execute("DELETE FROM calendar_events WHERE id=?", (int(event_id),))
        return cur.rowcount > 0


def _collect_ics_timeline_items(c: sqlite3.Connection, start_d: date, end_d: date) -> list[dict]:
    rows = _safe_rows(
        c,
        "SELECT id, subject, from_name, from_addr, date, raw_path FROM emails "
        "WHERE remote_missing=0 AND status='inbox' AND (verdict='clean' OR feedback='fp') "
        "AND (lower(attachments) LIKE '%.ics%' OR lower(attachments) LIKE '%text/calendar%') "
        "ORDER BY id DESC LIMIT 40",
    )
    items = []
    seen_keys: set[tuple[str, str]] = set()
    for row in rows:
        path = Path(row.get("raw_path") or "")
        if not path.is_file() or path.stat().st_size > 20 * 1024 * 1024:
            continue
        try:
            message = BytesParser(policy=policy.default).parsebytes(path.read_bytes())
        except Exception:
            continue
        for part in message.walk():
            if part.get_content_type() != "text/calendar" and not str(part.get_filename() or "").lower().endswith(".ics"):
                continue
            raw = part.get_payload(decode=True) or b""
            if not raw or len(raw) > 500000:
                continue
            try:
                parsed = parse_ics(raw.decode(part.get_content_charset() or "utf-8", errors="replace"))
            except ValueError:
                continue
            for ev in parsed:
                st = _parse_ics_dt(ev.get("dtstart"), ev.get("dtstart_value"))
                if not st:
                    continue
                ev_date = date.fromisoformat(st["date"])
                if not (start_d <= ev_date <= end_d):
                    continue
                dedupe_key = (str(ev.get("uid") or ev.get("title") or ""), st["iso"])
                if dedupe_key in seen_keys:
                    continue
                seen_keys.add(dedupe_key)
                en = _parse_ics_dt(ev.get("dtend"), ev.get("dtend_value"))
                if st["all_day"]:
                    end_iso = st["date"]
                    end_time = ""
                else:
                    end_dt = (en or {}).get("_dt") or (st["_dt"] + timedelta(hours=1))
                    if end_dt <= st["_dt"]:
                        end_dt = st["_dt"] + timedelta(hours=1)
                    end_iso = end_dt.isoformat(timespec="minutes")
                    end_time = end_dt.strftime("%H:%M")
                items.append({
                    "item_id": f"ics:{row['id']}:{len(items)}",
                    "kind": "ics",
                    "kind_label": "会议邀请",
                    "title": ev.get("title") or row.get("subject") or "会议",
                    "date": st["date"],
                    "start_time": st["time"],
                    "end_time": end_time,
                    "start_at": st["iso"],
                    "end_at": end_iso,
                    "all_day": st["all_day"],
                    "location": (ev.get("location") or "").strip(),
                    "description": (ev.get("description") or "").strip()[:400],
                    "status": "scheduled",
                    "overdue": False,
                    "email_id": int(row["id"]),
                    "source_label": row.get("from_name") or row.get("from_addr") or row.get("subject") or "",
                    "ics_uid": ev.get("uid") or "",
                })
    return items


def _assign_conflicts(items: list[dict]) -> int:
    """标注同日具体时段互相重叠的未完成日程。"""
    by_day: dict[str, list[dict]] = {}
    for item in items:
        item["conflict"] = False
        item["conflict_with"] = []
        if item.get("all_day") or item.get("status") == "done":
            continue
        start_m = _minutes_of_day(item.get("start_time"))
        if start_m is None:
            continue
        end_m = _minutes_of_day(item.get("end_time"))
        if end_m is None or end_m <= start_m:
            end_m = start_m + 30
        item["_start_m"] = start_m
        item["_end_m"] = end_m
        by_day.setdefault(item["date"], []).append(item)

    conflict_pairs = 0
    for day_items in by_day.values():
        if len(day_items) < 2:
            continue
        for i in range(len(day_items)):
            a = day_items[i]
            for j in range(i + 1, len(day_items)):
                b = day_items[j]
                if a["_start_m"] < b["_end_m"] and b["_start_m"] < a["_end_m"]:
                    a["conflict"] = True
                    b["conflict"] = True
                    a["conflict_with"].append(b["title"])
                    b["conflict_with"].append(a["title"])
                    conflict_pairs += 1
    for item in items:
        item.pop("_start_m", None)
        item.pop("_end_m", None)
    return conflict_pairs


def timeline(
    days: int = 14,
    include_past_days: int = 7,
    include_done: bool = False,
    *,
    today: date | None = None,
) -> dict:
    """统一聚合待办截止、发信跟进、ICS 会议邀请与自建日程，构建时间线视图。"""
    span = max(1, min(int(days), 90))
    past = max(0, min(int(include_past_days), 30))
    ref_today = today or date.today()
    start_d = ref_today - timedelta(days=past)
    end_d = ref_today + timedelta(days=span - 1)
    today_iso = ref_today.isoformat()
    tomorrow_iso = (ref_today + timedelta(days=1)).isoformat()

    items: list[dict] = []
    with db.conn() as c:
        todo_rows = _safe_rows(
            c,
            "SELECT t.id, t.email_id, t.title, t.deadline, t.remind_at, t.status, e.subject AS email_subject "
            "FROM todos t LEFT JOIN emails e ON e.id=t.email_id ORDER BY t.id DESC LIMIT 500",
        )
        for row in todo_rows:
            if row.get("status") == "done" and not include_done:
                continue
            rem = _parse_local_dt(row.get("remind_at"))
            dl_raw = (row.get("deadline") or "").strip()
            if rem:
                target_d = date.fromisoformat(rem["date"])
                all_day = rem["all_day"]
                start_time = rem["time"]
                if not all_day and rem.get("_dt"):
                    end_dt = rem["_dt"] + timedelta(minutes=30)
                    end_time = end_dt.strftime("%H:%M")
                    end_at = end_dt.isoformat(timespec="minutes")
                else:
                    end_time = ""
                    end_at = rem["date"]
                start_at = rem["iso"]
            elif dl_raw:
                try:
                    target_d = date.fromisoformat(dl_raw[:10])
                except ValueError:
                    continue
                all_day = True
                start_time = ""
                end_time = ""
                start_at = target_d.isoformat()
                end_at = target_d.isoformat()
            else:
                continue

            is_overdue = row.get("status") != "done" and target_d < ref_today
            if not (start_d <= target_d <= end_d or (is_overdue and target_d >= ref_today - timedelta(days=30))):
                continue

            items.append({
                "item_id": f"todo:{row['id']}",
                "kind": "todo",
                "kind_label": "待办提醒" if rem else "待办截止",
                "todo_id": int(row["id"]),
                "title": (row.get("title") or "").strip(),
                "date": target_d.isoformat(),
                "start_time": start_time,
                "end_time": end_time,
                "start_at": start_at,
                "end_at": end_at,
                "all_day": all_day,
                "location": "",
                "description": f"来源邮件：{row['email_subject']}" if row.get("email_subject") else "",
                "status": row.get("status") or "open",
                "overdue": is_overdue,
                "email_id": int(row["email_id"]) if row.get("email_id") else None,
                "source_label": row.get("email_subject") or "待办中心",
            })

        followup_rows = _safe_rows(
            c,
            "SELECT f.sent_id, f.at, f.state, s.subject, s.to_addr "
            "FROM sent_followups f JOIN sent_messages s ON s.id=f.sent_id "
            "WHERE f.state='scheduled' ORDER BY f.at ASC LIMIT 200",
        )
        for row in followup_rows:
            parsed = _parse_local_dt(row.get("at"))
            if not parsed:
                continue
            target_d = date.fromisoformat(parsed["date"])
            if not (start_d <= target_d <= end_d or target_d < ref_today):
                continue
            if target_d < ref_today - timedelta(days=30):
                continue
            end_dt = (parsed.get("_dt") + timedelta(minutes=30)) if parsed.get("_dt") else None
            items.append({
                "item_id": f"followup:{row['sent_id']}",
                "kind": "followup",
                "kind_label": "发信跟进",
                "sent_id": int(row["sent_id"]),
                "title": f"跟进回信：{row.get('subject') or '（无主题）'}",
                "date": parsed["date"],
                "start_time": parsed["time"],
                "end_time": end_dt.strftime("%H:%M") if end_dt else "",
                "start_at": parsed["iso"],
                "end_at": end_dt.isoformat(timespec="minutes") if end_dt else parsed["date"],
                "all_day": parsed["all_day"],
                "location": "",
                "description": f"收件人：{row.get('to_addr') or '未知'}",
                "status": "scheduled",
                "overdue": parsed["iso"] <= datetime.now().isoformat(timespec="minutes"),
                "email_id": None,
                "source_label": row.get("to_addr") or "发信跟进",
            })

        items.extend(_collect_ics_timeline_items(c, start_d, end_d))

        custom_rows = _safe_rows(
            c,
            "SELECT * FROM calendar_events ORDER BY start_at ASC LIMIT 300",
        )
        for row in custom_rows:
            st = _parse_local_dt(row.get("start_at"))
            if not st:
                continue
            target_d = date.fromisoformat(st["date"])
            if not (start_d <= target_d <= end_d):
                continue
            en = _parse_local_dt(row.get("end_at"))
            all_day = bool(row.get("all_day")) or st["all_day"]
            end_time = "" if all_day else (en or {}).get("time", "")
            items.append({
                "item_id": f"custom:{row['id']}",
                "kind": "custom",
                "kind_label": "自建日程",
                "custom_id": int(row["id"]),
                "title": row.get("title") or "",
                "date": st["date"],
                "start_time": "" if all_day else st["time"],
                "end_time": end_time,
                "start_at": st["iso"],
                "end_at": (en or {}).get("iso") or st["iso"],
                "all_day": all_day,
                "location": row.get("location") or "",
                "description": row.get("description") or "",
                "status": "scheduled",
                "overdue": False,
                "email_id": int(row["source_email_id"]) if row.get("source_email_id") else None,
                "source_label": "个人日程",
            })

    items.sort(
        key=lambda x: (
            0 if x["overdue"] else 1,
            x["date"],
            0 if not x["all_day"] else 1,
            x["start_time"] or "99:99",
            x["item_id"],
        )
    )
    conflict_pairs = _assign_conflicts(items)

    groups_map: dict[str, dict] = {}
    for item in items:
        if item["overdue"]:
            key = "overdue"
            label = "已逾期 / 需尽快处理"
            bucket = "overdue"
        else:
            key = item["date"]
            if key == today_iso:
                label = f"今天 · {key}"
                bucket = "today"
            elif key == tomorrow_iso:
                label = f"明天 · {key}"
                bucket = "tomorrow"
            else:
                d_obj = date.fromisoformat(key)
                label = f"{d_obj.month}月{d_obj.day}日 {_WEEKDAYS_ZH[d_obj.weekday()]}"
                bucket = "upcoming"
        group = groups_map.setdefault(key, {"key": key, "bucket": bucket, "label": label, "items": []})
        group["items"].append(item)

    groups = list(groups_map.values())
    groups.sort(key=lambda g: (0 if g["bucket"] == "overdue" else 1, g["key"]))

    summary = {
        "total": len(items),
        "overdue": sum(1 for x in items if x["overdue"]),
        "today": sum(1 for x in items if not x["overdue"] and x["date"] == today_iso),
        "upcoming": sum(1 for x in items if not x["overdue"] and x["date"] > today_iso),
        "conflicts": conflict_pairs,
        "todo_count": sum(1 for x in items if x["kind"] == "todo"),
        "followup_count": sum(1 for x in items if x["kind"] == "followup"),
        "ics_count": sum(1 for x in items if x["kind"] == "ics"),
        "custom_count": sum(1 for x in items if x["kind"] == "custom"),
    }

    return {
        "days": span,
        "window": {"start_date": start_d.isoformat(), "end_date": end_d.isoformat(), "today": today_iso},
        "summary": summary,
        "items": items,
        "groups": groups,
        "macos_calendar_supported": sys.platform == "darwin",
    }


def _normalize_export_item(raw: dict) -> dict:
    title = str(raw.get("title") or "").strip()[:300]
    if not title:
        raise ValueError("日程条目缺少标题")
    all_day = bool(raw.get("all_day"))
    start_raw = str(raw.get("start_at") or raw.get("start") or raw.get("date") or "").strip()
    end_raw = str(raw.get("end_at") or raw.get("end") or "").strip()
    parsed_start = _parse_local_dt(start_raw)
    if not parsed_start:
        raise ValueError(f"“{title}”缺少有效开始时间")
    if parsed_start["all_day"]:
        all_day = True

    if all_day:
        start_d = date.fromisoformat(parsed_start["date"])
        parsed_end = _parse_local_dt(end_raw) if end_raw else None
        end_d = date.fromisoformat(parsed_end["date"]) if parsed_end else start_d
        if end_d < start_d:
            end_d = start_d
        return {
            "title": title,
            "all_day": True,
            "start_date": start_d.isoformat(),
            "end_date_exclusive": (end_d + timedelta(days=1)).isoformat(),
            "start_dt": datetime.combine(start_d, time(9, 0)),
            "end_dt": datetime.combine(end_d, time(10, 0)),
            "location": str(raw.get("location") or "").strip()[:300],
            "description": str(raw.get("description") or "").strip()[:2000],
            "uid": str(raw.get("ics_uid") or raw.get("item_id") or uuid4()),
        }

    start_dt = parsed_start["_dt"]
    parsed_end = _parse_local_dt(end_raw) if end_raw else None
    end_dt = (parsed_end or {}).get("_dt") or (start_dt + timedelta(hours=1))
    if end_dt <= start_dt:
        end_dt = start_dt + timedelta(minutes=30)
    return {
        "title": title,
        "all_day": False,
        "start_date": start_dt.date().isoformat(),
        "start_dt": start_dt,
        "end_dt": end_dt,
        "location": str(raw.get("location") or "").strip()[:300],
        "description": str(raw.get("description") or "").strip()[:2000],
        "uid": str(raw.get("ics_uid") or raw.get("item_id") or uuid4()),
    }


def export_batch_ics(items: list[dict]) -> str:
    """将多条时间线日程打包导出为标准 VCALENDAR (.ics) 文件。"""
    if not isinstance(items, list) or not items:
        raise ValueError("请至少选择一条日程事件导出")
    if len(items) > 100:
        raise ValueError("单次最多导出 100 条日程")
    normalized = [_normalize_export_item(item) for item in items]
    stamp = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//MailAI//Schedule Timeline//ZH",
    ]
    for ev in normalized:
        uid = re.sub(r"[^a-zA-Z0-9._@-]", "-", ev["uid"])[:80]
        lines.extend(["BEGIN:VEVENT", f"UID:{uid}@mailai.local", f"DTSTAMP:{stamp}"])
        if ev["all_day"]:
            lines.append(f"DTSTART;VALUE=DATE:{ev['start_date'].replace('-', '')}")
            lines.append(f"DTEND;VALUE=DATE:{ev['end_date_exclusive'].replace('-', '')}")
        else:
            lines.append(f"DTSTART:{ev['start_dt'].strftime('%Y%m%dT%H%M%S')}")
            lines.append(f"DTEND:{ev['end_dt'].strftime('%Y%m%dT%H%M%S')}")
        lines.append(f"SUMMARY:{_format_ics_escape(ev['title'])}")
        if ev["location"]:
            lines.append(f"LOCATION:{_format_ics_escape(ev['location'])}")
        if ev["description"]:
            lines.append(f"DESCRIPTION:{_format_ics_escape(ev['description'])}")
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    return "\r\n".join(lines) + "\r\n"


_JXA_LIST_CALENDARS = """
ObjC.import('Foundation');
const calApp = Application('Calendar');
const names = calApp.calendars.whose({writable: true}).name();
JSON.stringify({calendars: Array.from(names || [])});
"""

_JXA_ADD_EVENTS = """
ObjC.import('Foundation');
const env = $.NSProcessInfo.processInfo.environment;
const payload = JSON.parse(ObjC.unwrap(env.objectForKey('MAILAI_CAL_PAYLOAD')));
const calApp = Application('Calendar');
const writable = calApp.calendars.whose({writable: true})();
if (!writable.length) {
  throw new Error('未找到可写入的 macOS 日历账户');
}
let target = writable[0];
if (payload.calendar_name) {
  const matched = writable.find(c => c.name() === payload.calendar_name);
  if (!matched) {
    throw new Error('未找到目标日历：' + payload.calendar_name);
  }
  target = matched;
}
const existingKeys = new Set();
try {
  let minEpoch = Infinity;
  let maxEpoch = -Infinity;
  for (const item of payload.events) {
    if (item.start_epoch < minEpoch) minEpoch = item.start_epoch;
    if (item.start_epoch > maxEpoch) maxEpoch = item.start_epoch;
  }
  const minD = new Date((minEpoch - 86400) * 1000);
  const maxD = new Date((maxEpoch + 86400) * 1000);
  const matched = target.events.whose({
    _and: [
      {startDate: {_greaterThan: minD}},
      {startDate: {_lessThan: maxD}},
    ],
  })() || [];
  for (let i = 0; i < matched.length; i++) {
    const ev = matched[i];
    const d = ev.startDate();
    if (d) {
      const dayKey = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
      existingKeys.add(String(ev.summary() || '') + '|' + dayKey);
    }
  }
} catch (_) {}

let created = 0;
let skipped = 0;
for (const item of payload.events) {
  const key = item.title + '|' + item.start_date;
  if (existingKeys.has(key)) {
    skipped++;
    continue;
  }
  const s = new Date(item.start_epoch * 1000);
  const e = new Date(item.end_epoch * 1000);
  const props = {
    summary: item.title,
    startDate: s,
    endDate: e,
    alldayEvent: Boolean(item.all_day),
  };
  if (item.location) props.location = item.location;
  if (item.description) props.description = item.description;
  const ev = calApp.Event(props);
  target.events.push(ev);
  existingKeys.add(key);
  created++;
}
JSON.stringify({calendar: target.name(), created, skipped});
"""


def _run_jxa(script: str, extra_env: dict[str, str] | None = None, timeout: int = 12) -> dict:
    if sys.platform != "darwin":
        raise ValueError("仅 macOS 支持直写系统日历，请使用 .ics 文件导出导入")
    env = os.environ.copy()
    if extra_env:
        env.update(extra_env)
    proc = subprocess.run(
        ["osascript", "-l", "JavaScript", "-"],
        input=script,
        text=True,
        capture_output=True,
        env=env,
        timeout=timeout,
    )
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()
        if "-1743" in err or "Not authorized" in err or "not allowed" in err.lower():
            raise ValueError("尚未授权 MailAI 访问 macOS「日历」，请在系统设置 → 隐私与安全性 → 自动化中允许，或先导出 .ics 导入")
        raise ValueError(err or "调用 macOS 系统日历失败")
    out = (proc.stdout or "").strip()
    return json.loads(out) if out else {}


def list_macos_calendars() -> dict:
    """列出 macOS 日历中可写入的本机/账号日历；非 macOS 或未授权时优雅降级。"""
    if sys.platform != "darwin":
        return {"supported": False, "calendars": [], "note": "当前平台请使用 .ics 导出导入系统日历"}
    try:
        res = _run_jxa(_JXA_LIST_CALENDARS, timeout=6)
        return {"supported": True, "calendars": res.get("calendars", []), "note": ""}
    except (ValueError, OSError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
        return {"supported": True, "calendars": [], "note": str(exc)}


def write_macos_calendar(items: list[dict], calendar_name: str = "") -> dict:
    """将所选日程事件直接写入 macOS 系统「日历」应用（自动跳过同日同名重复事件）。"""
    if sys.platform != "darwin":
        raise ValueError("当前系统暂不支持直写系统日历，请改用「导出 .ics」导入")
    if not isinstance(items, list) or not items:
        raise ValueError("请至少选择一条日程事件")
    if len(items) > 50:
        raise ValueError("单次最多向系统日历写入 50 条事件")

    normalized = [_normalize_export_item(item) for item in items]
    jxa_events = []
    for ev in normalized:
        if ev["all_day"]:
            d = date.fromisoformat(ev["start_date"])
            start_dt = datetime.combine(d, time(0, 0))
            end_dt = datetime.combine(date.fromisoformat(ev["end_date_exclusive"]), time(0, 0))
        else:
            start_dt = ev["start_dt"]
            end_dt = ev["end_dt"]
        jxa_events.append({
            "title": ev["title"],
            "start_date": ev["start_date"],
            "start_epoch": int(start_dt.timestamp()),
            "end_epoch": int(end_dt.timestamp()),
            "all_day": ev["all_day"],
            "location": ev["location"],
            "description": ev["description"],
        })

    payload = json.dumps(
        {"calendar_name": str(calendar_name or "").strip()[:120], "events": jxa_events},
        ensure_ascii=False,
    )
    try:
        res = _run_jxa(_JXA_ADD_EVENTS, extra_env={"MAILAI_CAL_PAYLOAD": payload}, timeout=45)
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
        raise ValueError(f"写入 macOS 日历失败：{exc}") from exc
    return {
        "ok": True,
        "calendar": res.get("calendar") or calendar_name or "日历",
        "created": int(res.get("created") or 0),
        "skipped": int(res.get("skipped") or 0),
    }
