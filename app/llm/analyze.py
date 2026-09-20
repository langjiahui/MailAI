"""LLM 分析入口：钓鱼复核、工作分析、每日摘要。"""
import hashlib
import json
import logging

from .. import config, db, parser
from . import client, prompts

log = logging.getLogger(__name__)
_CACHE_VERSION = "mail-analysis-v3"


def _strict_bool(value, name: str) -> bool:
    if type(value) is not bool:
        raise ValueError(f"模型字段 {name} 必须是布尔值")
    return value


def _confidence(value) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("模型字段 confidence 必须是 0 到 1 的数字")
    result = float(value)
    if not 0 <= result <= 1:
        raise ValueError("模型字段 confidence 超出范围")
    return result


def _string_list(value, name: str) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError(f"模型字段 {name} 必须是字符串列表")
    return [item[:300] for item in value[:6]]


def _cache_key(kind: str, email: dict, context: str = "") -> str:
    """Stable per-account cache key; model/prompt changes invalidate old results."""
    payload = {
        "version": _CACHE_VERSION,
        "kind": kind,
        "model": config.LLM_MODEL,
        "message_id": email.get("message_id") or "",
        "subject": email.get("subject") or "",
        "from_addr": email.get("from_addr") or "",
        "body": email.get("body_text") or "",
        "context": context,
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _cached(kind: str, email: dict, context: str, producer):
    key = _cache_key(kind, email, context)
    cached = db.get_ai_analysis_cache(key)
    if cached is not None:
        return cached
    result = producer()
    if isinstance(result, dict):
        db.save_ai_analysis_cache(key, kind, config.LLM_MODEL, result)
    return result


def _redacted(email: dict) -> dict:
    e = dict(email)
    body = e.get("body_text", "")
    e["body_text"] = "" if e.get("body_decode_warning") or parser.looks_corrupted(body) else parser.redact(body)
    return e


def security_review(email: dict, rule_summary: str, thread_summary: str = "") -> dict | None:
    """返回 {'phishing': bool, 'confidence': float, 'is_spam': bool, 'reasons': [], 'evidence': []}"""
    if not client.available() or email.get("body_decode_warning"):
        return None
    context = f"{rule_summary}\n---thread---\n{thread_summary}"
    key = _cache_key("security", email, context)
    result = db.get_ai_analysis_cache(key)
    from_cache = result is not None
    if result is None:
        result = client.chat_json(
            prompts.PHISH_SYSTEM,
            prompts.phish_user(_redacted(email), rule_summary, thread_summary),
        )
    if not result:
        return None
    try:
        validated = {
            "phishing": _strict_bool(result.get("phishing"), "phishing"),
            "confidence": _confidence(result.get("confidence")),
            "is_spam": _strict_bool(result.get("is_spam"), "is_spam"),
            "reasons": _string_list(result.get("reasons"), "reasons"),
            "evidence": _string_list(result.get("evidence"), "evidence"),
        }
        if not from_cache:
            db.save_ai_analysis_cache(key, "security", config.LLM_MODEL, validated)
        return validated
    except ValueError as exc:
        log.warning("忽略结构无效的模型安全复核结果: %s", exc)
        return None


def thread_summary(context_emails: list[str]) -> str:
    """根据历史邮件上下文生成会话摘要。"""
    if not client.available():
        return "\n".join(context_emails)
    messages = [
        {"role": "system", "content": prompts.THREAD_SUMMARY_SYSTEM},
        {"role": "user", "content": prompts.thread_summary_user(context_emails)},
    ]
    result = client.chat_completion(messages, temperature=0.3)
    if not result:
        return "\n".join(context_emails)
    return result.get("choices", [{}])[0].get("message", {}).get("content") or "\n".join(context_emails)


def work_analysis(email: dict) -> dict | None:
    """返回 {'category', 'priority', 'summary', 'todos': [{title, deadline}]}"""
    if not client.available() or email.get("body_decode_warning"):
        return None
    result = _cached(
        "work", email, "",
        lambda: client.chat_json(prompts.ANALYZE_SYSTEM,
                                 prompts.analyze_user(_redacted(email))),
    )
    if not result:
        return None
    todos = []
    for t in (result.get("todos") or [])[:8]:
        if isinstance(t, dict) and t.get("title"):
            todos.append({"title": str(t["title"])[:100],
                          "deadline": t.get("deadline") or None})
    summary = str(result.get("summary") or "")[:200]
    if parser.looks_corrupted(summary):
        summary = str(email.get("snippet") or "")[:200]
    return {
        "category": str(result.get("category") or "其他")[:20],
        "priority": str(result.get("priority") or "中")[:4],
        "summary": summary,
        "todos": todos,
    }


def _local_digest(items: list[dict]) -> str:
    """LLM 不可用或超时的本地兜底日报。"""
    from datetime import date
    today = date.today().isoformat()
    today_items = [it for it in items if it.get("date", "").startswith(today)]
    overdue = []
    today_todos = []
    recent = []
    for it in items:
        for t in (it.get("todos") or []):
            status = t.get("status") or "未指定"
            line = f"- [{status}] {t.get('title', '')}（截止：{t.get('deadline') or '未指定'}）— {it.get('from_addr', '')}《{it.get('subject', '')}》 [email_id:{it.get('email_id','')}]"
            if status == "⚠️过期":
                overdue.append(line)
            elif status == "今日":
                today_todos.append(line)
            else:
                recent.append(line)
    high = [it for it in today_items if (it.get("priority") == "高" or (it.get("score") or 0) >= 35)]

    lines = [f"## 今日概览", f"今日共 {len(today_items)} 封邮件，{len(overdue)} 条过期待办，{len(today_todos)} 条今日待办。（LLM 暂时不可用，此日报为本地兜底生成）", ""]
    lines.append("## 需要关注")
    if high:
        for it in high:
            lines.append(f"- [{it.get('priority','?')}|风险{it.get('score',0)}] {it.get('from_addr','')}《{it.get('subject','')}》: {it.get('summary','')} [email_id:{it.get('email_id','')}]")
    else:
        lines.append("- 今日无高优先级或高风险邮件")
    lines.append("")
    lines.append("## 待办清单")
    if overdue:
        lines.append("### ⚠️ 过期待办")
        lines.extend(overdue[:50])
        if len(overdue) > 50:
            lines.append(f"- ……还有 {len(overdue) - 50} 条过期待办")
    if today_todos:
        lines.append("### [今日] 待办")
        lines.extend(today_todos[:20])
        if len(today_todos) > 20:
            lines.append(f"- ……还有 {len(today_todos) - 20} 条今日待办")
    if recent:
        lines.append("### [近期] 待办")
        lines.extend(recent[:20])
        if len(recent) > 20:
            lines.append(f"- ……还有 {len(recent) - 20} 条近期待办")
    if not overdue and not today_todos and not recent:
        lines.append("- 无待办")
    lines.append("")
    lines.append("## 安全情况")
    phishing = [it for it in today_items if it.get("verdict") == "phishing" or (it.get("score") or 0) >= 70]
    suspicious = [it for it in today_items if it.get("verdict") == "suspicious" or 35 <= (it.get("score") or 0) < 70]
    lines.append(f"- 今日钓鱼/高风险：{len(phishing)} 封，可疑：{len(suspicious)} 封")
    return "\n".join(lines)


def daily_digest(items: list[dict]) -> str:
    if not items:
        return ""
    from datetime import date
    today = date.today().isoformat()
    # 摘要场景只传列表字段，不传正文
    if client.available():
        messages = [
            {"role": "system", "content": prompts.DIGEST_SYSTEM.format(today=today)},
            {"role": "user", "content": prompts.digest_user_compact(items, today)},
        ]
        result = client.chat_completion(
            messages,
            temperature=0.3,
            max_tokens=client.config.LLM_DIGEST_MAX_TOKENS,
            timeout=client.config.LLM_DIGEST_TIMEOUT,
        )
        if result:
            content = result.get("choices", [{}])[0].get("message", {}).get("content")
            if content:
                return content
        log.warning("LLM 日报生成失败，使用本地兜底")
    return _local_digest(items)


def daily_digest_stream(items: list[dict]):
    """流式版日报：逐段产出文本 delta。

    LLM 不可用或流式请求在产出任何内容前失败时，一次性产出本地兜底日报；
    若已产出部分内容后中断，则停止产出（调用方保留已有内容，不入库）。
    """
    if not items:
        return
    from datetime import date
    today = date.today().isoformat()
    if client.available():
        messages = [
            {"role": "system", "content": prompts.DIGEST_SYSTEM.format(today=today)},
            {"role": "user", "content": prompts.digest_user_compact(items, today)},
        ]
        emitted = False
        try:
            for delta in client.chat_completion_stream(
                messages,
                temperature=0.3,
                max_tokens=client.config.LLM_DIGEST_MAX_TOKENS,
                timeout=client.config.LLM_DIGEST_TIMEOUT,
            ):
                if delta:
                    emitted = True
                    yield delta
        except Exception:
            if emitted:
                log.exception("LLM 日报流式生成中断，保留已生成部分")
                return
            log.exception("LLM 日报流式生成失败，使用本地兜底")
        if emitted:
            return
        log.warning("LLM 日报生成失败，使用本地兜底")
    fallback = _local_digest(items)
    if fallback:
        yield fallback
