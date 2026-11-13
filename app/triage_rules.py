"""Local subscription noise detection, batch triage & automatic inbox routing rules."""

from datetime import datetime, timedelta
from email.parser import BytesHeaderParser
import json
import logging
from pathlib import Path
import re
import sqlite3

from . import db
from .parser import strip_html

log = logging.getLogger("mailai.triage_rules")

_VALID_FIELDS = ("sender", "domain", "subject", "body", "is_subscription")
_VALID_OPS = ("contains", "equals", "not_contains")
_VALID_HANDLE_STATES = ("", "done", "later", "reply")
_VALID_BATCH_MODES = ("keep_latest_done", "all_done", "mark_read")

_AUTO_SENDER_RE = re.compile(
    r"(no[-_.]?reply|donotreply|notify|notification|newsletter|digest|mailer[-_.]?daemon|bulletin|alert|system|admin|推送|订阅|通知|系统管理员)",
    re.I,
)
_AUTO_SUBJECT_RE = re.compile(
    r"(订阅|推送|周报|日报|月报|简报|账单|订阅通知|newsletter|digest|notification|summary)",
    re.I,
)
_UNSUB_LINK_RE = re.compile(r"<([^>\s]+)>")


def _ensure_schema(c: sqlite3.Connection) -> None:
    c.execute(
        """CREATE TABLE IF NOT EXISTS auto_triage_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            match_mode TEXT NOT NULL DEFAULT 'all',
            conditions_json TEXT NOT NULL,
            actions_json TEXT NOT NULL,
            hit_count INTEGER NOT NULL DEFAULT 0,
            last_hit_at TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )"""
    )
    cols = {r[1] for r in c.execute("PRAGMA table_info(emails)").fetchall()}
    if "list_unsubscribe" not in cols:
        c.execute("ALTER TABLE emails ADD COLUMN list_unsubscribe TEXT NOT NULL DEFAULT ''")
    if "is_automated" not in cols:
        c.execute("ALTER TABLE emails ADD COLUMN is_automated INTEGER NOT NULL DEFAULT 0")


def _safe_norm(value: str | None) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip().casefold()


def _sender_domain(address: str | None) -> str:
    raw = str(address or "").strip().lower()
    if "@" not in raw:
        return ""
    return raw.rsplit("@", 1)[-1].strip(" >")


def parse_unsubscribe_links(raw_header: str | None) -> list[dict]:
    """Extract safe http(s) or mailto unsubscribe targets from List-Unsubscribe."""
    text = str(raw_header or "").strip()
    if not text:
        return []
    candidates = _UNSUB_LINK_RE.findall(text) or [p.strip() for p in text.split(",")]
    links = []
    seen = set()
    for cand in candidates:
        target = str(cand or "").strip(" <>\"'")
        lower = target.lower()
        if lower.startswith(("https://", "http://")):
            kind = "url"
        elif lower.startswith("mailto:"):
            kind = "mailto"
        else:
            continue
        if target not in seen:
            seen.add(target)
            links.append({"kind": kind, "target": target[:400]})
        if len(links) >= 2:
            break
    return links


def _inspect_raw_headers(raw_path: str | None) -> tuple[str, int]:
    path = Path(str(raw_path or ""))
    if not path.is_file():
        return "", 0
    try:
        with path.open("rb") as fh:
            head = fh.read(24 * 1024)
        msg = BytesHeaderParser().parsebytes(head)
        unsub = str(msg.get("List-Unsubscribe") or "").strip()[:500]
        prec = str(msg.get("Precedence") or "").strip().lower()
        auto_sub = str(msg.get("Auto-Submitted") or "").strip().lower()
        is_auto = 1 if (unsub or prec in ("bulk", "list", "junk") or auto_sub not in ("", "no")) else 0
        return unsub, is_auto
    except OSError:
        return "", 0


def _subject_stem(subject: str | None) -> str:
    text = str(subject or "").strip().lower()
    text = re.sub(r"^(re|fw|fwd|回复|转发)\s*[:：]\s*", "", text, flags=re.I)
    text = re.sub(r"\d+", "#", text)
    return re.sub(r"\s+", " ", text).strip()[:60]


def _is_subscription_row(row: dict) -> tuple[bool, list[str], list[dict]]:
    reasons = []
    unsub_raw = str(row.get("list_unsubscribe") or "").strip()
    is_auto = bool(row.get("is_automated"))
    if not unsub_raw and not is_auto and row.get("raw_path"):
        unsub_raw, is_auto = _inspect_raw_headers(row.get("raw_path"))
    links = parse_unsubscribe_links(unsub_raw)
    if links or unsub_raw:
        reasons.append("含退订协议头 (List-Unsubscribe)")
    elif is_auto:
        reasons.append("含自动/批量投递头")

    addr = str(row.get("from_addr") or "")
    name = str(row.get("from_name") or "")
    if _AUTO_SENDER_RE.search(f"{name} {addr}"):
        reasons.append("自动通知 / 推送发件人")
    if _AUTO_SUBJECT_RE.search(str(row.get("subject") or "")):
        reasons.append("订阅 / 日报 / 推送主题")

    return bool(reasons), reasons, links


def _valid_conditions(conditions: list, match_mode: str) -> list[dict]:
    if match_mode not in ("all", "any"):
        raise ValueError("匹配方式仅支持 all（全部满足）或 any（任一满足）")
    if not isinstance(conditions, list) or not 1 <= len(conditions) <= 15:
        raise ValueError("请设置 1 至 15 条匹配条件")
    cleaned = []
    for cond in conditions:
        if not isinstance(cond, dict):
            raise ValueError("规则条件格式无效")
        field = str(cond.get("field") or "").strip()
        operator = str(cond.get("operator") or "contains").strip()
        value = str(cond.get("value") or "").strip()
        if field not in _VALID_FIELDS:
            raise ValueError("条件字段仅支持发件人、发件域名、主题、正文或订阅识别")
        if field == "is_subscription":
            operator = "equals"
            value = "1"
        else:
            if operator not in _VALID_OPS or not value or len(value) > 300:
                raise ValueError("请填写 1 至 300 字的条件匹配内容")
        cleaned.append({"field": field, "operator": operator, "value": value})
    return cleaned


def _valid_actions(actions: dict, c: sqlite3.Connection) -> dict:
    if not isinstance(actions, dict):
        raise ValueError("请至少配置一项自动分流动作")
    handle_state = str(actions.get("handle_state") or "").strip()
    if handle_state not in _VALID_HANDLE_STATES:
        raise ValueError("处理状态动作无效")
    later_hours = max(1, min(int(actions.get("later_hours") or 24), 720))
    mark_read = bool(actions.get("mark_read"))
    mark_starred = bool(actions.get("mark_starred"))

    raw_tags = actions.get("tag_ids") or []
    if not isinstance(raw_tags, list):
        raise ValueError("标签列表格式无效")
    tag_ids = []
    if raw_tags:
        for tid in raw_tags[:20]:
            try:
                val = int(tid)
            except (TypeError, ValueError):
                raise ValueError("标签 ID 无效")
            if val > 0 and c.execute("SELECT 1 FROM mail_tags WHERE id=?", (val,)).fetchone():
                if val not in tag_ids:
                    tag_ids.append(val)

    if not handle_state and not mark_read and not mark_starred and not tag_ids:
        raise ValueError("请至少选择一项分流动作（如设为已处理、自动已读、星标或打标签）")

    return {
        "handle_state": handle_state,
        "later_hours": later_hours,
        "mark_read": mark_read,
        "mark_starred": mark_starred,
        "tag_ids": tag_ids,
    }


def _match_values(email: dict) -> dict:
    address = str(email.get("from_addr") or "")
    name = str(email.get("from_name") or "")
    body = str(email.get("body_text") or "")
    if not body.strip():
        body = strip_html(str(email.get("body_html") or ""))
    is_sub, _, _ = _is_subscription_row(email)
    return {
        "sender": _safe_norm(f"{name} {address}"),
        "address": _safe_norm(address),
        "name": _safe_norm(name),
        "domain": _safe_norm(_sender_domain(address)),
        "subject": _safe_norm(email.get("subject") or ""),
        "body": _safe_norm(body[:6000]),
        "is_subscription": "1" if is_sub else "0",
    }


def matches_rule(rule: dict, email: dict, values: dict | None = None) -> bool:
    vals = _match_values(email) if values is None else values
    checks = []
    for cond in rule.get("conditions") or []:
        field = cond["field"]
        op = cond["operator"]
        needle = _safe_norm(cond["value"])
        if field == "is_subscription":
            checks.append(vals["is_subscription"] == "1")
            continue
        actual = vals.get(field, "")
        if not actual:
            checks.append(False)
            continue
        if op == "equals":
            if field == "sender":
                checks.append(needle in (vals["address"], vals["name"], vals["sender"]))
            else:
                checks.append(actual == needle)
        elif op == "not_contains":
            checks.append(needle not in actual)
        else:
            checks.append(needle in actual)
    if not checks:
        return False
    return all(checks) if rule.get("match_mode", "all") == "all" else any(checks)


def _decode_rule_row(row: sqlite3.Row | dict) -> dict | None:
    item = dict(row)
    try:
        conditions = json.loads(item.get("conditions_json") or "[]")
        actions = json.loads(item.get("actions_json") or "{}")
        cleaned_conds = _valid_conditions(conditions, item.get("match_mode") or "all")
        return {
            "id": int(item["id"]),
            "name": str(item.get("name") or ""),
            "enabled": bool(item.get("enabled")),
            "match_mode": item.get("match_mode") or "all",
            "conditions": cleaned_conds,
            "actions": actions,
            "hit_count": int(item.get("hit_count") or 0),
            "last_hit_at": item.get("last_hit_at") or "",
            "created_at": item.get("created_at") or "",
            "updated_at": item.get("updated_at") or "",
        }
    except (ValueError, TypeError, json.JSONDecodeError):
        log.warning("Skipping invalid auto_triage_rules row id=%s", item.get("id"))
        return None


def list_rules(*, enabled_only: bool = False, connection: sqlite3.Connection | None = None) -> list[dict]:
    if connection is not None:
        _ensure_schema(connection)
        sql = "SELECT * FROM auto_triage_rules" + (" WHERE enabled=1" if enabled_only else "") + " ORDER BY id ASC"
        return [dec for r in connection.execute(sql).fetchall() if (dec := _decode_rule_row(r))]
    with db.conn() as c:
        return list_rules(enabled_only=enabled_only, connection=c)


def save_rule(payload: dict) -> dict:
    name = str(payload.get("name") or "").strip()[:100]
    if not name:
        raise ValueError("请填写规则名称")
    match_mode = str(payload.get("match_mode") or "all").strip()
    conditions = _valid_conditions(payload.get("conditions") or [], match_mode)
    enabled = 1 if payload.get("enabled", True) else 0
    rule_id = payload.get("id")
    now = datetime.now().isoformat(timespec="seconds")

    with db.conn() as c:
        c.execute("BEGIN IMMEDIATE")
        _ensure_schema(c)
        actions = _valid_actions(payload.get("actions") or {}, c)
        cond_json = json.dumps(conditions, ensure_ascii=False)
        act_json = json.dumps(actions, ensure_ascii=False)
        if rule_id is not None:
            cur = c.execute(
                "UPDATE auto_triage_rules SET name=?, enabled=?, match_mode=?, conditions_json=?, actions_json=?, updated_at=? WHERE id=?",
                (name, enabled, match_mode, cond_json, act_json, now, int(rule_id)),
            )
            if cur.rowcount == 0:
                raise ValueError("规则不存在，请刷新后重试")
            saved_id = int(rule_id)
        else:
            cur = c.execute(
                "INSERT INTO auto_triage_rules(name, enabled, match_mode, conditions_json, actions_json, hit_count, last_hit_at, created_at, updated_at) "
                "VALUES(?,?,?,?,?,0,'',?,?)",
                (name, enabled, match_mode, cond_json, act_json, now, now),
            )
            saved_id = int(cur.lastrowid)
        row = c.execute("SELECT * FROM auto_triage_rules WHERE id=?", (saved_id,)).fetchone()
    return _decode_rule_row(row)


def toggle_rule(rule_id: int, enabled: bool) -> dict:
    now = datetime.now().isoformat(timespec="seconds")
    with db.conn() as c:
        _ensure_schema(c)
        cur = c.execute(
            "UPDATE auto_triage_rules SET enabled=?, updated_at=? WHERE id=?",
            (1 if enabled else 0, now, int(rule_id)),
        )
        if cur.rowcount == 0:
            raise ValueError("规则不存在")
        row = c.execute("SELECT * FROM auto_triage_rules WHERE id=?", (int(rule_id),)).fetchone()
    return _decode_rule_row(row)


def delete_rule(rule_id: int) -> bool:
    with db.conn() as c:
        _ensure_schema(c)
        cur = c.execute("DELETE FROM auto_triage_rules WHERE id=?", (int(rule_id),))
        return cur.rowcount > 0


_SUBSCRIPTION_ELIGIBLE_WHERE = (
    "remote_missing=0 AND status='inbox' AND (verdict='clean' OR feedback='fp') "
    "AND COALESCE(NULLIF(date,''), created_at)>=? "
    "AND COALESCE(is_starred,0)=0 AND COALESCE(is_favorite,0)=0 "
    "AND COALESCE(followup_at,'')='' AND COALESCE(snoozed_until,'')=''"
)


def _subscription_window(days: int = 45) -> tuple[int, str]:
    span = max(7, min(int(days), 180))
    cutoff = (datetime.now() - timedelta(days=span)).isoformat(timespec="seconds")
    return span, cutoff


def scan_subscriptions(days: int = 45, min_count: int = 2) -> dict:
    """Scan clean inbox messages for recurring notifications, newsletters & unsubscribe metadata."""
    span, cutoff = _subscription_window(days)
    threshold = max(1, min(int(min_count), 20))

    with db.conn() as c:
        _ensure_schema(c)
        rows = [
            dict(r)
            for r in c.execute(
                "SELECT id, subject, from_addr, from_name, date, created_at, is_read, handle_state, "
                "raw_path, list_unsubscribe, is_automated "
                "FROM emails "
                f"WHERE {_SUBSCRIPTION_ELIGIBLE_WHERE} "
                "ORDER BY COALESCE(NULLIF(date,''), created_at) DESC, id DESC LIMIT 1200",
                (cutoff,),
            ).fetchall()
        ]
        active_rules = list_rules(enabled_only=True, connection=c)

    active_sender_tokens = set()
    for rule in active_rules:
        for cond in rule.get("conditions") or []:
            if cond["field"] in ("sender", "domain"):
                active_sender_tokens.add(_safe_norm(cond["value"]))

    buckets: dict[str, dict] = {}
    for row in rows:
        addr = str(row.get("from_addr") or "").strip().lower()
        if not addr:
            continue
        b = buckets.setdefault(
            addr,
            {
                "sender_addr": addr,
                "sender_name": str(row.get("from_name") or "").strip(),
                "domain": _sender_domain(addr),
                "rows": [],
                "reasons": set(),
                "unsub_links": [],
                "unsub_seen": set(),
                "stems": {},
            },
        )
        if not b["sender_name"] and row.get("from_name"):
            b["sender_name"] = str(row["from_name"]).strip()
        b["rows"].append(row)
        has_sig, row_reasons, row_links = _is_subscription_row(row)
        b["reasons"].update(row_reasons)
        for lk in row_links:
            if lk["target"] not in b["unsub_seen"]:
                b["unsub_seen"].add(lk["target"])
                b["unsub_links"].append(lk)
        stem = _subject_stem(row.get("subject"))
        if stem:
            b["stems"][stem] = b["stems"].get(stem, 0) + 1

    groups = []
    for addr, b in buckets.items():
        count = len(b["rows"])
        max_stem = max(b["stems"].values()) if b["stems"] else 0
        has_header = any("协议头" in r or "投递头" in r for r in b["reasons"])
        is_auto_sender = bool(b["reasons"])
        if not (has_header or (count >= threshold and (is_auto_sender or max_stem >= 2)) or count >= 4):
            continue

        if count >= threshold:
            b["reasons"].add(f"近 {span} 天同源推送（{count} 封）")
        if max_stem >= 2:
            b["reasons"].add("重复主题周期推送")

        unread_count = sum(1 for r in b["rows"] if not r.get("is_read"))
        unhandled_count = sum(1 for r in b["rows"] if (r.get("handle_state") or "unhandled") != "done")
        dom = b["domain"]
        has_rule = addr in active_sender_tokens or (dom and dom in active_sender_tokens)
        noise_score = count * 10 + unread_count * 6 + unhandled_count * 4 + (15 if b["unsub_links"] else 0)

        groups.append(
            {
                "sender_key": addr,
                "sender_addr": addr,
                "sender_name": b["sender_name"] or addr,
                "domain": dom,
                "total_count": count,
                "unread_count": unread_count,
                "unhandled_count": unhandled_count,
                "latest_date": str(b["rows"][0].get("date") or b["rows"][0].get("created_at") or "")[:19],
                "latest_subject": str(b["rows"][0].get("subject") or ""),
                "sample_email_ids": [int(r["id"]) for r in b["rows"][:5]],
                "reasons": sorted(b["reasons"]),
                "unsubscribe_links": b["unsub_links"],
                "noise_score": noise_score,
                "has_active_rule": has_rule,
            }
        )

    groups.sort(key=lambda g: (-g["unhandled_count"], -g["noise_score"], g["sender_addr"]))
    return {
        "days": span,
        "groups": groups,
        "summary": {
            "total_groups": len(groups),
            "total_emails": sum(g["total_count"] for g in groups),
            "unread_emails": sum(g["unread_count"] for g in groups),
            "unhandled_emails": sum(g["unhandled_count"] for g in groups),
            "with_unsubscribe": sum(1 for g in groups if g["unsubscribe_links"]),
        },
    }


def triage_sender_batch(sender_addr: str, mode: str = "keep_latest_done", days: int = 45) -> dict:
    """Safely batch-triage clean inbox emails from one subscription/notification sender."""
    target = str(sender_addr or "").strip().lower()
    if not target:
        raise ValueError("缺少发件人邮箱地址")
    if mode not in _VALID_BATCH_MODES:
        raise ValueError("不支持的批处理模式")
    span, cutoff = _subscription_window(days)

    with db.conn() as c:
        _ensure_schema(c)
        rows = [
            dict(r)
            for r in c.execute(
                "SELECT id, is_read, handle_state FROM emails "
                f"WHERE {_SUBSCRIPTION_ELIGIBLE_WHERE} "
                "AND lower(from_addr)=? "
                "ORDER BY COALESCE(NULLIF(date,''), created_at) DESC, id DESC",
                (cutoff, target),
            ).fetchall()
        ]
    if not rows:
        raise ValueError("未找到该发件人当前可处理的收件箱邮件")

    candidates = rows[1:] if mode == "keep_latest_done" else rows
    if mode in ("keep_latest_done", "all_done"):
        affected_ids = [
            int(r["id"])
            for r in candidates
            if not r.get("is_read") or (r.get("handle_state") or "unhandled") != "done"
        ]
    else:
        affected_ids = [int(r["id"]) for r in candidates if not r.get("is_read")]

    now = datetime.now().isoformat(timespec="seconds")
    if affected_ids:
        db.queue_seen_sync(affected_ids, True)
        if mode in ("keep_latest_done", "all_done"):
            with db.conn() as c:
                c.execute("BEGIN IMMEDIATE")
                placeholders = ",".join("?" for _ in affected_ids)
                c.execute(
                    f"UPDATE emails SET handle_state='done', workflow_updated_at=? "
                    f"WHERE id IN ({placeholders})",
                    (now, *affected_ids),
                )
                c.execute(
                    f"DELETE FROM mail_workflow_notices WHERE email_id IN ({placeholders})",
                    affected_ids,
                )
        db.add_audit_log(
            affected_ids[0],
            action="triage_sender_batch",
            actor="user",
            reason=f"{target} · {mode} ({len(affected_ids)} 封)",
            meta={"sender_addr": target, "mode": mode, "days": span, "email_ids": affected_ids[:50]},
        )

    return {
        "ok": True,
        "sender_addr": target,
        "mode": mode,
        "days": span,
        "updated_count": len(affected_ids),
        "kept_latest_id": int(rows[0]["id"]) if mode == "keep_latest_done" and rows else None,
        "email_ids": affected_ids,
    }


def _apply_actions_on_conn(c: sqlite3.Connection, email_id: int, actions: dict) -> bool:
    changed = False
    now = datetime.now()
    now_iso = now.isoformat(timespec="seconds")
    handle_state = str(actions.get("handle_state") or "")
    updates = []
    params = []

    if handle_state in ("done", "later", "reply"):
        snooze = (
            (now + timedelta(hours=max(1, int(actions.get("later_hours") or 24)))).isoformat(timespec="seconds")
            if handle_state == "later"
            else ""
        )
        updates.extend(["handle_state=?", "snoozed_until=?", "followup_at=''", "workflow_updated_at=?"])
        params.extend([handle_state, snooze, now_iso])
        c.execute("DELETE FROM mail_workflow_notices WHERE email_id=?", (email_id,))
        if snooze:
            c.execute(
                "INSERT INTO mail_workflow_notices(email_id,at,sent) VALUES(?,?,0) "
                "ON CONFLICT(email_id) DO UPDATE SET at=excluded.at,sent=0",
                (email_id, snooze),
            )

    if actions.get("mark_read"):
        updates.append("is_read=1")
    if actions.get("mark_starred"):
        updates.append("is_starred=1")

    if updates:
        params.append(email_id)
        changed = c.execute(f"UPDATE emails SET {', '.join(updates)} WHERE id=?", params).rowcount > 0

    for tid in actions.get("tag_ids") or []:
        res = c.execute(
            "INSERT OR IGNORE INTO email_tags(email_id,tag_id) SELECT ?,id FROM mail_tags WHERE id=?",
            (email_id, int(tid)),
        )
        if res.rowcount > 0:
            changed = True

    return changed


def apply_to_ingested_email(c: sqlite3.Connection, email_id: int, email: dict) -> int:
    """Run active auto-triage rules when a clean inbox email is first stored."""
    status = str(email.get("status") or "inbox")
    verdict = str(email.get("verdict") or "clean")
    feedback = str(email.get("feedback") or "")
    if status != "inbox" or not (verdict in ("clean", "") or feedback == "fp"):
        return 0
    _ensure_schema(c)
    active = list_rules(enabled_only=True, connection=c)
    if not active:
        return 0

    vals = _match_values(email)
    matched_rules = [r for r in active if matches_rule(r, email, vals)]
    if not matched_rules:
        return 0

    now_iso = datetime.now().isoformat(timespec="seconds")
    hits = 0
    for rule in matched_rules:
        _apply_actions_on_conn(c, email_id, rule["actions"])
        c.execute(
            "UPDATE auto_triage_rules SET hit_count=hit_count+1, last_hit_at=? WHERE id=?",
            (now_iso, rule["id"]),
        )
        hits += 1
    return hits


def preview_rule(payload: dict, limit: int = 30) -> dict:
    """Dry-run a rule against clean inbox messages without mutating anything."""
    match_mode = str(payload.get("match_mode") or "all").strip()
    conditions = _valid_conditions(payload.get("conditions") or [], match_mode)
    candidate_rule = {"match_mode": match_mode, "conditions": conditions}

    with db.conn() as c:
        _ensure_schema(c)
        rows = [
            dict(r)
            for r in c.execute(
                "SELECT id, subject, from_name, from_addr, date, created_at, snippet, body_text, body_html, "
                "is_read, handle_state, raw_path, list_unsubscribe, is_automated "
                "FROM emails "
                "WHERE remote_missing=0 AND status='inbox' AND (verdict='clean' OR feedback='fp') "
                "ORDER BY COALESCE(NULLIF(date,''), created_at) DESC, id DESC LIMIT 600"
            ).fetchall()
        ]

    matched = []
    for row in rows:
        if matches_rule(candidate_rule, row):
            matched.append(
                {
                    "id": int(row["id"]),
                    "subject": str(row.get("subject") or ""),
                    "from_name": str(row.get("from_name") or ""),
                    "from_addr": str(row.get("from_addr") or ""),
                    "date": str(row.get("date") or row.get("created_at") or "")[:19],
                    "is_read": bool(row.get("is_read")),
                    "handle_state": str(row.get("handle_state") or "unhandled"),
                }
            )
    return {
        "matched_count": len(matched),
        "items": matched[: max(1, min(int(limit), 50))],
    }


def apply_rules_existing(rule_id: int | None = None) -> dict:
    """Apply all enabled auto-triage rules (or a specific rule) to existing clean inbox emails."""
    with db.conn() as c:
        c.execute("BEGIN IMMEDIATE")
        _ensure_schema(c)
        if rule_id is not None:
            row = c.execute("SELECT * FROM auto_triage_rules WHERE id=?", (int(rule_id),)).fetchone()
            rule = _decode_rule_row(row) if row else None
            if not rule:
                raise ValueError("规则不存在或无效")
            active = [rule]
        else:
            active = list_rules(enabled_only=True, connection=c)
        if not active:
            return {"ok": True, "matched": 0, "updated": 0, "rule_count": 0}

        rows = [
            dict(r)
            for r in c.execute(
                "SELECT id, subject, from_name, from_addr, body_text, body_html, raw_path, list_unsubscribe, is_automated "
                "FROM emails "
                "WHERE remote_missing=0 AND status='inbox' AND (verdict='clean' OR feedback='fp') "
                "ORDER BY id DESC LIMIT 600"
            ).fetchall()
        ]

        now_iso = datetime.now().isoformat(timespec="seconds")
        matched_emails = 0
        updated_emails = 0
        rule_hits = {r["id"]: 0 for r in active}

        for row in rows:
            vals = _match_values(row)
            hit_any = False
            changed_any = False
            for rule in active:
                if matches_rule(rule, row, vals):
                    hit_any = True
                    rule_hits[rule["id"]] += 1
                    if _apply_actions_on_conn(c, int(row["id"]), rule["actions"]):
                        changed_any = True
            if hit_any:
                matched_emails += 1
            if changed_any:
                updated_emails += 1

        for rid, hits in rule_hits.items():
            if hits:
                c.execute(
                    "UPDATE auto_triage_rules SET hit_count=hit_count+?, last_hit_at=? WHERE id=?",
                    (hits, now_iso, rid),
                )

    return {
        "ok": True,
        "matched": matched_emails,
        "updated": updated_emails,
        "rule_count": len(active),
    }
