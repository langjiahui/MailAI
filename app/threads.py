"""邮件会话（Thread）管理：归组、摘要、历史上下文。"""
import logging

from . import db, parser
from .llm import analyze as llm_analyze
from .llm import client as llm_client

log = logging.getLogger(__name__)


def get_thread_id(email: dict) -> str:
    """返回 email 的 thread_id；解析器已生成，这里兜底。"""
    return email.get("thread_id") or email.get("message_id") or f"uid-{email.get('uid', 0)}"


def update_thread(email_id: int, email: dict, *, allow_ai: bool = True):
    """把邮件加入 thread 并更新摘要。"""
    thread_id = get_thread_id(email)
    if not thread_id:
        return

    existing = db.get_thread(thread_id)
    message_ids = existing.get("message_ids") if existing else []
    participant_domains = existing.get("participant_domains") if existing else []

    mid = email.get("message_id", "")
    if mid and mid not in message_ids:
        message_ids.insert(0, mid)
    message_ids = message_ids[:50]  # 限制长度

    from_domain = ""
    if email.get("from_addr") and "@" in email["from_addr"]:
        from_domain = email["from_addr"].split("@", 1)[1].lower()
    if from_domain and from_domain not in participant_domains:
        participant_domains.append(from_domain)
    participant_domains = participant_domains[:20]

    summary = _summarize_thread(thread_id, email, allow_ai=allow_ai)
    db.upsert_thread(thread_id, message_ids, participant_domains, summary, email_id)


def get_thread_summary(thread_id: str) -> str:
    """供 LLM 输入的线程摘要。"""
    if not thread_id:
        return ""
    existing = db.get_thread(thread_id)
    if existing and existing.get("summary"):
        return existing["summary"]
    # 没有摘要时，用最近 3 封邮件的主题拼接
    emails = db.list_thread_emails(thread_id, limit=3)
    if not emails:
        return ""
    lines = []
    for e in reversed(emails):  # 按时间正序
        lines.append(f"- [{e.get('date', '')}] {e.get('from_addr', '')}: {e.get('subject', '')}")
    return "\n".join(lines)


def _summarize_thread(thread_id: str, current_email: dict, *, allow_ai: bool = True) -> str:
    """用 LLM 生成会话摘要；失败时返回简单拼接。"""
    emails = db.list_thread_emails(thread_id, limit=10)
    if not emails:
        return ""

    # 如果只有当前邮件，不需要摘要
    if len(emails) <= 1:
        return ""

    # 优先使用历史邮件（不含当前邮件正文，避免重复）
    context = []
    for e in reversed(emails):
        if e.get("id") == current_email.get("id"):
            continue
        body = (e.get("body_text") or "")[:400]
        context.append(
            f"发件人: {e.get('from_addr', '')}\n"
            f"主题: {e.get('subject', '')}\n"
            f"时间: {e.get('date', '')}\n"
            f"正文摘要: {body[:200]}"
        )
        if len(context) >= 3:
            break

    if not context:
        return ""

    if not allow_ai or not llm_client.available():
        return "\n".join(context)

    try:
        return llm_analyze.thread_summary(context)
    except Exception:
        log.exception("生成 thread 摘要失败")
        return "\n".join(context)


def build_thread_context(email: dict) -> dict:
    """构建供前端或 LLM 使用的会话上下文对象。"""
    thread_id = get_thread_id(email)
    if not thread_id:
        return {"thread_id": "", "history_count": 0, "summary": ""}
    emails = db.list_thread_emails(thread_id, limit=10)
    # 排除当前邮件
    history = [e for e in emails if e.get("id") != email.get("id")]
    if not history:
        return {
            "thread_id": thread_id,
            "history_count": 0,
            "summary": "",
            "history": [],
        }
    return {
        "thread_id": thread_id,
        "history_count": len(history),
        "summary": get_thread_summary(thread_id),
        "history": [
            {
                "id": e.get("id"),
                "date": e.get("date"),
                "from_addr": e.get("from_addr"),
                "from_name": e.get("from_name"),
                "subject": e.get("subject"),
                "snippet": e.get("snippet"),
                "verdict": e.get("verdict"),
                "status": e.get("status"),
            }
            for e in reversed(history[:5])
        ],
    }
