"""助手受控操作：白名单动作的提议(proposal)与执行。

设计红线：助手永远不直接执行操作。它在回答中附带一张"建议操作卡片"，
用户在界面明确确认后，前端才把卡片内容提交给
/api/assistant/actions/execute 执行；所有执行都以
actor="assistant_confirmed" 写入审计日志，与真人操作(actor="user")区分。

白名单只有三类低风险动作：
  - create_todo  创建待办
  - draft_reply  创建回复草稿（只是草稿，发送仍需用户在撰写器里手动完成）
  - mark_read    标记已读
执行入口对每个动作的参数做服务端校验，客户端传入的白名单外动作一律拒绝。
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta

from . import config, db

log = logging.getLogger(__name__)

ACTION_TYPES = ("create_todo", "draft_reply", "mark_read")
_MAX_MARK_READ = 200
_MAX_TITLE = 200

_TODO_TRIGGER = re.compile(r"(?:帮我|请|麻烦)?(?:创建|新建|添加|加|建|记)个?(待办|任务|提醒)|提醒我")
_MARK_READ_TRIGGER = re.compile(r"(标记|标为|设为|全部|都|全设).{0,4}已读|已读(掉|完|所有|全部)")
_REPLY_TRIGGER = re.compile(r"(帮我|请|麻烦)?(回复|答复|回一封|回个|写封回)")

_WEEKDAYS = {"一": 0, "二": 1, "三": 2, "四": 3, "五": 4, "六": 5, "日": 6, "天": 6}


def _parse_deadline(text: str) -> str | None:
    """从自然语言里提取截止日期（ISO 日期），识别不到返回 None。"""
    today = datetime.now().date()
    if "后天" in text:
        return (today + timedelta(days=2)).isoformat()
    if "明天" in text:
        return (today + timedelta(days=1)).isoformat()
    if "今天" in text or "今日" in text:
        return today.isoformat()
    m = re.search(r"下?周([一二三四五六日天])", text) or re.search(r"下?星期([一二三四五六日天])", text)
    if m:
        target = _WEEKDAYS[m.group(1)]
        days = (target - today.weekday()) % 7
        if days == 0 or "下" in m.group(0):
            days += 7
        return (today + timedelta(days=days)).isoformat()
    m = re.search(r"(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]", text)
    if m:
        month, day = int(m.group(1)), int(m.group(2))
        year = today.year
        try:
            candidate = datetime(year, month, day).date()
        except ValueError:
            return None
        if candidate < today:
            candidate = datetime(year + 1, month, day).date()
        return candidate.isoformat()
    return None


def _todo_title(question: str) -> str:
    """去掉触发词后剩余的待办内容。"""
    title = _TODO_TRIGGER.sub("", question)
    title = re.sub(r"^(帮我|请|麻烦|一下|把|将)", "", title).strip("，。,.:： ")
    return title[:_MAX_TITLE]


def detect_proposal(question: str, email_ids: list[int] | None = None) -> dict | None:
    """识别用户问题里的可操作意图，返回建议操作卡片；识别不到返回 None。

    一次只提议一个动作，优先级：创建待办 > 标记已读 > 回复草稿。
    """
    question = (question or "").strip()
    if not question:
        return None
    ids = [int(i) for i in (email_ids or []) if isinstance(i, int) or str(i).isdigit()]

    if _TODO_TRIGGER.search(question):
        title = _todo_title(question)
        if not title:
            return None
        deadline = _parse_deadline(question)
        params = {"title": title}
        if deadline:
            params["deadline"] = deadline
        if ids:
            params["email_id"] = ids[0]
        summary = f"创建待办：{title}" + (f"（截止 {deadline}）" if deadline else "")
        return {"type": "create_todo", "summary": summary, "params": params,
                "requires_confirmation": True}

    if _MARK_READ_TRIGGER.search(question):
        if re.search(r"(全部|所有|这些|都)", question):
            with db.conn() as c:
                targets = [r[0] for r in c.execute(
                    "SELECT id FROM emails WHERE remote_missing=0 AND is_read=0 "
                    "AND status='inbox' ORDER BY date DESC LIMIT ?", (_MAX_MARK_READ,))]
        else:
            targets = ids[:_MAX_MARK_READ]
        if not targets:
            return None
        return {"type": "mark_read",
                "summary": f"将 {len(targets)} 封邮件标记为已读",
                "params": {"email_ids": targets}, "requires_confirmation": True}

    if _REPLY_TRIGGER.search(question) and ids:
        row = db.get_email(ids[0])
        if row:
            return {"type": "draft_reply",
                    "summary": f"创建回复草稿给 {row.get('from_addr') or '发件人'}",
                    "params": {"email_id": ids[0]}, "requires_confirmation": True}
    return None


def _execute_create_todo(params: dict) -> dict:
    title = str(params.get("title") or "").strip()[:_MAX_TITLE]
    if not title:
        raise ValueError("待办内容不能为空")
    deadline = params.get("deadline")
    if deadline:
        deadline = str(deadline)[:10]
        try:
            datetime.strptime(deadline, "%Y-%m-%d")
        except ValueError:
            raise ValueError("截止日期格式应为 YYYY-MM-DD")
    email_id = params.get("email_id")
    if email_id is not None:
        email_id = int(email_id)
        if not db.get_email(email_id):
            raise ValueError("关联邮件不存在")
    db.add_todos(email_id, [{"title": title, "deadline": deadline}])
    db.add_audit_log(email_id, action="assistant_create_todo", actor="assistant_confirmed",
                     reason=f"用户确认助手建议：创建待办「{title}」")
    return {"ok": True, "title": title, "deadline": deadline}


def _execute_mark_read(params: dict) -> dict:
    raw_ids = params.get("email_ids")
    if not isinstance(raw_ids, list) or not raw_ids:
        raise ValueError("缺少要标记的邮件")
    ids = []
    for value in raw_ids[:_MAX_MARK_READ]:
        try:
            ids.append(int(value))
        except (TypeError, ValueError):
            raise ValueError("邮件 id 无效")
    existing = [i for i in ids if db.get_email(i)]
    if not existing:
        raise ValueError("邮件不存在")
    db.queue_seen_sync(existing, True)
    db.add_audit_log(None, action="assistant_mark_read", actor="assistant_confirmed",
                     reason=f"用户确认助手建议：标记 {len(existing)} 封邮件已读",
                     meta={"email_ids": existing})
    return {"ok": True, "marked": len(existing)}


def _execute_draft_reply(params: dict) -> dict:
    try:
        email_id = int(params.get("email_id"))
    except (TypeError, ValueError):
        raise ValueError("缺少要回复的邮件")
    row = db.get_email(email_id)
    if not row:
        raise ValueError("邮件不存在")
    # 收件人/主题一律由服务端从原邮件推导，防止卡片参数被篡改投向其他地址
    to_addr = row.get("from_addr") or ""
    if not to_addr:
        raise ValueError("原邮件缺少发件人地址")
    subject = row.get("subject") or ""
    if not subject.lower().startswith("re:"):
        subject = f"Re: {subject}"
    draft_id = db.save_draft({
        "to_addr": to_addr, "subject": subject,
        "body_html": "<p><br></p>",
        "reply_to_email_id": email_id, "mode": "reply",
        "in_reply_to": row.get("message_id") or "",
        "references": " ".join(x for x in (row.get("references_header"), row.get("message_id")) if x),
    })
    db.add_audit_log(email_id, action="assistant_draft_reply", actor="assistant_confirmed",
                     reason=f"用户确认助手建议：创建回复草稿给 {to_addr}",
                     meta={"draft_id": draft_id})
    return {"ok": True, "draft_id": draft_id, "to_addr": to_addr}


def execute_action(action_type: str, params: dict | None) -> dict:
    """校验并执行用户已确认的白名单动作。"""
    params = params or {}
    if action_type == "create_todo":
        return _execute_create_todo(params)
    if action_type == "mark_read":
        return _execute_mark_read(params)
    if action_type == "draft_reply":
        return _execute_draft_reply(params)
    raise ValueError(f"不支持的操作类型（白名单：{', '.join(ACTION_TYPES)}）")
