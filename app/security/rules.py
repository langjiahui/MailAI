"""规则层主逻辑：对一封解析后的邮件跑全部启发式检查，输出风险分与证据。"""
import re
from urllib.parse import urlparse

from .. import config, db
from .. import profiles
from . import domutil, headers as hdrs, urls as urlmod, policy

DANGEROUS_EXTS = {
    ".exe", ".scr", ".bat", ".cmd", ".ps1", ".vbs", ".vbe", ".js", ".jse",
    ".wsf", ".jar", ".lnk", ".iso", ".img", ".msi", ".dll", ".com", ".pif",
    ".docm", ".xlsm", ".pptm", ".ace", ".apk",
}
DOUBLE_EXT_RE = re.compile(r"\.(pdf|doc|docx|xls|xlsx|zip|rar|txt|jpg|png)\.[a-z0-9]{2,4}$", re.I)

URGENT_WORDS = [
    "紧急", "立即", "马上处理", "账号异常", "账户异常", "密码过期", "密码到期", "将被冻结",
    "将被停用", "24小时内", "限时", "逾期", "尽快处理",
    "urgent", "immediately", "suspended", "verify your account", "password expired",
    "unusual sign-in", "action required",
]
CRED_WORDS = [
    "输入密码", "提供密码", "验证码发", "短信验证码", "银行卡", "网银", "重新激活", "重新认证",
    "点击链接登录", "重新登录",
    "enter your password", "confirm your password", "one-time password", "otp",
    "update your payment", "billing information",
]
MARKETING_WORDS = [
    "促销", "优惠券", "限时折扣", "秒杀", "满减", "清仓", "大促", "返利", "团购",
    "sale", "discount", "coupon", "promo", "deal", "unsubscribe",
]


def _addr_domain(addr: str) -> str:
    addr = (addr or "").lower()
    return addr.split("@", 1)[1].strip(" >") if "@" in addr else ""


def scan(email: dict) -> dict:
    """返回 {score, verdict, findings, spam_score, spam_findings}。"""
    findings = []
    spam_findings = []

    from_addr = email.get("from_addr", "")
    from_domain = _addr_domain(from_addr)
    from_reg = domutil.registrable(from_domain)
    company = domutil.registrable(config.COMPANY_DOMAIN)
    is_internal = from_reg == company or from_domain.endswith("." + company)
    is_trusted = policy.is_trusted_domain(from_domain)
    is_trusted_sender = from_addr.lower() in config.TRUSTED_SENDERS
    allowlisted = policy.allowlist_match(from_addr)

    reliable_body = "" if email.get("body_decode_warning") else email.get("body_text", "")
    text_all = f"{email.get('subject', '')}\n{reliable_body}".lower()
    if email.get("body_decode_warning"):
        findings.append({
            "code": "BODY_ENCODING",
            "detail": "正文编码异常，已跳过基于正文内容的风险判断",
            "weight": 0,
        })

    # 1) 认证结果
    auth = hdrs.parse_auth_results(email.get("auth_raw", ""))
    if email.get("auth_raw"):
        if auth["spf"] == "fail":
            findings.append({"code": "SPF_FAIL", "detail": f"SPF 校验失败({auth['spf']})", "weight": 25})
        elif auth["spf"] == "softfail":
            # 可信域名 softfail 降权，避免误伤工资单/内部系统通知
            findings.append({"code": "SPF_FAIL", "detail": f"SPF 校验失败({auth['spf']})", "weight": 10 if is_trusted else 25})
        if auth["dkim"] == "fail":
            findings.append({"code": "DKIM_FAIL", "detail": "DKIM 签名校验失败", "weight": 15})
        if auth["dmarc"] == "fail":
            findings.append({"code": "DMARC_FAIL", "detail": "DMARC 校验失败", "weight": 30})

    # 2) 发件人一致性
    reply_domain = _addr_domain(email.get("reply_to", ""))
    if reply_domain and domutil.registrable(reply_domain) != from_reg:
        findings.append({
            "code": "REPLYTO_MISMATCH",
            "detail": f"回复地址域名 {reply_domain} 与发件域名 {from_domain} 不一致",
            "weight": 15,
        })

    # 3) 仿冒域名（公司域 + 高频联系人域 + 显示名冒称内部人员）
    if from_reg and not is_trusted:
        if domutil.similarity(from_reg, company) >= 0.8:
            findings.append({
                "code": "DOMAIN_LOOKALIKE",
                "detail": f"发件域名 {from_reg} 仿冒公司域名 {company}",
                "weight": 40,
            })
        else:
            for known in db.frequent_sender_domains():
                kd = domutil.registrable(known)
                if kd and kd != from_reg and domutil.similarity(from_reg, kd) >= 0.85:
                    findings.append({
                        "code": "SENDER_LOOKALIKE",
                        "detail": f"发件域名 {from_reg} 仿冒常用联系人域名 {kd}",
                        "weight": 25,
                    })
                    break

    display = (email.get("from_name") or "").lower()
    if not is_internal and (company.split(".")[0] in display or "管理员" in display or "it部" in display):
        findings.append({
            "code": "DISPLAY_SPOOF",
            "detail": f"外部邮件显示名冒称内部身份: {email.get('from_name')}",
            "weight": 20,
        })

    # 4) 附件
    for att in email.get("attachments", []):
        name = (att.get("name") or "").lower()
        ext = "." + name.rsplit(".", 1)[-1] if "." in name else ""
        if DOUBLE_EXT_RE.search(name):
            findings.append({"code": "ATT_DOUBLE", "detail": f"双重扩展名伪装附件: {att.get('name')}", "weight": 35})
        elif ext in DANGEROUS_EXTS:
            findings.append({"code": "ATT_DANGER", "detail": f"高风险附件类型: {att.get('name')}", "weight": 30})

    # 5) URL
    for u in email.get("urls", [])[:20]:
        findings.extend(urlmod.analyze_url(u, email.get("body_html", "")))

    # 6) 话术
    for w in URGENT_WORDS:
        if w in text_all:
            findings.append({"code": "URGENCY", "detail": f"紧迫/恐吓话术: 「{w}」", "weight": 10})
            break
    for w in CRED_WORDS:
        if w in text_all:
            findings.append({"code": "CRED_BAIT", "detail": f"诱导提供凭据: 「{w}」", "weight": 20})
            break

    # 7) 发件域 DNS 体检（仅外部邮件且非可信域名）
    if not is_internal and not is_trusted and from_domain:
        prof = hdrs.dns_profile(from_domain)
        if prof["mx"] == "missing":
            findings.append({"code": "DNS_MX", "detail": f"发件域 {from_domain} 无 MX 记录", "weight": 10})
        if prof["spf"] == "missing":
            findings.append({"code": "DNS_SPF", "detail": f"发件域 {from_domain} 未配置 SPF", "weight": 5})

    # 8) 垃圾营销信号
    if email.get("list_unsubscribe"):
        spam_findings.append({"code": "LIST_UNSUB", "detail": "含批量邮件退订头", "weight": 8})
    if (email.get("precedence") or "").lower() in ("bulk", "list", "junk"):
        spam_findings.append({"code": "PRECEDENCE", "detail": "标记为群发邮件", "weight": 12})
    for w in MARKETING_WORDS:
        if w in text_all:
            spam_findings.append({"code": "MARKETING", "detail": f"营销关键词: 「{w}」", "weight": 10})
            break

    # 9) 发件人行为基线异常
    findings.extend(profiles.detect_anomalies(email))

    # 应用规则中心的启停与权重覆盖
    findings = policy.apply(findings)
    spam_findings = policy.apply(spam_findings)
    findings = policy.apply_allowlist(findings, allowlisted)
    spam_findings = [] if allowlisted else spam_findings

    # 内部可信邮件整体降权
    score = sum(f["weight"] for f in findings)
    if is_internal and auth.get("spf") != "fail" and auth.get("dmarc") != "fail":
        score = int(score * 0.3)
    # 业务方明确核验的固定地址可降低弱行为信号；硬认证失败、危险附件等仍不降权。
    hard_codes = {"SPF_FAIL", "DKIM_FAIL", "DMARC_FAIL", "DOMAIN_LOOKALIKE",
                  "ATT_DANGER", "ATT_DOUBLE", "URL_BLOCKLIST", "URL_FINAL_BLOCKLIST"}
    if is_trusted_sender and not any(f.get("code") in hard_codes for f in findings):
        score = int(score * 0.2)
    score = min(100, score)

    limits = policy.thresholds()
    verdict = "phishing" if score >= limits["quarantine_score"] else (
        "suspicious" if score >= limits["review_score"] else "clean")

    return {
        "score": score,
        "verdict": verdict,
        "findings": findings,
        "spam_score": min(100, sum(f["weight"] for f in spam_findings)),
        "spam_findings": spam_findings,
        "auth": auth,
        "allowlist": allowlisted,
    }
