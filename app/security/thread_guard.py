"""Thread-level anomaly signals for conversation hijacking and intent shifts."""
from __future__ import annotations

import re
from email.utils import parseaddr
from urllib.parse import urlparse

from . import domutil


_SENSITIVE_REQUEST = re.compile(
    r"(?:付款|打款|转账|收款|银行账(?:号|户)|变更.{0,8}(?:账号|账户)|密码|口令|验证码|"
    r"登录验证|账号验证|扫码(?:登录|验证)|payment|wire transfer|bank account|password|verification code)",
    re.I,
)
_ACTION_REQUEST = re.compile(
    r"(?:请|务必|立即|尽快|马上|点击|打开|下载|扫描|扫码|填写|提交|确认|启用|"
    r"please|urgent|immediately|click|open|download|scan|verify)",
    re.I,
)


def _address(value: str) -> str:
    return parseaddr(value or "")[1].strip().casefold()


def _domain(value: str) -> str:
    address = _address(value)
    if "@" not in address:
        return ""
    return domutil.registrable(address.rsplit("@", 1)[-1])


def _url_domains(email: dict) -> set[str]:
    result = set()
    for raw in email.get("urls") or []:
        try:
            host = urlparse(str(raw)).hostname or ""
        except ValueError:
            host = ""
        if host:
            result.add(domutil.registrable(host))
    return {item for item in result if item}


def _has_sensitive_request(email: dict) -> bool:
    text = f"{email.get('subject', '')}\n{email.get('body_text', '')}"
    return bool(_SENSITIVE_REQUEST.search(text))


def _has_action_request(email: dict) -> bool:
    text = f"{email.get('subject', '')}\n{email.get('body_text', '')}"
    return bool(_ACTION_REQUEST.search(text))


def detect(email: dict, history: list[dict] | None) -> list[dict]:
    """Return conservative, explainable signals for a change inside a thread.

    ``history`` must contain already stored messages from the same thread.  The
    function intentionally emits no signal for the first message, and it avoids
    treating a new participant as dangerous unless another risky intent exists.
    """
    history = [item for item in (history or []) if item]
    if not history:
        return []

    findings: list[dict] = []
    current_sender = _address(email.get("from_addr", ""))
    current_domain = _domain(current_sender)
    historical_senders = {_address(item.get("from_addr", "")) for item in history}
    historical_domains = {_domain(item.get("from_addr", "")) for item in history}
    historical_senders.discard("")
    historical_domains.discard("")
    sensitive_now = _has_sensitive_request(email)
    action_now = _has_action_request(email)

    sender_changed = bool(
        current_sender and current_sender not in historical_senders
        and current_domain and current_domain not in historical_domains
    )
    if sender_changed and (sensitive_now or action_now or len(history) >= 2):
        previous = "、".join(sorted(historical_domains)[:3]) or "原参与方"
        findings.append({
            "code": "THREAD_SENDER_SHIFT",
            "detail": f"同一会话原发件域为 {previous}，本封改为 {current_domain}",
            "weight": 22 if sensitive_now else 14,
        })

    sensitive_before = any(_has_sensitive_request(item) for item in history)
    if sensitive_now and not sensitive_before:
        findings.append({
            "code": "THREAD_INTENT_SHIFT",
            "detail": "历史往来未涉及账号、凭据或资金操作，本封首次提出此类敏感要求",
            "weight": 22,
        })

    historical_url_domains = set().union(*(_url_domains(item) for item in history))
    current_url_domains = _url_domains(email)
    new_url_domains = current_url_domains - historical_url_domains
    if new_url_domains and action_now:
        findings.append({
            "code": "THREAD_LINK_SHIFT",
            "detail": f"本封首次要求访问新链接域名：{'、'.join(sorted(new_url_domains)[:3])}",
            "weight": 14,
        })

    had_attachments = any(item.get("attachments") for item in history)
    if email.get("attachments") and not had_attachments and action_now:
        names = [str(item.get("name") or "未命名附件") for item in email.get("attachments") or []]
        findings.append({
            "code": "THREAD_ATTACHMENT_SHIFT",
            "detail": f"历史会话没有附件，本封首次要求处理附件：{'、'.join(names[:3])}",
            "weight": 10,
        })

    return findings
