"""Local, account-scoped productivity. No model calls or remote mailbox mutations."""

import csv
import io
import json
import re
import shlex
from datetime import datetime
from . import db, config

STATES = {"unhandled", "reply", "waiting", "later", "done"}


def initialize(c):
    from .sent_followups import initialize as initialize_followups

    initialize_followups(c)
    columns = {r[1] for r in c.execute("PRAGMA table_info(emails)")}
    for key, definition in {
        "handle_state": "TEXT NOT NULL DEFAULT 'unhandled'",
        "snoozed_until": "TEXT NOT NULL DEFAULT ''",
        "followup_at": "TEXT NOT NULL DEFAULT ''",
        "focus_override": "TEXT NOT NULL DEFAULT ''",
        "workflow_updated_at": "TEXT NOT NULL DEFAULT ''",
    }.items():
        if key not in columns:
            c.execute(f"ALTER TABLE emails ADD COLUMN {key} {definition}")
    c.execute(
        "CREATE INDEX IF NOT EXISTS idx_mail_workflow ON emails(handle_state,snoozed_until,followup_at)"
    )
    c.execute(
        "CREATE TABLE IF NOT EXISTS mail_templates(id INTEGER PRIMARY KEY,name TEXT NOT NULL,subject TEXT NOT NULL,body TEXT NOT NULL,updated_at TEXT NOT NULL)"
    )
    c.execute(
        "CREATE TABLE IF NOT EXISTS mail_snippets(id INTEGER PRIMARY KEY,name TEXT NOT NULL,subject TEXT NOT NULL DEFAULT '',body TEXT NOT NULL,updated_at TEXT NOT NULL)"
    )
    c.execute(
        "CREATE TABLE IF NOT EXISTS saved_mail_searches(id INTEGER PRIMARY KEY,name TEXT NOT NULL,criteria TEXT NOT NULL,updated_at TEXT NOT NULL)"
    )
    c.execute(
        "CREATE TABLE IF NOT EXISTS focus_senders(address TEXT PRIMARY KEY,choice TEXT NOT NULL)"
    )
    c.execute(
        "CREATE TABLE IF NOT EXISTS attachment_text_index(email_id INTEGER NOT NULL,attachment_index INTEGER NOT NULL,digest TEXT NOT NULL,name TEXT NOT NULL,body TEXT NOT NULL,note TEXT NOT NULL,PRIMARY KEY(email_id,attachment_index))"
    )
    c.execute(
        "CREATE TABLE IF NOT EXISTS calendar_responses(email_id INTEGER NOT NULL,event_uid TEXT NOT NULL,response TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(email_id,event_uid))"
    )
    c.execute(
        "CREATE TABLE IF NOT EXISTS mail_workflow_notices(email_id INTEGER PRIMARY KEY,at TEXT NOT NULL,sent INTEGER NOT NULL DEFAULT 0,retry_after REAL NOT NULL DEFAULT 0)"
    )
    c.execute(
        "CREATE TABLE IF NOT EXISTS shared_mail_links(id INTEGER PRIMARY KEY,object_key TEXT UNIQUE NOT NULL,name TEXT NOT NULL,size INTEGER NOT NULL,bucket TEXT NOT NULL,region TEXT NOT NULL,url TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL)"
    )


def local_time(value, *, future=False):
    try:
        dt = datetime.fromisoformat(str(value))
        if dt.tzinfo:
            dt = dt.astimezone().replace(tzinfo=None)
        if future and dt <= datetime.now():
            raise ValueError()
        return dt.isoformat(timespec="seconds")
    except (ValueError, TypeError):
        raise ValueError("请选择有效的将来时间" if future else "时间格式无效")


def set_workflow(email_id, state, at="", followup_at=""):
    if state not in STATES:
        raise ValueError("无效处理状态")
    snooze = local_time(at, future=True) if state == "later" else ""
    followup = (
        local_time(followup_at, future=True)
        if state == "waiting" and followup_at
        else ""
    )
    with db.conn() as c:
        c.execute("BEGIN IMMEDIATE")
        row = c.execute(
            "SELECT handle_state,snoozed_until,followup_at FROM emails WHERE id=? AND remote_missing=0 AND status NOT IN ('trash','spam','quarantine','draft')",
            (email_id,),
        ).fetchone()
        if not row:
            raise ValueError("这封邮件当前不能安排处理")
        old = dict(row)
        c.execute(
            "UPDATE emails SET handle_state=?,snoozed_until=?,followup_at=?,workflow_updated_at=? WHERE id=?",
            (state, snooze, followup, datetime.now().isoformat(), email_id),
        )
        c.execute("DELETE FROM mail_workflow_notices WHERE email_id=?", (email_id,))
        if snooze or followup:
            c.execute(
                "INSERT INTO mail_workflow_notices(email_id,at) VALUES(?,?)",
                (email_id, snooze or followup),
            )
    return {"ok": True, "previous": old, "state": state, "at": snooze or followup}


def refresh_workflow():
    """Snooze returns locally. Waiting reminder is canceled only by a real reply."""
    now = datetime.now().isoformat(timespec="seconds")
    with db.conn() as c:
        c.execute(
            "UPDATE emails SET handle_state='unhandled',snoozed_until='' WHERE handle_state='later' AND snoozed_until<>'' AND snoozed_until<=?",
            (now,),
        )
        # Link only by message headers, never by similar subject.
        changed = c.execute(
            "UPDATE emails SET handle_state='unhandled',followup_at='',snoozed_until='' WHERE handle_state IN ('waiting','later') AND message_id<>'' AND EXISTS(SELECT 1 FROM emails reply WHERE reply.remote_missing=0 AND reply.status='inbox' AND lower(reply.from_addr)<>? AND (lower(trim(reply.in_reply_to))=lower(trim(emails.message_id)) OR lower(trim(reply.in_reply_to)) IN (SELECT lower(trim(s.message_id)) FROM sent_messages s WHERE s.reply_to_email_id=emails.id AND s.status='sent' AND s.message_id<>'')) AND datetime(reply.date)>datetime(COALESCE(NULLIF(emails.workflow_updated_at,''),emails.date))) RETURNING id",
            ((config.IMAP_USER or "").casefold(),),
        ).fetchall()
        for row in changed:
            c.execute("DELETE FROM mail_workflow_notices WHERE email_id=?", (row[0],))
        c.execute(
            "DELETE FROM mail_workflow_notices WHERE email_id IN (SELECT id FROM emails WHERE status IN ('trash','spam','quarantine') OR remote_missing<>0 OR handle_state='done')"
        )
        # New replies cancel waiting notices; elapsed snoozes retain their due notice.
        c.execute(
            "DELETE FROM mail_workflow_notices WHERE email_id IN (SELECT id FROM emails WHERE handle_state='unhandled' AND workflow_updated_at<>'' AND snoozed_until='' AND followup_at='') AND at>?",
            (now,),
        )


def criteria_from_query(query, criteria=None):
    result = dict(criteria or {})
    try:
        words = shlex.split(query)
    except ValueError:
        raise ValueError("搜索引号未闭合")
    plain = []
    names = {
        "from": "sender",
        "to": "recipient",
        "subject": "subject",
        "after": "after",
        "before": "before",
        "filename": "filename",
        "in": "mailbox",
        "state": "state",
        "category": "category",
    }
    for word in words:
        key, sep, value = word.partition(":")
        if sep and key in names:
            result[names[key]] = value
        elif word == "has:attachment":
            result["has_attachment"] = True
        elif word == "is:unread":
            result["unread"] = True
        else:
            plain.append(word)
    result["text"] = " ".join(plain) or str(result.get("text") or "")
    return result


def search(criteria, *, offset=0, limit=50):
    criteria = criteria_from_query(str(criteria.get("query") or "")[:1000], criteria)
    limit, offset = max(1, min(int(limit), 200)), max(0, int(offset))
    mailbox = criteria.get("mailbox") or "all"
    if mailbox not in {"all", "inbox", "sent", "drafts", "trash", "quarantine", "spam"}:
        raise ValueError("请选择有效的邮件范围")
    after, before = criteria.get("after") or "", criteria.get("before") or ""
    for date in (after, before):
        if date:
            try:
                datetime.strptime(date, "%Y-%m-%d")
            except ValueError:
                raise ValueError("日期必须为 YYYY-MM-DD")
    if after and before and after > before:
        raise ValueError("开始日期不能晚于结束日期")
    state = criteria.get("state") or ""
    if state and state not in STATES | {"due", "focus"}:
        raise ValueError("处理状态无效")
    refresh_workflow()
    result = []
    with db.conn() as c:
        # SQL only uses these fixed expressions; user values are always parameters.
        specs = [
            (
                "emails",
                "email",
                "COALESCE(NULLIF(date,''),created_at)",
                "body_text",
                "attachments",
                "remote_missing=0",
            ),
            (
                "sent_messages",
                "sent",
                "COALESCE(sent_at,created_at)",
                "body_html",
                "attachments_json",
                "status='sent'",
            ),
            ("drafts", "draft", "updated_at", "body_html", "attachments_json", "1=1"),
        ]
        if mailbox != "all":
            specs = [
                spec
                for spec in specs
                if spec[1]
                == (
                    "draft"
                    if mailbox == "drafts"
                    else "sent"
                    if mailbox == "sent"
                    else "email"
                )
            ]
        for table, kind, date_expr, body_col, att_col, condition in specs:
            args = []
            if kind == "email":
                condition += " AND NOT (status='sent' AND message_id<>'' AND EXISTS(SELECT 1 FROM sent_messages s WHERE s.status='sent' AND lower(trim(s.message_id))=lower(trim(emails.message_id))))"
                if mailbox == "all":
                    condition += " AND status NOT IN ('trash','spam','quarantine')"
                elif mailbox not in ("sent", "drafts"):
                    condition += " AND status=?"
                    args.append(mailbox)
            if kind != "email" and (
                criteria.get("unread") or state or criteria.get("category")
            ):
                continue
            if kind == "email" and criteria.get("category"):
                condition += " AND category=?"
                args.append(str(criteria["category"])[:100])
            expressions = {
                "sender": "from_addr" if kind != "draft" else "''",
                "recipient": "coalesce(to_addr,'')||' '||coalesce(cc_addr,'')",
                "subject": "subject",
                "filename": att_col,
            }
            for key, expression in expressions.items():
                if key == "filename":
                    if criteria.get(key):
                        condition += f" AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid({att_col}) THEN {att_col} ELSE '[]' END) a WHERE lower(coalesce(json_extract(CASE WHEN json_valid(a.value) THEN a.value ELSE '{{}}' END,'$.name'),json_extract(CASE WHEN json_valid(a.value) THEN a.value ELSE '{{}}' END,'$.filename'),'')) LIKE ? ESCAPE '\\')"
                        args.append("%" + _like(str(criteria[key])[:250].lower()) + "%")
                    continue
                if criteria.get(key):
                    condition += (
                        f" AND lower(coalesce({expression},'')) LIKE ? ESCAPE '\\'"
                    )
                    args.append("%" + _like(str(criteria[key])[:250].lower()) + "%")
            for token in str(criteria.get("text") or "")[:1000].split()[:12]:
                expression = f"coalesce(subject,'')||' '||coalesce(to_addr,'')||' '||coalesce({body_col},'')"
                if kind != "draft":
                    expression += "||' '||coalesce(from_addr,'')"
                condition += f" AND lower({expression}) LIKE ? ESCAPE '\\'"
                args.append("%" + _like(token.lower()) + "%")
            if criteria.get("has_attachment"):
                condition += (
                    f" AND {att_col} NOT IN ('[]','', 'null') AND {att_col} IS NOT NULL"
                )
            for date, op in ((after, ">="), (before, "<=")):
                if date:
                    condition += f" AND date({date_expr}) {op} date(?)"
                    args.append(date)
            if kind == "email":
                if criteria.get("unread"):
                    condition += " AND is_read=0"
                if state == "due":
                    condition += " AND handle_state='waiting' AND followup_at<>'' AND followup_at<=?"
                    args.append(datetime.now().isoformat(timespec="seconds"))
                elif state == "focus":
                    condition += " AND focus_override<>'other' AND (focus_override='focus' OR (focus_override='' AND (priority='高' OR EXISTS(SELECT 1 FROM focus_senders f WHERE lower(from_addr)=f.address AND f.choice='focus') OR EXISTS(SELECT 1 FROM contacts c WHERE lower(from_addr)=lower(c.email) AND c.favorite=1 AND c.hidden=0)))) AND NOT EXISTS(SELECT 1 FROM focus_senders f WHERE lower(from_addr)=f.address AND f.choice='other' AND focus_override='')"
                elif state:
                    condition += " AND handle_state=?"
                    args.append(state)
            fields = (
                "id,subject,to_addr,"
                + ("from_addr," if kind != "draft" else "'' AS from_addr,")
                + f"{date_expr} AS date,substr({body_col},1,300) AS preview"
            )
            if kind == "email":
                fields += ",status,handle_state,snoozed_until,followup_at,thread_id,message_id,priority"
            rows = c.execute(
                f"SELECT {fields} FROM {table} WHERE {condition} ORDER BY {date_expr} DESC,id DESC LIMIT ?",
                (*args, offset + limit + 1),
            ).fetchall()
            for row in rows:
                item = dict(row)
                item["kind"] = kind
                item["preview"] = re.sub("<[^>]*>", " ", item.get("preview") or "")[
                    :200
                ]
                result.append(item)
    result.sort(key=lambda r: (r["date"] or "", r["id"], r["kind"]), reverse=True)
    return {
        "items": result[offset : offset + limit],
        "has_more": len(result) > offset + limit,
        "scope": "当前账号，仅已同步到本机的邮件；附件内容使用单独的本地索引",
        "criteria": criteria,
    }


def _like(value):
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def save_named(kind, payload):
    if kind == "snippets" and (
        not str(payload.get("body") or "").strip()
        or len(str(payload.get("body") or "")) > 5000
    ):
        raise ValueError("短语内容不能为空，且最多 5000 字符")
    table = {
        "templates": "mail_templates",
        "snippets": "mail_snippets",
        "searches": "saved_mail_searches",
    }[kind]
    name = str(payload.get("name") or "").strip()[:80]
    if not name:
        raise ValueError("请填写名称")
    ident = payload.get("id")
    if ident is not None and (not isinstance(ident, int) or ident <= 0):
        raise ValueError("记录编号无效")
    fields = (
        ("name", "subject", "body")
        if kind in ("templates", "snippets")
        else ("name", "criteria")
    )
    values = (
        (
            name,
            str(payload.get("subject") or "")[:300],
            str(payload.get("body") or "")[:30000],
        )
        if kind in ("templates", "snippets")
        else (
            name,
            json.dumps(
                criteria_from_query("", payload.get("criteria") or {}),
                ensure_ascii=False,
            ),
        )
    )
    now = datetime.now().isoformat()
    with db.conn() as c:
        c.execute("BEGIN IMMEDIATE")
        if ident:
            cur = c.execute(
                f"UPDATE {table} SET "
                + ",".join(f"{f}=?" for f in fields)
                + ",updated_at=? WHERE id=?",
                (*values, now, ident),
            )
            if not cur.rowcount:
                raise ValueError("记录已移除，请重新打开")
        else:
            if c.execute(f"SELECT count(*) FROM {table}").fetchone()[0] >= 200:
                raise ValueError("最多保存 200 项，请先整理已有记录")
            ident = c.execute(
                f"INSERT INTO {table}({','.join(fields)},updated_at) VALUES({','.join('?' for _ in fields)},?)",
                (*values, now),
            ).lastrowid
    return {"ok": True, "id": ident}


def named_items(kind):
    table = {
        "templates": "mail_templates",
        "snippets": "mail_snippets",
        "searches": "saved_mail_searches",
    }[kind]
    with db.conn() as c:
        rows = [
            dict(r)
            for r in c.execute(f"SELECT * FROM {table} ORDER BY updated_at DESC")
        ]
    if kind == "searches":
        for row in rows:
            row["criteria"] = json.loads(row["criteria"])
    return rows


def import_contacts(text, format="csv", apply=False, overwrite=False):
    if len(text.encode("utf-8")) > 2 * 1024 * 1024:
        raise ValueError("通讯录不能超过 2 MB")
    if format not in ("csv", "vcard"):
        raise ValueError("请选择 CSV 或 vCard")
    rows = []
    if format == "csv":
        for row in csv.DictReader(io.StringIO(text.lstrip("\ufeff"))):
            rows.append(
                {
                    "email": row.get("email") or row.get("邮箱") or "",
                    "name": row.get("name") or row.get("姓名") or "",
                    "company": row.get("company") or row.get("公司") or "",
                    "group_name": row.get("group_name") or row.get("分组") or "",
                }
            )
            if len(rows) > 2000:
                raise ValueError("每次最多导入 2000 人")
    else:
        unfolded = re.sub(r"\r?\n[ \t]", "", text)
        for block in re.findall(
            r"BEGIN:VCARD\s*\n(.*?)END:VCARD", unfolded, re.I | re.S
        ):
            value = {"email": "", "name": "", "company": "", "group_name": ""}
            for line in block.splitlines():
                prop, sep, data = line.partition(":")
                key = prop.split(";")[0].upper()
                if sep and key in ("EMAIL", "FN", "ORG"):
                    value[{"EMAIL": "email", "FN": "name", "ORG": "company"}[key]] = (
                        data.replace("\\n", " ")
                        .replace("\\,", ",")
                        .replace("\\;", ";")
                        .replace("\\\\", "\\")
                    )
            rows.append(value)
            if len(rows) > 2000:
                raise ValueError("每次最多导入 2000 人")
    from .web.helpers import valid_contact_email

    valid, errors, seen = [], [], set()
    for number, row in enumerate(rows, 1):
        try:
            address = valid_contact_email(row["email"].strip()).casefold()
        except Exception:
            errors.append(number)
            continue
        if address in seen:
            continue
        seen.add(address)
        valid.append({**row, "email": address})
    if not valid:
        raise ValueError(
            "没有找到有效联系人，请使用 email,name,company,group_name 列或标准 vCard"
        )
    added = skipped = 0
    with db.conn() as c:
        c.execute("BEGIN IMMEDIATE")
        for row in valid:
            existing = c.execute(
                "SELECT 1 FROM contacts WHERE email=?", (row["email"],)
            ).fetchone()
            if existing and not overwrite:
                skipped += 1
                continue
            added += 1
            if apply:
                now = datetime.now().isoformat()
                group = row["group_name"][:80]
                c.execute(
                    "INSERT INTO contacts(email,name,company,group_name,source,hidden,created_at,updated_at) VALUES(?,?,?,?,'manual',0,?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name,company=excluded.company,group_name=excluded.group_name,hidden=0,updated_at=excluded.updated_at",
                    (
                        row["email"],
                        row["name"][:200],
                        row["company"][:200],
                        group,
                        now,
                        now,
                    ),
                )
                if group:
                    c.execute(
                        "INSERT OR IGNORE INTO contact_groups(name) VALUES(?)", (group,)
                    )
    return {
        "ok": True,
        "applied": apply,
        "accepted": added,
        "skipped": skipped,
        "invalid_rows": errors,
        "preview": valid[:20],
    }


def export_contacts(format):
    if format not in ("csv", "vcard"):
        raise ValueError("格式无效")
    with db.conn() as c:
        rows = [
            dict(r)
            for r in c.execute(
                "SELECT email,name,company,group_name FROM contacts WHERE hidden=0 ORDER BY name,email"
            )
        ]
    if format == "csv":
        out = io.StringIO()
        writer = csv.DictWriter(
            out, fieldnames=["email", "name", "company", "group_name"]
        )
        writer.writeheader()
        # Spreadsheet applications must not interpret user names as formulas.
        for row in rows:
            writer.writerow(
                {
                    k: "'" + v
                    if v and v.lstrip().startswith(("=", "+", "-", "@", "\t", "\r"))
                    else v
                    for k, v in row.items()
                }
            )
        return "\ufeff" + out.getvalue()

    def escape(v):
        return (
            v.replace("\\", "\\\\")
            .replace("\n", "\\n")
            .replace("\r", "")
            .replace(";", "\\;")
            .replace(",", "\\,")
        )

    return "".join(
        "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:"
        + escape(r["name"] or r["email"])
        + "\r\nEMAIL:"
        + escape(r["email"])
        + "\r\nORG:"
        + escape(r["company"] or "")
        + "\r\nEND:VCARD\r\n"
        for r in rows
    )


def dispatch_workflow(account_id, account, send=None):
    """Durable local reminders, with retry leases and no automatic email actions."""
    import time
    from .account_context import use
    from .task_notifications import deliver
    from .ui_copy import ui_text, ui_format

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
        refresh_workflow()
        now = datetime.now().isoformat(timespec="seconds")
        with db.conn() as c:
            c.execute("BEGIN IMMEDIATE")
            rows = c.execute(
                "SELECT n.email_id,n.at,e.subject,e.handle_state FROM mail_workflow_notices n JOIN emails e ON e.id=n.email_id WHERE n.sent=0 AND n.at<=? AND n.retry_after<=? AND e.remote_missing=0 AND e.status NOT IN ('trash','quarantine','spam') ORDER BY n.at LIMIT 20",
                (now, time.time()),
            ).fetchall()
            for row in rows:
                c.execute(
                    "UPDATE mail_workflow_notices SET retry_after=? WHERE email_id=? AND at=?",
                    (time.time() + 60, row["email_id"], row["at"]),
                )
        if not rows:
            return 0
        row = rows[0]
        try:
            accepted = send(
                ui_text('MailAI · 邮件到处理时间了'),
                (row["subject"] or ui_text('邮件'))[:120]
                + (ui_format(' 等 {0} 项', len(rows)) if len(rows) > 1 else '')
                + "\n"
                + account.get("user", ""),
                {"accountId": account_id, "workflowEmailId": row["email_id"]},
            )
        except Exception:
            accepted = False
        if accepted:
            with db.conn() as c:
                for row in rows:
                    c.execute(
                        "UPDATE mail_workflow_notices SET sent=1 WHERE email_id=? AND at=?",
                        (row["email_id"], row["at"]),
                    )
        return len(rows) if accepted else 0
