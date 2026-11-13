"""周期工作自动简报：聚合收发邮件、待办与发信跟进，生成周报/月报草稿并维护历史记录。"""
from __future__ import annotations

import email.utils
import html
import json
import logging
import re
import sqlite3
from datetime import date, datetime, timedelta
from typing import Any

from . import db, recipient_profiles, work_memory
from .llm import client as llm_client

log = logging.getLogger(__name__)

PERIOD_LABELS = {
    "this_week": "本周工作简报",
    "last_7_days": "近 7 天工作简报",
    "this_month": "本月工作简报",
    "last_30_days": "近 30 天工作简报",
    "custom": "周期工作简报",
}

STYLE_META = {
    "leader": {
        "label": "汇报领导（结论先行・正式）",
        "tone": "正式、精炼、结论先行",
        "guide": "先给总体进展与核心交付，再列重点项目成果、需拍板或风险卡点，最后附下阶段明确计划与责任时间点。",
    },
    "team": {
        "label": "团队同步（条理清晰・简洁）",
        "tone": "简洁、务实、协作导向",
        "guide": "用短句分模块同步已完成事项、跨人协同沟通与待推进任务，突出分工、截止时间与待对接方。",
    },
    "log": {
        "label": "个人复盘（详实记录）",
        "tone": "完整、客观、便于留档",
        "guide": "完整列出周期内重要邮件往来、已办结事项、等待外部回复清单与后续排期，方便日后查阅追溯。",
    },
}

_HTML_TAG = re.compile(r"<[^>]+>")
_HTML_IGNORE = re.compile(r"<(script|style)\b[^>]*>.*?</\1>", re.I | re.S)


def _clean_text(raw: str | None, limit: int = 120) -> str:
    text = _HTML_IGNORE.sub(" ", raw or "")
    text = html.unescape(_HTML_TAG.sub(" ", text))
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def _parse_day(value: str | None) -> date | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    if re.match(r"^\d{4}-\d{2}-\d{2}", raw):
        try:
            return date.fromisoformat(raw[:10])
        except ValueError:
            pass
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if dt.tzinfo is not None:
            dt = dt.astimezone()
        return dt.date()
    except ValueError:
        pass
    try:
        dt = email.utils.parsedate_to_datetime(raw)
        if dt is not None:
            if dt.tzinfo is not None:
                dt = dt.astimezone()
            return dt.date()
    except (ValueError, TypeError):
        pass
    return None


def resolve_window(
    period: str = "this_week",
    start_date: str = "",
    end_date: str = "",
    today: date | None = None,
) -> dict[str, Any]:
    """根据周期类型解析起止日期与默认标题前缀。"""
    key = (period or "this_week").strip().lower()
    if key not in PERIOD_LABELS:
        raise ValueError("不支持的简报周期")
    ref_today = today or date.today()
    if key == "this_week":
        start = ref_today - timedelta(days=ref_today.weekday())
        end = ref_today
    elif key == "last_7_days":
        start = ref_today - timedelta(days=6)
        end = ref_today
    elif key == "this_month":
        start = ref_today.replace(day=1)
        end = ref_today
    elif key == "last_30_days":
        start = ref_today - timedelta(days=29)
        end = ref_today
    else:
        try:
            start = date.fromisoformat((start_date or "").strip())
            end = date.fromisoformat((end_date or "").strip())
        except ValueError as exc:
            raise ValueError("自定义周期需要有效的 YYYY-MM-DD 起止日期") from exc
        if start > end:
            raise ValueError("开始日期不能晚于结束日期")
        if (end - start).days > 180:
            raise ValueError("单次周期简报范围最多支持 180 天")

    span_days = (end - start).days + 1
    if key in {"this_month", "last_30_days"} or (key == "custom" and span_days >= 20):
        title_prefix = "【工作月报】"
    elif key in {"this_week", "last_7_days"} or (key == "custom" and span_days <= 10):
        title_prefix = "【工作周报】"
    else:
        title_prefix = "【周期工作简报】"

    return {
        "period": key,
        "label": PERIOD_LABELS[key],
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "span_days": span_days,
        "title_prefix": title_prefix,
        "default_subject": f"{title_prefix}{start.isoformat()} ~ {end.isoformat()}",
    }


def _safe_rows(c: sqlite3.Connection, sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    try:
        return [dict(r) for r in c.execute(sql, params).fetchall()]
    except sqlite3.OperationalError as exc:
        if "no such table" in str(exc) or "no such column" in str(exc):
            return []
        raise


def _sender_label(from_name: str | None, from_addr: str | None) -> str:
    name = (from_name or "").strip()
    addr = (from_addr or "").strip()
    if name and addr and name.casefold() != addr.casefold():
        return f"{name} <{addr}>"
    return name or addr or "未知发件人"


def _waiting_days(sent_at: str | None, ref_today: date) -> int:
    day = _parse_day(sent_at)
    if day is None:
        return 0
    return max(0, (ref_today - day).days)


def collect_summary(
    period: str = "this_week",
    start_date: str = "",
    end_date: str = "",
    *,
    focus: str = "",
    include_preferences: bool = True,
    today: date | None = None,
) -> dict[str, Any]:
    """聚合指定时间窗口内的本地邮件、待办、发信跟进与项目上下文。"""
    ref_today = today or date.today()
    window = resolve_window(period, start_date, end_date, today=ref_today)
    start_d = date.fromisoformat(window["start_date"])
    end_d = date.fromisoformat(window["end_date"])

    with db.conn() as c:
        work_ctx_rows = _safe_rows(c, "SELECT email_id, project, role, note FROM work_context")
        ctx_by_email = {int(r["email_id"]): r for r in work_ctx_rows if r.get("email_id")}

        email_rows = _safe_rows(
            c,
            "SELECT id, subject, from_addr, from_name, date, created_at, category, priority, "
            "summary, snippet, is_read, is_starred, is_favorite "
            "FROM emails WHERE remote_missing=0 AND status='inbox' AND (verdict='clean' OR feedback='fp') "
            "ORDER BY id DESC LIMIT 1200",
        )
        todo_rows = _safe_rows(
            c,
            "SELECT t.id, t.email_id, t.title, t.deadline, t.status, t.created_at, t.completed_at, "
            "e.subject AS email_subject, e.from_name AS email_from_name, e.from_addr AS email_from "
            "FROM todos t LEFT JOIN emails e ON e.id=t.email_id ORDER BY t.id DESC LIMIT 600",
        )
        sent_rows = _safe_rows(
            c,
            "SELECT id, subject, to_addr, cc_addr, sent_at, created_at, reply_to_email_id, body_html "
            "FROM sent_messages WHERE status='sent' ORDER BY id DESC LIMIT 400",
        )
        followup_rows = _safe_rows(
            c,
            "SELECT f.sent_id, f.at, f.state, f.reply_id, f.created_at, "
            "s.subject, s.to_addr, s.sent_at, r.subject AS reply_subject, r.date AS reply_date, r.from_addr AS reply_from "
            "FROM sent_followups f JOIN sent_messages s ON s.id=f.sent_id "
            "LEFT JOIN emails r ON r.id=f.reply_id ORDER BY f.created_at DESC LIMIT 200",
        )

    in_window_emails: list[dict[str, Any]] = []
    todo_email_ids_done_or_open = {int(r["email_id"]) for r in todo_rows if r.get("email_id")}
    for row in email_rows:
        msg_day = _parse_day(row.get("date")) or _parse_day(row.get("created_at"))
        if msg_day is None or not (start_d <= msg_day <= end_d):
            continue
        ctx = ctx_by_email.get(int(row["id"]), {})
        category = (row.get("category") or "").strip()
        priority = (row.get("priority") or "").strip()
        importance = 0
        if ctx.get("project") or ctx.get("note"):
            importance += 4
        if priority == "高":
            importance += 3
        elif priority == "中":
            importance += 1
        if row.get("is_favorite") or row.get("is_starred"):
            importance += 3
        if int(row["id"]) in todo_email_ids_done_or_open:
            importance += 2
        if category and category not in {"广告营销", "订阅通知", "系统通知"}:
            importance += 1
        in_window_emails.append({
            "email_id": int(row["id"]),
            "date": msg_day.isoformat(),
            "subject": (row.get("subject") or "（无主题）").strip(),
            "sender": _sender_label(row.get("from_name"), row.get("from_addr")),
            "category": category or "工作沟通",
            "priority": priority or "普通",
            "summary": _clean_text(row.get("summary") or row.get("snippet") or "", 110),
            "project": (ctx.get("project") or "").strip(),
            "role": (ctx.get("role") or "").strip(),
            "note": _clean_text(ctx.get("note") or "", 90),
            "_score": importance,
        })

    in_window_emails.sort(key=lambda item: (-item["_score"], item["date"], item["email_id"]))
    important_emails = [
        {k: v for k, v in item.items() if k != "_score"}
        for item in in_window_emails[:18]
    ]

    completed_todos: list[dict[str, Any]] = []
    open_todos: list[dict[str, Any]] = []
    today_iso = ref_today.isoformat()
    for row in todo_rows:
        ctx = ctx_by_email.get(int(row["email_id"])) if row.get("email_id") else None
        item = {
            "id": int(row["id"]),
            "email_id": int(row["email_id"]) if row.get("email_id") else None,
            "title": (row.get("title") or "").strip(),
            "deadline": (row.get("deadline") or "").strip(),
            "project": ((ctx or {}).get("project") or "").strip(),
            "email_subject": (row.get("email_subject") or "").strip(),
        }
        if not item["title"]:
            continue
        if row.get("status") == "done":
            done_day = (
                _parse_day(row.get("completed_at"))
                or _parse_day(row.get("deadline"))
                or _parse_day(row.get("created_at"))
            )
            if done_day is not None and start_d <= done_day <= end_d:
                item["done_date"] = done_day.isoformat()
                completed_todos.append(item)
        else:
            dl = item["deadline"]
            item["overdue"] = bool(dl and dl < today_iso)
            open_todos.append(item)

    open_todos.sort(key=lambda t: (0 if t["overdue"] else (1 if t["deadline"] else 2), t["deadline"] or "9999-99-99", -t["id"]))

    sent_in_window: list[dict[str, Any]] = []
    for row in sent_rows:
        s_day = _parse_day(row.get("sent_at")) or _parse_day(row.get("created_at"))
        if s_day is None or not (start_d <= s_day <= end_d):
            continue
        sent_in_window.append({
            "sent_id": int(row["id"]),
            "date": s_day.isoformat(),
            "subject": (row.get("subject") or "（无主题）").strip(),
            "to_addr": (row.get("to_addr") or "").strip(),
            "snippet": _clean_text(row.get("body_html") or "", 90),
        })

    now_iso = datetime.now().isoformat(timespec="seconds")
    followups_waiting: list[dict[str, Any]] = []
    followups_replied: list[dict[str, Any]] = []
    for row in followup_rows:
        state = (row.get("state") or "").strip()
        if state == "replied":
            r_day = _parse_day(row.get("reply_date")) or _parse_day(row.get("sent_at"))
            if r_day is not None and start_d <= r_day <= end_d:
                followups_replied.append({
                    "sent_id": int(row["sent_id"]),
                    "subject": (row.get("subject") or "（无主题）").strip(),
                    "to_addr": (row.get("to_addr") or "").strip(),
                    "reply_date": r_day.isoformat(),
                    "reply_from": (row.get("reply_from") or "").strip(),
                })
        elif state == "scheduled":
            due = bool(row.get("at") and str(row["at"]) <= now_iso)
            followups_waiting.append({
                "sent_id": int(row["sent_id"]),
                "subject": (row.get("subject") or "（无主题）").strip(),
                "to_addr": (row.get("to_addr") or "").strip(),
                "sent_date": (_parse_day(row.get("sent_at")) or ref_today).isoformat(),
                "waiting_days": _waiting_days(row.get("sent_at"), ref_today),
                "due": due,
                "at": (row.get("at") or "")[:16],
            })

    followups_waiting.sort(key=lambda f: (0 if f["due"] else 1, -f["waiting_days"], -f["sent_id"]))

    projects: list[str] = []
    for bucket in (important_emails, completed_todos, open_todos):
        for entry in bucket:
            proj = (entry.get("project") or "").strip()
            if proj and proj not in projects:
                projects.append(proj)

    metrics = {
        "received_count": len(in_window_emails),
        "important_count": len([e for e in in_window_emails if e["_score"] >= 3]),
        "sent_count": len(sent_in_window),
        "todos_done_count": len(completed_todos),
        "todos_open_count": len(open_todos),
        "todos_overdue_count": sum(1 for t in open_todos if t["overdue"]),
        "followups_waiting_count": len(followups_waiting),
        "followups_due_count": sum(1 for f in followups_waiting if f["due"]),
        "followups_replied_count": len(followups_replied),
    }

    return {
        "window": window,
        "default_subject": window["default_subject"],
        "focus": (focus or "").strip(),
        "include_preferences": bool(include_preferences),
        "llm_available": bool(llm_client.available()),
        "metrics": metrics,
        "highlights": {
            "projects": projects[:10],
            "completed_todos": completed_todos[:25],
            "open_todos": open_todos[:25],
            "key_emails": important_emails,
            "sent_items": sent_in_window[:15],
            "followups_waiting": followups_waiting[:15],
            "followups_replied": followups_replied[:12],
        },
    }


def _briefing_style(style: str) -> str:
    key = (style or "leader").strip().lower()
    if key not in STYLE_META:
        raise ValueError("不支持的汇报风格")
    return key


def build_local_briefing(
    summary: dict[str, Any],
    *,
    style: str = "leader",
    focus: str = "",
) -> str:
    """不依赖外部模型，依据聚合数据生成结构化 Markdown 周期简报。"""
    style_key = _briefing_style(style)
    w = summary["window"]
    m = summary["metrics"]
    h = summary["highlights"]
    focus_text = (focus or summary.get("focus") or "").strip()

    title = f"## {w['label']}（{w['start_date']} ~ {w['end_date']}）"
    if style_key == "team":
        overview = (
            f"本周期共处理收件 **{m['received_count']}** 封（重点 **{m['important_count']}** 封），"
            f"发出邮件 **{m['sent_count']}** 封；已完成待办 **{m['todos_done_count']}** 项，"
            f"待推进 **{m['todos_open_count']}** 项（逾期 {m['todos_overdue_count']} 项），"
            f"发信待跟进 **{m['followups_waiting_count']}** 项。"
        )
    else:
        overview = (
            f"本周期累计完成待办 **{m['todos_done_count']}** 项、发出工作邮件 **{m['sent_count']}** 封，"
            f"收到并梳理邮件 **{m['received_count']}** 封（重点 **{m['important_count']}** 封）；"
            f"当前仍有 **{m['todos_open_count']}** 项待办推进中（其中逾期 {m['todos_overdue_count']} 项）、"
            f"**{m['followups_waiting_count']}** 项外发邮件待对方反馈。"
        )

    lines = [title, "", overview]
    if focus_text:
        lines.append(f"- 汇报侧重点：{focus_text}")
    if h["projects"]:
        lines.append(f"- 涉及重点事项 / 项目：{'、'.join(h['projects'])}")

    has_any = any([
        m["received_count"],
        m["sent_count"],
        m["todos_done_count"],
        m["todos_open_count"],
        m["followups_waiting_count"],
        m["followups_replied_count"],
    ])
    if not has_any:
        lines.extend([
            "",
            "### 本周期暂无可汇总的工作记录",
            "- 当前时间范围内没有收发邮件、已办/待办任务或发信跟进记录。",
            "- 可切换「本月 / 近 30 天」周期或先同步邮箱后再生成。",
        ])
        return "\n".join(lines)

    lines.extend(["", "### 一、本期完成与核心推进"])
    if h["completed_todos"]:
        for todo in h["completed_todos"][:12]:
            proj = f"〔{todo['project']}〕" if todo.get("project") else ""
            src = f" [email_id:{todo['email_id']}]" if todo.get("email_id") else ""
            lines.append(f"- {proj}{todo['title']}{src}")
    if h["followups_replied"]:
        for item in h["followups_replied"][:8]:
            lines.append(f"- 已收到回复：{item['subject']}（对接人：{item['to_addr'] or item['reply_from']}，回复于 {item['reply_date']}）")
    if not h["completed_todos"] and not h["followups_replied"]:
        lines.append("- 本期已完成事项暂无标记，重点进展见下方往来邮件与发件记录。")

    lines.extend(["", "### 二、重点邮件与对外沟通"])
    if h["key_emails"]:
        limit = 12 if style_key == "log" else 8
        for em in h["key_emails"][:limit]:
            proj = f"〔{em['project']}〕" if em.get("project") else ""
            note = f" — {em['note']}" if em.get("note") else (f" — {em['summary']}" if em.get("summary") else "")
            lines.append(f"- **{em['subject']}**（{em['sender']}，{em['date']}）{proj}{note} [email_id:{em['email_id']}]")
    if h["sent_items"]:
        sent_limit = 8 if style_key == "log" else 5
        for sent in h["sent_items"][:sent_limit]:
            lines.append(f"- 已发出：{sent['subject']}（收件人：{sent['to_addr'] or '未填写'}，{sent['date']}）")
    if not h["key_emails"] and not h["sent_items"]:
        lines.append("- 本周期暂无重点收发记录。")

    lines.extend(["", "### 三、待跟进与风险卡点"])
    if h["followups_waiting"]:
        for fw in h["followups_waiting"][:10]:
            flag = "[⚠️过期] " if fw["due"] else ""
            lines.append(f"- {flag}等待回复（已等 {fw['waiting_days']} 天）：{fw['subject']}（收件人：{fw['to_addr'] or '未知'}）")
    overdue_todos = [t for t in h["open_todos"] if t["overdue"]]
    if overdue_todos:
        for todo in overdue_todos[:8]:
            src = f" [email_id:{todo['email_id']}]" if todo.get("email_id") else ""
            lines.append(f"- [⚠️过期] 截止 {todo['deadline']}：{todo['title']}{src}")
    if not h["followups_waiting"] and not overdue_todos:
        lines.append("- 暂无超期卡点或高风险未闭环跟进。")

    lines.extend(["", "### 四、下阶段计划与待办"])
    upcoming = [t for t in h["open_todos"] if not t["overdue"]]
    if upcoming:
        for todo in upcoming[:12]:
            proj = f"〔{todo['project']}〕" if todo.get("project") else ""
            dl = f"（截止 {todo['deadline']}）" if todo.get("deadline") else ""
            src = f" [email_id:{todo['email_id']}]" if todo.get("email_id") else ""
            lines.append(f"- {proj}{todo['title']}{dl}{src}")
    elif overdue_todos:
        lines.append("- 优先清理上述已逾期待办并逐一核销。")
    else:
        lines.append("- 当前待办均已清零，持续跟进新收邮件与常规周期工作。")

    return "\n".join(lines)


def _preference_prompt_context(style_key: str, include_preferences: bool) -> str:
    if not include_preferences:
        return ""
    blocks = []
    mem_ctx = work_memory.approved_context("起草工作周报月报")
    if mem_ctx:
        blocks.append(mem_ctx)
    else:
        from . import work_assistant
        style_text = (work_assistant.preferences().get("style") or "").strip()
        if style_text:
            blocks.append("邮件写作要求：\n" + style_text)
    if style_key == "leader":
        try:
            presets = recipient_profiles.role_presets()
            leader = presets.get("leader") if isinstance(presets, dict) else None
            if leader and (leader.get("style_hint") or leader.get("tone")):
                blocks.append(
                    f"汇报领导角色写作预设：语气「{leader.get('tone', '')}」，写作要求：{leader.get('style_hint', '')}"
                )
        except sqlite3.OperationalError:
            pass
    return "\n\n".join(blocks)[:3500]


def _build_llm_messages(summary: dict[str, Any], style_key: str, focus: str) -> list[dict[str, str]]:
    meta = STYLE_META[style_key]
    pref_ctx = _preference_prompt_context(style_key, summary.get("include_preferences", True))
    compact_payload = {
        "window": summary["window"],
        "metrics": summary["metrics"],
        "focus": (focus or summary.get("focus") or "").strip(),
        "highlights": summary["highlights"],
    }
    system_parts = [
        "你是用户的个人办公邮件与待办秘书，负责基于本地真实记录起草中文工作周报/月报。",
        f"本次汇报风格：{meta['label']}（语气：{meta['tone']}）。{meta['guide']}",
        "严格要求：",
        "1. 只能使用下方 JSON 中的真实统计数字、邮件主题、摘要、待办和跟进记录；绝对不能编造未出现的数据、项目名或人员。",
        "2. 用简洁清晰的 Markdown 分四部分输出（可按真实内容删减空段落）：概览首段 + 一、本期完成与核心推进 / 二、重点邮件与对外沟通 / 三、待跟进与风险卡点 / 四、下阶段计划与待办。",
        "3. 引用输入里某封收件时，在该条末尾原样保留 `[email_id:数字]` 标记，方便在工作台内点击查看来源邮件；超期待办或逾期跟进可用 `[⚠️过期]` 标注。",
        "4. 如果输入数据为空，只如实说明该周期暂无邮件和待办记录，不要凑字数。",
    ]
    if pref_ctx:
        system_parts.append("\n用户长期写作偏好（仅影响措辞与组织方式，不能添加虚假事实）：\n" + pref_ctx)
    return [
        {"role": "system", "content": "\n".join(system_parts)},
        {"role": "user", "content": "请根据以下周期汇总数据生成工作简报：\n" + json.dumps(compact_payload, ensure_ascii=False)},
    ]


def generate_briefing(
    *,
    period: str = "this_week",
    start_date: str = "",
    end_date: str = "",
    style: str = "leader",
    focus: str = "",
    include_preferences: bool = True,
    mode: str = "auto",
    save: bool = True,
    today: date | None = None,
) -> dict[str, Any]:
    """生成周期简报（支持 auto / ai / local），可选自动保存进历史表。"""
    style_key = _briefing_style(style)
    mode_key = (mode or "auto").strip().lower()
    if mode_key not in {"auto", "ai", "local"}:
        raise ValueError("不支持的生成模式")
    summary = collect_summary(
        period, start_date, end_date, focus=focus, include_preferences=include_preferences, today=today
    )

    content = ""
    source = "local"
    if mode_key in {"auto", "ai"}:
        if not llm_client.available():
            if mode_key == "ai":
                raise ValueError("模型尚未配置或不可用，可改用本地快速汇总生成")
        else:
            messages = _build_llm_messages(summary, style_key, focus)
            result = llm_client.chat_completion(
                messages,
                temperature=0.3,
                max_tokens=llm_client.config.LLM_DIGEST_MAX_TOKENS,
                timeout=llm_client.config.LLM_DIGEST_TIMEOUT,
            )
            content = ((result or {}).get("choices", [{}])[0].get("message", {}).get("content") or "").strip()
            if content:
                source = "ai"
            elif mode_key == "ai":
                raise ValueError("AI 简报生成失败，请检查模型连接或改用本地汇总")

    if not content:
        content = build_local_briefing(summary, style=style_key, focus=focus)
        source = "local"

    saved = None
    if save:
        saved = save_briefing(
            period=summary["window"]["period"],
            start_date=summary["window"]["start_date"],
            end_date=summary["window"]["end_date"],
            style=style_key,
            title=summary["default_subject"],
            content=content,
            metrics=summary["metrics"],
            source=source,
        )
    return {"summary": summary, "style": style_key, "source": source, "content": content, "briefing": saved}


def stream_briefing(
    *,
    period: str = "this_week",
    start_date: str = "",
    end_date: str = "",
    style: str = "leader",
    focus: str = "",
    include_preferences: bool = True,
    mode: str = "auto",
    save: bool = True,
    today: date | None = None,
):
    """流式生成周期简报：逐段 yield 事件字典（meta / delta / done / error）。"""
    style_key = _briefing_style(style)
    mode_key = (mode or "auto").strip().lower()
    if mode_key not in {"auto", "ai", "local"}:
        raise ValueError("不支持的生成模式")

    summary = collect_summary(
        period, start_date, end_date, focus=focus, include_preferences=include_preferences, today=today
    )
    use_ai = mode_key in {"auto", "ai"} and llm_client.available()
    if mode_key == "ai" and not llm_client.available():
        yield {"type": "error", "message": "模型尚未配置或不可用，可改用本地快速汇总生成"}
        return

    yield {"type": "meta", "summary": summary, "style": style_key, "source": "ai" if use_ai else "local"}

    parts: list[str] = []
    source = "local"
    if use_ai:
        messages = _build_llm_messages(summary, style_key, focus)
        emitted = False
        try:
            for delta in llm_client.chat_completion_stream(
                messages,
                temperature=0.3,
                max_tokens=llm_client.config.LLM_DIGEST_MAX_TOKENS,
                timeout=llm_client.config.LLM_DIGEST_TIMEOUT,
                require_completion=True,
            ):
                if delta:
                    emitted = True
                    parts.append(delta)
                    yield {"type": "delta", "content": delta}
            if emitted:
                source = "ai"
        except Exception as exc:
            log.warning("周期简报流式生成失败: %s", exc)
            if emitted:
                yield {"type": "error", "message": "简报流式生成提前中断，请重试或改用本地汇总"}
                return
            if mode_key == "ai":
                yield {"type": "error", "message": "AI 简报生成失败，请检查模型配置或改用本地汇总"}
                return

    if not parts:
        local_text = build_local_briefing(summary, style=style_key, focus=focus)
        source = "local"
        parts.append(local_text)
        yield {"type": "delta", "content": local_text}

    full_content = "".join(parts).strip()
    saved = None
    if save and full_content:
        saved = save_briefing(
            period=summary["window"]["period"],
            start_date=summary["window"]["start_date"],
            end_date=summary["window"]["end_date"],
            style=style_key,
            title=summary["default_subject"],
            content=full_content,
            metrics=summary["metrics"],
            source=source,
        )
    yield {
        "type": "done",
        "source": source,
        "content": full_content,
        "summary": summary,
        "briefing": saved,
    }


def _decode_briefing(row: sqlite3.Row | dict[str, Any] | None) -> dict[str, Any] | None:
    if not row:
        return None
    item = dict(row)
    try:
        item["metrics"] = json.loads(item.pop("metrics_json", "{}") or "{}")
    except (ValueError, TypeError):
        item["metrics"] = {}
    return item


def list_briefings(limit: int = 30) -> list[dict[str, Any]]:
    with db.conn() as c:
        rows = _safe_rows(
            c,
            "SELECT id, period, start_date, end_date, style, title, source, metrics_json, created_at "
            "FROM periodic_briefings ORDER BY created_at DESC, id DESC LIMIT ?",
            (max(1, min(int(limit), 100)),),
        )
    out = []
    for row in rows:
        item = _decode_briefing(row)
        if item:
            out.append(item)
    return out


def get_briefing(briefing_id: int) -> dict[str, Any] | None:
    with db.conn() as c:
        row = c.execute("SELECT * FROM periodic_briefings WHERE id=?", (int(briefing_id),)).fetchone()
        return _decode_briefing(row)


def save_briefing(
    *,
    period: str = "this_week",
    start_date: str = "",
    end_date: str = "",
    style: str = "leader",
    title: str = "",
    content: str = "",
    metrics: dict[str, Any] | None = None,
    source: str = "local",
    briefing_id: int | None = None,
) -> dict[str, Any]:
    text = (content or "").strip()
    if not text:
        raise ValueError("简报内容不能为空")
    style_key = _briefing_style(style)
    clean_title = (title or "").strip()[:200] or f"工作简报 {start_date} ~ {end_date}".strip()
    now = datetime.now().isoformat(timespec="seconds")
    metrics_json = json.dumps(metrics or {}, ensure_ascii=False)
    with db.conn() as c:
        if briefing_id:
            existing = c.execute("SELECT id FROM periodic_briefings WHERE id=?", (int(briefing_id),)).fetchone()
            if not existing:
                raise ValueError("简报记录不存在")
            c.execute(
                "UPDATE periodic_briefings SET title=?, content=?, style=?, period=?, start_date=?, end_date=?, source=? WHERE id=?",
                (clean_title, text, style_key, period, start_date, end_date, source, int(briefing_id)),
            )
            target_id = int(briefing_id)
        else:
            cur = c.execute(
                "INSERT INTO periodic_briefings(period, start_date, end_date, style, title, content, metrics_json, source, created_at) "
                "VALUES(?,?,?,?,?,?,?,?,?)",
                (period, start_date, end_date, style_key, clean_title, text, metrics_json, source, now),
            )
            target_id = int(cur.lastrowid)
        row = c.execute("SELECT * FROM periodic_briefings WHERE id=?", (target_id,)).fetchone()
        return _decode_briefing(row) or {"id": target_id}


def delete_briefing(briefing_id: int) -> bool:
    with db.conn() as c:
        cur = c.execute("DELETE FROM periodic_briefings WHERE id=?", (int(briefing_id),))
        return cur.rowcount > 0
