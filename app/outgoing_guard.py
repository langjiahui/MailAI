"""Focused checks for send mistakes that are worth interrupting."""
from __future__ import annotations

import re

from . import config, db
from .security import policy


_SENSITIVE = re.compile(
    r"(?:密码|口令|验证码|身份证|银行卡|薪资|报价底价|合同金额|客户名单|"
    r"password|verification code|identity card|bank card)", re.I,
)
_MONEY = re.compile(r"(?:付款|打款|转账|收款账号|银行账户|payment|wire transfer|bank account)", re.I)
_ATTACHMENT_MENTION = re.compile(
    r"(?:见|查看|查收|参见|详见|请收|已附|附上|随信附).{0,4}附件|附件\s*[:：]|"
    r"附件(?:中|里|内|所示)|please\s+(?:see|find)\s+(?:the\s+)?attach(?:ed|ment)|"
    r"(?:is|are)\s+attached|attachment\s*[:：]", re.I,
)
_DANGEROUS_ATTACHMENT = re.compile(r"\.(?:exe|msi|scr|bat|cmd|com|js|vbs|ps1|jar|lnk|docm|xlsm)$", re.I)


def _issue(level: str, code: str, message: str, reason: str = "", source: str = "本地检查") -> dict:
    return {"level": level, "code": code, "message": message, "reason": reason, "source": source}


def local_issues(payload: dict, recipients: list[str]) -> list[dict]:
    body = str(payload.get("body_text") or "").strip()
    subject = str(payload.get("subject") or "").strip()
    attachment_names = [str(name).strip() for name in payload.get("attachment_names") or [] if str(name).strip()]
    issues = []
    reply_to_id = payload.get("reply_to_email_id")
    if reply_to_id:
        try:
            source_mail = db.get_email(int(reply_to_id))
        except (TypeError, ValueError):
            source_mail = None
        if source_mail and source_mail.get("feedback") != "fp" and (
            source_mail.get("verdict") in ("phishing", "suspicious")
            or source_mail.get("recommended_status") in ("quarantine", "spam")
            or int(source_mail.get("score") or 0) >= policy.thresholds()["review_score"]
        ):
            presented = policy.present_findings(source_mail.get("findings"))
            reasons = "、".join(item.get("title") or "风险信号" for item in presented[:3])
            action = "回复全部" if payload.get("mode") == "reply_all" else (
                "转发" if payload.get("mode") == "forward" else "回复"
            )
            issues.append(_issue(
                "danger" if source_mail.get("verdict") == "phishing" else "warn",
                "RISKY_SOURCE_MAIL",
                f"你正在{action}一封被系统标记为风险的邮件",
                f"原邮件风险分 {int(source_mail.get('score') or 0)}"
                + (f"；主要依据：{reasons}" if reasons else "；请先核实发件人和邮件意图"),
                "原邮件风险",
            ))
    if not subject:
        issues.append(_issue("warn", "NO_SUBJECT", "邮件没有主题", "收件人可能难以判断邮件用途。"))
    has_attachments = bool(attachment_names) or int(payload.get("attachment_count") or 0) > 0
    if _ATTACHMENT_MENTION.search(body) and not has_attachments:
        issues.append(_issue("danger", "MISSING_ATTACHMENT", "正文提到了附件，但尚未添加附件", "建议添加附件后再发送。"))
    if any(_DANGEROUS_ATTACHMENT.search(name) for name in attachment_names):
        issues.append(_issue("danger", "DANGEROUS_ATTACHMENT", "附件包含高风险文件类型", "请确认文件来源和发送必要性。"))
    if _SENSITIVE.search(body):
        issues.append(_issue("warn", "SENSITIVE_TEXT", "正文可能包含身份、账号或敏感业务信息", "发送前请核对接收范围。"))

    trusted = {config.COMPANY_DOMAIN.casefold(), *(item.casefold() for item in config.TRUSTED_DOMAINS)}
    external = [addr for addr in recipients if addr.rsplit("@", 1)[-1].casefold() not in trusted]
    if payload.get("mode") == "reply_all" and external:
        issues.append(_issue("warn", "REPLY_ALL_EXTERNAL", "“回复全部”会把内容发送给外部联系人", "建议再次核对抄送范围。"))
    if _MONEY.search(f"{subject}\n{body}") and external:
        issues.append(_issue("warn", "EXTERNAL_PAYMENT", "邮件同时涉及资金操作和外部收件人", "建议通过已知联系方式复核收款信息。"))

    return issues


def review(payload: dict, recipients: list[str]) -> dict:
    """Normal sending stays local and fast, without speculative AI findings."""
    issues = local_issues(payload, recipients)
    blocking_count = sum(item["level"] == "danger" for item in issues)
    return {
        "ok": blocking_count == 0,
        "issues": issues,
        "ai_reviewed": False,
        "summary": "未发现需要中断发送的问题" if not blocking_count else f"发送前有 {blocking_count} 项需要核对",
    }
