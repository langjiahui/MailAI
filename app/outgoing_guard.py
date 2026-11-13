"""Focused multi-dimensional checks for send mistakes and non-blocking inline pre-send audit."""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta

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

_URL_RE = re.compile(r"https?://\S+|mailto:\S+", re.I)
_EMAIL_RE = re.compile(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}")

# Credential / secret patterns
_PEM_KEY_RE = re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----")
_API_KEY_PATTERNS = (
    ("API Key", re.compile(r"\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{18,}\b")),
    ("GitHub Token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b")),
    ("AWS Access Key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("Slack Token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{12,}\b")),
    ("Bearer Token", re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{24,}\b")),
    ("JWT Token", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")),
)
_CRED_ASSIGN_RE = re.compile(
    r"(?i)(?:password|passwd|pwd|api_?key|secret_?key|access_?token|密码|口令|密钥)"
    r"\s*[:=：]\s*([^\s,，;；\"'`<>【】\[\]{}]{6,})"
)
_MASKED_SECRET_VALUES = {"example", "sample", "changeme", "your_token", "your_key", "placeholder", "redact", "redacted"}

# PII: Chinese 18-digit Resident ID and bank card PAN
_CN_ID_RE = re.compile(r"(?<!\d)([1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx])(?!\d)")
_CN_ID_WEIGHTS = (7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2)
_CN_ID_CHECKSUM = "10X98765432"
_BANK_CARD_RE = re.compile(r"(?<![A-Za-z0-9.])((?:62|4\d|5[1-5]|3[57])[0-9 -]{14,22})(?![A-Za-z0-9.])")

# Template / unfinished draft placeholders
_CURLY_PLACEHOLDER_RE = re.compile(r"\{\{[^}\n]{1,32}\}\}")
_BRACKET_PLACEHOLDER_RE = re.compile(
    r"[【\[](?:待补充|待填写|待完善|待输入|待确认|请填写|此处填写|填写[^】\]\n]{1,16}|"
    r"XXX+|姓名|收件人姓名|称呼|日期|时间|金额|项目名(?:称)?|附件名(?:称)?)[】\]]",
    re.I,
)
_MARKER_PLACEHOLDER_RE = re.compile(r"(?<![A-Za-z0-9_])(?:TBD|TODO|FIXME)(?![A-Za-z0-9_])")
_BLANK_FILL_RE = re.compile(r"(?:[:：\s]|[\u4e00-\u9fff])(_{4,})(?!_)")

# Date & weekday checks
_WEEKDAY_MAP = {"一": 0, "二": 1, "三": 2, "四": 3, "五": 4, "六": 5, "日": 6, "天": 6}
_WEEKDAY_ZH = ("周一", "周二", "周三", "周四", "周五", "周六", "周日")
_DATE_WEEKDAY_RE = re.compile(
    r"(?:(20\d{2})\s*[年\-/.]\s*)?(1[0-2]|0?[1-9])\s*[月\-/.]\s*(3[01]|[12]\d|0?[1-9])\s*日?"
    r"\s*(?:[（(\s,，]*(?:周|星期|礼拜)\s*([一二三四五六日天])\s*[）)]?)"
)
_THIS_WEEK_RE = re.compile(r"本周([一二三四五六日天])")
_RETRO_BEFORE_RE = re.compile(r"(?:已于?|刚|总结|回顾|上周|完成|发生|收到|发出|截至目前)")
_RETRO_AFTER_RE = re.compile(r"^(?:\s*(?:已|完成|召开了|举行了|发出了|收到了|结束))")
_DEADLINE_DATE_RE = re.compile(
    r"(?:请于|请务必于|请在|务必在|最晚于?|截止(?:至|日期为?|时间为?)?)"
    r"\s*(?:(20\d{2})\s*[年\-/.]\s*)?(1[0-2]|0?[1-9])\s*[月\-/.]\s*(3[01]|[12]\d|0?[1-9])\s*日?"
)


def _issue(
    level: str,
    code: str,
    message: str,
    reason: str = "",
    source: str = "本地检查",
    *,
    tone: str = "",
    highlights: list[dict] | None = None,
) -> dict:
    return {
        "level": level,
        "tone": tone or ("high" if level == "danger" else "warn"),
        "code": code,
        "message": message,
        "reason": reason,
        "source": source,
        "highlights": highlights or [],
    }


def _strip_urls(text: str) -> str:
    return _URL_RE.sub(lambda m: " " * len(m.group(0)), text or "")


def _mask_secret(raw: str) -> str:
    cleaned = raw.strip()
    if len(cleaned) <= 4:
        return "****"
    return cleaned[:4] + "…"


def _is_masked_secret(value: str) -> bool:
    v = value.strip()
    if not v or (len(set(v)) == 1 and v[0] in "*•xX-_."):
        return True
    if "***" in v or "..." in v or "…" in v:
        return True
    if v[0] in ("*", "•") or v.startswith(("已", "见", "请", "暂")):
        return True
    return v.casefold() in _MASKED_SECRET_VALUES


def _is_valid_cn_id(candidate: str, today: date) -> bool:
    if len(candidate) != 18:
        return False
    try:
        year = int(candidate[6:10])
        month = int(candidate[10:12])
        day = int(candidate[12:14])
        birth = date(year, month, day)
    except ValueError:
        return False
    if year < 1920 or birth > today:
        return False
    total = sum(int(candidate[i]) * _CN_ID_WEIGHTS[i] for i in range(17))
    expected = _CN_ID_CHECKSUM[total % 11]
    return candidate[17].upper() == expected


def _is_valid_luhn_card(digits: str) -> bool:
    if not (16 <= len(digits) <= 19) or not digits.isdigit():
        return False
    if len(set(digits)) <= 2:
        return False
    total = 0
    reverse = digits[::-1]
    for idx, ch in enumerate(reverse):
        val = int(ch)
        if idx % 2 == 1:
            val *= 2
            if val > 9:
                val -= 9
        total += val
    return total % 10 == 0


def _split_visible_recipients(payload: dict, recipients: list[str]) -> tuple[list[str], bool]:
    to_cc = []
    for key in ("to_addr", "cc_addr"):
        raw = str(payload.get(key) or "")
        if raw.strip():
            to_cc.extend(_EMAIL_RE.findall(raw))
    has_bcc = bool(_EMAIL_RE.findall(str(payload.get("bcc_addr") or "")))
    if not to_cc and recipients and not has_bcc:
        to_cc = list(recipients)
    return to_cc, has_bcc


def _iter_scoped_fields(subject: str, body: str):
    if subject:
        yield "subject", subject
    if body:
        yield "body", body


def _check_risky_source(payload: dict, issues: list[dict]) -> None:
    reply_to_id = payload.get("reply_to_email_id")
    if not reply_to_id:
        return
    try:
        source_mail = db.get_email(int(reply_to_id))
    except (TypeError, ValueError):
        source_mail = None
    if not source_mail or source_mail.get("feedback") == "fp":
        return
    if not (
        source_mail.get("verdict") in ("phishing", "suspicious")
        or source_mail.get("recommended_status") in ("quarantine", "spam")
        or int(source_mail.get("score") or 0) >= policy.thresholds()["review_score"]
    ):
        return
    presented = policy.present_findings(source_mail.get("findings"))
    reasons = "、".join(item.get("title") or "风险信号" for item in presented[:3])
    action = "回复全部" if payload.get("mode") == "reply_all" else (
        "转发" if payload.get("mode") == "forward" else "回复"
    )
    level = "danger" if source_mail.get("verdict") == "phishing" else "warn"
    issues.append(_issue(
        level,
        "RISKY_SOURCE_MAIL",
        f"你正在{action}一封被系统标记为风险的邮件",
        f"原邮件风险分 {int(source_mail.get('score') or 0)}"
        + (f"；主要依据：{reasons}" if reasons else "；请先核实发件人和邮件意图"),
        "原邮件风险",
        tone="high" if level == "danger" else "warn",
        highlights=[{"scope": "recipients", "text": ""}],
    ))


def _check_recipients_scope(payload: dict, recipients: list[str], issues: list[dict]) -> list[str]:
    trusted = {config.COMPANY_DOMAIN.casefold(), *(item.casefold() for item in config.TRUSTED_DOMAINS)}
    external = [addr for addr in recipients if "@" in addr and addr.rsplit("@", 1)[-1].casefold() not in trusted]
    if not recipients and payload.get("allow_empty_recipients"):
        issues.append(_issue(
            "warn", "EMPTY_RECIPIENTS", "尚未填写收件人", "补充收件人后才可发送。", "收件范围",
            highlights=[{"scope": "recipients", "text": ""}],
        ))
        return external

    if payload.get("mode") == "reply_all" and external:
        domains = sorted({addr.rsplit("@", 1)[-1].lower() for addr in external})
        preview = "、".join(domains[:3]) + (" 等" if len(domains) > 3 else "")
        internal_count = max(0, len(recipients) - len(external))
        scope_note = (
            f"包含 {len(external)} 位外部收件人（{preview}）"
            + (f"及 {internal_count} 位内部联系人，" if internal_count else "，")
            + "“回复全部”将对所有收件人可见。"
        )
        issues.append(_issue(
            "warn", "REPLY_ALL_EXTERNAL", "“回复全部”会把内容发送给外部联系人", scope_note, "外发范围",
            highlights=[{"scope": "recipients", "text": ""}],
        ))

    visible_to_cc, has_bcc = _split_visible_recipients(payload, recipients)
    if not has_bcc and len(visible_to_cc) >= 8 and external:
        issues.append(_issue(
            "warn",
            "MASS_RECIPIENTS_EXPOSED",
            f"公开收件/抄送栏共 {len(visible_to_cc)} 位联系人，未使用密送（Bcc）",
            "向多人（含外部邮箱）群发时建议使用密送（Bcc），避免暴露全部收件人邮箱地址。",
            "群发隐私",
            highlights=[{"scope": "recipients", "text": ""}],
        ))
    return external


def _check_secrets_and_pii(
    subject: str, body: str, external: list[str], today: date, issues: list[dict],
) -> None:
    secret_hits: list[str] = []
    secret_highlights: list[dict] = []
    for scope, text in _iter_scoped_fields(subject, body):
        m_pem = _PEM_KEY_RE.search(text)
        if m_pem:
            secret_hits.append("私钥块（PRIVATE KEY）")
            secret_highlights.append({"scope": scope, "text": m_pem.group(0)})
        for label, pattern in _API_KEY_PATTERNS:
            for m in pattern.finditer(text):
                secret_hits.append(f"{label}（{_mask_secret(m.group(0))}）")
                secret_highlights.append({"scope": scope, "text": m.group(0)})
                break
        for m in _CRED_ASSIGN_RE.finditer(text):
            val = m.group(1)
            if not _is_masked_secret(val):
                secret_hits.append(f"明文凭据（{_mask_secret(val)}）")
                secret_highlights.append({"scope": scope, "text": m.group(0)})
                break
    if secret_hits:
        issues.append(_issue(
            "warn",
            "SECRET_CREDENTIAL_LEAK",
            "正文疑似包含真实密码、私钥或 API 凭据",
            f"检测到 {'、'.join(secret_hits[:2])}，直接发出可能造成凭据泄露；建议移除或脱敏后通过加密渠道传递。",
            "凭证防泄露",
            tone="high",
            highlights=secret_highlights[:4],
        ))

    pii_kinds: list[str] = []
    pii_highlights: list[dict] = []
    for scope, text in _iter_scoped_fields(subject, body):
        for m in _CN_ID_RE.finditer(text):
            if _is_valid_cn_id(m.group(1), today):
                pii_kinds.append("18位身份证号")
                pii_highlights.append({"scope": scope, "text": m.group(1)})
                break
        for m in _BANK_CARD_RE.finditer(text):
            raw_card = m.group(1).strip()
            digits = re.sub(r"\D", "", raw_card)
            if (any(sep in raw_card for sep in (" ", "-")) or len(digits) in (16, 17, 18, 19)) and _is_valid_luhn_card(digits):
                pii_kinds.append("银行卡号")
                pii_highlights.append({"scope": scope, "text": raw_card})
                break
    if pii_kinds:
        kind_text = "、".join(dict.fromkeys(pii_kinds))
        issues.append(_issue(
            "warn",
            "PII_SENSITIVE_DATA",
            f"正文含完整{kind_text}，即将发往外部收件人" if external else f"正文检测到完整{kind_text}",
            "建议对敏感数字打码脱敏（保留前后几位）后再发送。" if external else "内部传输也建议按最小必要原则进行脱敏处理。",
            "隐私脱敏",
            tone="high" if external else "warn",
            highlights=pii_highlights[:4],
        ))
    elif body:
        m_sens = _SENSITIVE.search(body)
        if m_sens and not secret_hits:
            issues.append(_issue(
                "warn", "SENSITIVE_TEXT", "正文可能包含身份、账号或敏感业务信息", "发送前请核对接收范围。",
                highlights=[{"scope": "body", "text": m_sens.group(0)}],
            ))


def _check_placeholders(subject: str, body: str, issues: list[dict]) -> None:
    samples: list[str] = []
    highlights: list[dict] = []
    for scope, text in _iter_scoped_fields(subject, body):
        clean_text = _strip_urls(text)
        for regex in (_CURLY_PLACEHOLDER_RE, _BRACKET_PLACEHOLDER_RE, _MARKER_PLACEHOLDER_RE):
            for m in regex.finditer(clean_text):
                samples.append(m.group(0))
                highlights.append({"scope": scope, "text": m.group(0)})
        for m_blank in _BLANK_FILL_RE.finditer(clean_text):
            samples.append(m_blank.group(1))
            highlights.append({"scope": scope, "text": m_blank.group(1)})
    if samples:
        preview = "、".join(dict.fromkeys(samples[:2]))
        issues.append(_issue(
            "warn",
            "UNFILLED_PLACEHOLDER",
            "内容中仍包含未替换的模板占位符",
            f"检测到未填完内容（{preview}），建议补充具体信息后再发送。",
            "占位符自检",
            tone="high",
            highlights=highlights[:6],
        ))


def _check_date_consistency(subject: str, body: str, today: date, issues: list[dict]) -> None:
    mismatch_msgs: list[str] = []
    mismatch_highlights: list[dict] = []
    for scope, text in _iter_scoped_fields(subject, body):
        clean = _strip_urls(text)
        for m in _DATE_WEEKDAY_RE.finditer(clean):
            year_s, month_s, day_s, wd_char = m.groups()
            month, day = int(month_s), int(day_s)
            stated_wd = _WEEKDAY_MAP[wd_char]
            year = int(year_s) if year_s else (today.year + 1 if (today.month >= 10 and month <= 3) else today.year)
            try:
                parsed = date(year, month, day)
            except ValueError:
                mismatch_msgs.append(f"正文中的日期不存在：{year}年{month}月{day}日")
                mismatch_highlights.append({"scope": scope, "text": m.group(0)})
                continue
            if parsed.weekday() != stated_wd:
                actual_zh = _WEEKDAY_ZH[parsed.weekday()]
                mismatch_msgs.append(f"日期与星期不符：{year}年{month}月{day}日 实际为{actual_zh}，文中写的是「周{wd_char}」")
                mismatch_highlights.append({"scope": scope, "text": m.group(0)})
    if mismatch_msgs:
        issues.append(_issue(
            "warn",
            "DATE_WEEKDAY_MISMATCH",
            mismatch_msgs[0],
            "请确认是日期还是星期几笔误，避免会议或截止时间误解。",
            "时间自洽",
            highlights=mismatch_highlights[:4],
        ))

    stale_msgs: list[str] = []
    stale_highlights: list[dict] = []
    for scope, text in _iter_scoped_fields(subject, body):
        clean = _strip_urls(text)
        for m in _THIS_WEEK_RE.finditer(clean):
            wd_char = m.group(1)
            target_wd = _WEEKDAY_MAP[wd_char]
            if target_wd >= today.weekday():
                continue
            before = clean[max(0, m.start() - 12):m.start()]
            after = clean[m.end():min(len(clean), m.end() + 12)]
            if _RETRO_BEFORE_RE.search(before) or _RETRO_AFTER_RE.search(after):
                continue
            stale_msgs.append(f"正文提及「本周{wd_char}」已早于今天（{_WEEKDAY_ZH[today.weekday()]}）")
            stale_highlights.append({"scope": scope, "text": m.group(0)})

        for m in _DEADLINE_DATE_RE.finditer(clean):
            year_s, month_s, day_s = m.groups()
            year = int(year_s) if year_s else today.year
            month, day = int(month_s), int(day_s)
            try:
                deadline_dt = date(year, month, day)
            except ValueError:
                continue
            before = clean[max(0, m.start() - 10):m.start()]
            after = clean[m.end():min(len(clean), m.end() + 10)]
            if _RETRO_BEFORE_RE.search(before) or _RETRO_AFTER_RE.search(after):
                continue
            if today - timedelta(days=90) <= deadline_dt < today:
                stale_msgs.append(f"正文的计划/截止时间（{month}月{day}日）早于今天（{today.month}月{today.day}日）")
                stale_highlights.append({"scope": scope, "text": m.group(0)})
    if stale_msgs:
        issues.append(_issue(
            "warn",
            "STALE_DATE_CONFLICT",
            stale_msgs[0],
            "若是后续安排请更新具体日期或星期，避免沿用旧模板时间。",
            "时间自洽",
            highlights=stale_highlights[:4],
        ))


def local_issues(payload: dict, recipients: list[str], *, today: date | None = None) -> list[dict]:
    ref_day = today or datetime.now().date()
    body = str(payload.get("body_text") or "").strip()
    subject = str(payload.get("subject") or "").strip()
    attachment_names = [str(name).strip() for name in payload.get("attachment_names") or [] if str(name).strip()]
    issues: list[dict] = []

    _check_risky_source(payload, issues)
    if not subject:
        issues.append(_issue(
            "warn", "NO_SUBJECT", "邮件没有主题", "收件人可能难以判断邮件用途。",
            highlights=[{"scope": "subject", "text": ""}],
        ))

    has_attachments = bool(attachment_names) or int(payload.get("attachment_count") or 0) > 0
    m_att = _ATTACHMENT_MENTION.search(body) if body else None
    if m_att and not has_attachments:
        issues.append(_issue(
            "danger", "MISSING_ATTACHMENT", "正文提到了附件，但尚未添加附件", "建议添加附件后再发送。",
            highlights=[{"scope": "body", "text": m_att.group(0)}],
        ))
    bad_atts = [name for name in attachment_names if _DANGEROUS_ATTACHMENT.search(name)]
    if bad_atts:
        issues.append(_issue(
            "danger", "DANGEROUS_ATTACHMENT", "附件包含高风险文件类型", "请确认文件来源和发送必要性。",
            highlights=[{"scope": "attachments", "text": name} for name in bad_atts[:3]],
        ))

    external = _check_recipients_scope(payload, recipients, issues)
    _check_secrets_and_pii(subject, body, external, ref_day, issues)
    _check_placeholders(subject, body, issues)
    _check_date_consistency(subject, body, ref_day, issues)

    for scope, text in _iter_scoped_fields(subject, body):
        m_money = _MONEY.search(text)
        if m_money and external:
            issues.append(_issue(
                "warn", "EXTERNAL_PAYMENT", "邮件同时涉及资金操作和外部收件人", "建议通过已知联系方式复核收款信息。",
                highlights=[{"scope": scope, "text": m_money.group(0)}],
            ))
            break

    issues.sort(key=lambda item: 0 if item.get("tone") == "high" or item.get("level") == "danger" else 1)
    return issues


def review(payload: dict, recipients: list[str], *, today: date | None = None) -> dict:
    """Normal sending stays local and fast, without speculative AI findings."""
    issues = local_issues(payload, recipients, today=today)
    blocking_count = sum(item["level"] == "danger" for item in issues)
    warning_count = sum(item["level"] != "danger" for item in issues)
    if blocking_count:
        summary = f"发送前有 {blocking_count} 项需要核对" + (f"（另有 {warning_count} 项标亮提醒）" if warning_count else "")
    elif warning_count:
        summary = f"已标亮 {warning_count} 处待核对信息（不影响发送）"
    else:
        summary = "未发现需要中断发送的问题"
    return {
        "ok": blocking_count == 0,
        "issues": issues,
        "ai_reviewed": False,
        "summary": summary,
    }
