"""Bounded local iCalendar parsing and reviewed export; no remote calendar access."""

import re
import base64
from datetime import datetime
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
