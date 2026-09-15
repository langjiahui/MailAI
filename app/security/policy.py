"""统一风险规则目录、动态权重与判定阈值。"""
import re
from email.utils import parseaddr
from urllib.parse import urlparse

from .. import config, db


def _r(name, category, weight, description):
    return {"name": name, "category": category, "default_weight": weight, "description": description}


CATALOG = {
    "SPF_FAIL": _r("SPF 校验失败", "身份认证", 25, "发件服务器未通过 SPF 授权校验"),
    "DKIM_FAIL": _r("DKIM 签名失败", "身份认证", 15, "邮件数字签名校验失败"),
    "DMARC_FAIL": _r("DMARC 校验失败", "身份认证", 30, "域名身份对齐策略校验失败"),
    "REPLYTO_MISMATCH": _r("回复地址不一致", "发件身份", 15, "Reply-To 与发件域名不一致"),
    "DOMAIN_LOOKALIKE": _r("仿冒企业域名", "发件身份", 40, "发件域名与企业域名高度相似"),
    "SENDER_LOOKALIKE": _r("仿冒联系人域名", "发件身份", 25, "发件域名与高频联系人域名相似"),
    "DISPLAY_SPOOF": _r("显示名冒充", "发件身份", 20, "外部发件人冒充管理员或企业身份"),
    "DNS_MX": _r("域名无 MX", "发件身份", 10, "发件域名没有有效邮件交换记录"),
    "DNS_SPF": _r("域名无 SPF", "发件身份", 5, "发件域名未配置 SPF"),
    "URL_IP": _r("IP 直连链接", "链接链路", 15, "链接直接使用 IP 地址"),
    "URL_AT": _r("链接 @ 伪装", "链接链路", 15, "URL 使用 @ 隐藏真实目标"),
    "URL_PUNYCODE": _r("Punycode 域名", "链接链路", 15, "链接使用国际化域名编码"),
    "URL_SHORT": _r("短链接", "链接链路", 10, "短链隐藏最终访问地址"),
    "URL_TLD": _r("可疑顶级域", "链接链路", 8, "链接使用高风险顶级域名"),
    "URL_ANCHOR": _r("链接文案与目标不符", "链接链路", 20, "显示域名与实际跳转域名不同"),
    "URL_BLOCKLIST": _r("链接命中黑名单", "链接链路", 50, "链接域名命中本地黑名单"),
    "URL_LOOKALIKE": _r("链接仿冒企业域", "链接链路", 35, "链接域名与企业域名高度相似"),
    "URL_CHAIN_ERROR": _r("跳转链异常", "链接链路", 8, "可疑链接无法正常完成链路解析"),
    "URL_REDIRECT_CHAIN": _r("多级跳转", "链接链路", 10, "链接经过多次重定向"),
    "URL_FINAL_LOOKALIKE": _r("落地域仿冒", "链接链路", 35, "最终落地域名仿冒企业域名"),
    "URL_FINAL_BLOCKLIST": _r("落地域命中黑名单", "链接链路", 50, "最终落地域名命中黑名单"),
    "URL_SHORT_EXPANDED": _r("短链展开", "链接链路", 5, "短链接展开到不同域名"),
    "ATT_DOUBLE": _r("双扩展名附件", "附件载荷", 35, "附件使用双重扩展名伪装"),
    "ATT_DANGER": _r("危险附件类型", "附件载荷", 30, "附件扩展名属于高风险类型"),
    "ATT_DANGER_EXT": _r("可执行或宏附件", "附件载荷", 30, "深度分析发现可执行或宏附件"),
    "ATT_MACRO": _r("附件包含宏", "附件载荷", 35, "Office 附件包含宏代码"),
    "ATT_TYPE_MISMATCH": _r("附件类型伪装", "附件载荷", 25, "声明类型与文件真实类型不一致"),
    "ATT_ARCHIVE_EXE": _r("压缩包含危险文件", "附件载荷", 30, "压缩包内发现可执行或宏文件"),
    "URGENCY": _r("紧迫恐吓话术", "社工话术", 10, "正文使用紧迫、冻结或限时措辞"),
    "CRED_BAIT": _r("凭据诱导", "社工话术", 20, "诱导输入密码、验证码或支付信息"),
    "FIRST_TIME_SENDER": _r("首次发件人", "行为画像", 10, "此前未收到过该发件人的邮件"),
    "OFF_HOUR_SENDER": _r("异常发件时段", "行为画像", 8, "发件时间偏离该发件人历史习惯"),
    "NEW_ATTACHMENT_TYPE": _r("新附件类型", "行为画像", 8, "发件人首次使用该类附件"),
    "FIRST_ATTACHMENT": _r("首次发送附件", "行为画像", 10, "该发件人首次发送附件"),
    "URL_ANOMALY": _r("链接行为异常", "行为画像", 10, "发件人历史邮件通常不包含链接"),
    "LINGUISTIC_DRIFT": _r("语言风格漂移", "行为画像", 12, "邮件语言特征偏离发件人历史习惯"),
    "THREAD_SENDER_SHIFT": _r("会话参与方突变", "会话变化", 14, "同一邮件会话中突然出现此前没有的发件域"),
    "THREAD_INTENT_SHIFT": _r("会话意图突变", "会话变化", 22, "日常往来中突然出现付款、账号或凭据要求"),
    "THREAD_LINK_SHIFT": _r("会话链接突变", "会话变化", 14, "会话中首次出现需要操作的新链接目标"),
    "THREAD_ATTACHMENT_SHIFT": _r("会话附件突变", "会话变化", 10, "会话中首次出现需要处理的附件"),
    "VISION_SOCIAL_ENGINEERING": _r("视觉社工诱导", "视觉内容", 35, "多模态模型识别到社工诱导画面"),
    "VISION_QR": _r("图片二维码", "视觉内容", 15, "图片中包含可疑二维码"),
    "LIST_UNSUB": _r("批量退订头", "垃圾营销", 8, "邮件包含批量退订标记"),
    "PRECEDENCE": _r("群发邮件标记", "垃圾营销", 12, "邮件头标记为 bulk/list/junk"),
    "MARKETING": _r("营销关键词", "垃圾营销", 10, "正文包含促销、优惠或退订话术"),
}

TRIGGER_GUIDE = {
    "SPF_FAIL": "邮件服务器给出的认证结果中，SPF 为 fail 或 softfail。softfail 表示发件 IP 未被域名明确授权。",
    "DKIM_FAIL": "Authentication-Results 明确记录 dkim=fail，表示邮件签名校验没有通过。",
    "DMARC_FAIL": "Authentication-Results 明确记录 dmarc=fail，表示发件域对齐策略校验失败。",
    "REPLYTO_MISMATCH": "邮件的 Reply-To 回复域名与 From 发件域名不同，回复会被送往另一域名。",
    "DOMAIN_LOOKALIKE": "发件主域名与企业域名字符高度相似，例如用数字 1 替代字母 l。",
    "SENDER_LOOKALIKE": "发件主域名与历史高频联系人域名高度相似，但不是同一个域名。",
    "DISPLAY_SPOOF": "外部邮箱的显示名称包含企业名称、管理员或 IT 部门等内部身份特征。",
    "DNS_MX": "对外部发件域查询 DNS 时，没有找到可接收邮件的 MX 记录。网络查询失败不会命中。",
    "DNS_SPF": "对外部发件域查询 DNS 时，确认没有找到 SPF TXT 记录。网络查询失败不会命中。",
    "URL_IP": "邮件链接直接使用 IPv4 地址作为主机。普通域名解析出的 IP 不会命中。",
    "URL_AT": "链接主机部分包含 @，浏览器最终访问目标可能与前半段显示内容不同。",
    "URL_PUNYCODE": "链接主机名包含 xn--，即使用国际化域名的 Punycode 编码。",
    "URL_SHORT": "链接使用内置短链服务列表中的域名，原始地址不能直接表明最终目标。",
    "URL_TLD": "链接注册域使用内置高风险顶级域列表，例如 .top、.xyz 或 .download。",
    "URL_ANCHOR": "邮件正文中链接显示出的域名与 href 实际访问域名不同。",
    "URL_BLOCKLIST": "链接注册域与本地恶意域名黑名单精确匹配。",
    "URL_LOOKALIKE": "链接注册域与企业域名高度相似，但不是企业域名或其子域。",
    "URL_CHAIN_ERROR": "需要检查的短链或 IP 链接在限定时间内无法完成跳转解析。",
    "URL_REDIRECT_CHAIN": "受检查链接发生多次 HTTP 跳转，最终地址与初始地址之间存在中间节点。",
    "URL_FINAL_LOOKALIKE": "完成跳转后，最终落地域与企业域名高度相似但并非可信域。",
    "URL_FINAL_BLOCKLIST": "完成跳转后，最终落地域命中本地恶意域名黑名单。",
    "URL_SHORT_EXPANDED": "短链接已展开到另一个非可信域名，用于提示最终目标发生变化。",
    "ATT_DOUBLE": "附件名形如 report.pdf.exe，使用两个扩展名隐藏真实文件类型。",
    "ATT_DANGER": "附件扩展名属于可执行、脚本、安装包、快捷方式或带宏 Office 文件列表。",
    "ATT_DANGER_EXT": "附件深度解析确认包含可执行文件或带宏的高风险扩展类型。",
    "ATT_MACRO": "Office 附件包中检测到 VBA 宏工程或宏相关文件。",
    "ATT_TYPE_MISMATCH": "附件声明的 MIME 类型、扩展名与文件头识别出的真实格式不一致。",
    "ATT_ARCHIVE_EXE": "ZIP 等压缩附件内部包含可执行、脚本、快捷方式或带宏文件。",
    "URGENCY": "主题或正文命中紧急、立即处理、账号冻结、密码过期等催促词。",
    "CRED_BAIT": "正文要求输入密码、验证码、银行卡信息，或诱导点击链接重新登录。",
    "FIRST_TIME_SENDER": "本地画像中此前没有该发件地址的来信记录，建立历史后不会继续命中。",
    "OFF_HOUR_SENDER": "发件时间明显偏离该发件人历史上常见的发送时段。",
    "NEW_ATTACHMENT_TYPE": "该发件人过去发过附件，但本次首次出现这种附件扩展类型。",
    "FIRST_ATTACHMENT": "该发件人历史来信从未包含附件，本次首次携带附件。",
    "URL_ANOMALY": "该发件人历史邮件很少包含链接，本次邮件突然出现一个或多个链接。",
    "LINGUISTIC_DRIFT": "邮件语言、措辞或文本统计特征明显偏离该发件人的历史习惯。",
    "THREAD_SENDER_SHIFT": "同一主题会话的历史参与域稳定，本封突然来自新的发件域。",
    "THREAD_INTENT_SHIFT": "日常会话中首次出现付款、账号、密码或验证码等敏感操作要求。",
    "THREAD_LINK_SHIFT": "同一会话此前没有该链接域，本封首次要求访问新的链接目标。",
    "THREAD_ATTACHMENT_SHIFT": "同一会话此前没有附件，本封首次要求打开或处理附件。",
    "VISION_SOCIAL_ENGINEERING": "多模态分析在邮件图片中识别到登录诱导、付款催促或其他社工内容。",
    "VISION_QR": "邮件内图片包含二维码；该信号只表示需要核实，不能单独证明恶意。",
    "LIST_UNSUB": "邮件头包含 List-Unsubscribe，通常表示订阅或批量营销邮件。",
    "PRECEDENCE": "邮件头 Precedence 被标记为 bulk、list 或 junk。",
    "MARKETING": "主题或正文命中促销、优惠券、折扣、清仓、退订等营销关键词。",
}

THRESHOLD_DEFAULTS = {
    "review_score": config.LLM_REVIEW_SCORE,
    "quarantine_score": config.QUARANTINE_SCORE,
    "spam_score": 25,
}

# 白名单只豁免容易因业务场景产生误报的常规信号；恶意载荷、黑名单链接和
# 严重认证失败仍必须检查，避免可信供应商账号失陷后绕过安全底线。
ALLOWLIST_BLOCKING_CODES = {
    "SPF_FAIL", "DKIM_FAIL", "DMARC_FAIL", "DOMAIN_LOOKALIKE",
    "URL_BLOCKLIST", "URL_FINAL_BLOCKLIST", "URL_LOOKALIKE", "URL_FINAL_LOOKALIKE",
    "ATT_DANGER", "ATT_DANGER_EXT", "ATT_DOUBLE", "ATT_MACRO",
    "ATT_TYPE_MISMATCH", "ATT_ARCHIVE_EXE", "VISION_SOCIAL_ENGINEERING", "VISION_QR",
    "THREAD_SENDER_SHIFT", "THREAD_INTENT_SHIFT",
}

CATEGORY_GUIDE = {
    "身份认证": {"title": "发件服务器是否可信", "description": "检查 SPF、DKIM、DMARC 等邮件身份认证结果。", "example": "适合识别伪造发件服务器"},
    "发件身份": {"title": "发件人是否冒充他人", "description": "检查相似域名、显示名冒充、回复地址不一致和域名基础设施。", "example": "例如把 example.com 伪装成 examp1e.com"},
    "链接链路": {"title": "邮件链接是否安全", "description": "检查短链接、跳转、黑名单、伪装链接和异常落地域。", "example": "适合经常收到外部链接的用户"},
    "附件载荷": {"title": "附件是否可能有危险", "description": "检查宏、可执行文件、双扩展名和附件类型伪装。", "example": "建议始终保持开启"},
    "社工话术": {"title": "是否催促或索要敏感信息", "description": "识别紧迫恐吓、索要密码、验证码和付款信息等话术。", "example": "严格模式会更早提醒"},
    "行为画像": {"title": "是否偏离日常发件习惯", "description": "检查首次联系人、异常时段、新附件类型和语言风格变化。", "example": "新联系人较多时可选择宽松"},
    "会话变化": {"title": "同一会话是否突然变了", "description": "检查往来参与方、链接、附件和敏感意图是否在会话中突然出现。", "example": "适合识别供应商账号失陷和回复链劫持"},
    "视觉内容": {"title": "图片与二维码是否可疑", "description": "分析图片中的二维码和视觉社工诱导内容。", "example": "适合含海报、截图和二维码的邮件"},
    "垃圾营销": {"title": "是否属于营销或群发", "description": "识别退订头、群发标记和促销用语，主要影响垃圾邮件判断。", "example": "不会直接判定为钓鱼"},
}

SENSITIVITY_FACTORS = {"relaxed": 0.65, "balanced": 1.0, "strict": 1.35}


def normalize_domain(value: str) -> str:
    """Normalize a user-entered email/domain/URL to an ASCII hostname."""
    raw = (value or "").strip().lower().strip(". ")
    parsed = parseaddr(raw)[1]
    if parsed and "@" in parsed:
        raw = parsed
    if "@" in raw and "://" not in raw:
        raw = raw.rsplit("@", 1)[-1]
    if "://" in raw:
        raw = urlparse(raw).hostname or ""
    raw = raw.split("/", 1)[0].split(":", 1)[0].strip(". ")
    if not raw or len(raw) > 253 or "." not in raw:
        return ""
    try:
        ascii_domain = raw.encode("idna").decode("ascii")
    except UnicodeError:
        return ""
    if not re.fullmatch(r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", ascii_domain):
        return ""
    return ascii_domain


def normalize_address(value: str) -> str:
    address = parseaddr((value or "").strip())[1].lower()
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", address):
        return ""
    local, domain = address.rsplit("@", 1)
    normalized = normalize_domain(domain)
    return f"{local}@{normalized}" if normalized else ""


def trusted_domain_match(value: str, include_company: bool = True) -> str:
    """Return the trusted parent matching a sender or URL hostname."""
    domain = normalize_domain(value)
    if not domain:
        return ""
    trusted = {normalize_domain(item) for item in config.TRUSTED_DOMAINS}
    if include_company:
        trusted.add(normalize_domain(config.COMPANY_DOMAIN))
    try:
        trusted.update(
            normalize_domain(item.get("domain", ""))
            for item in db.list_security_allowlist()
            if item.get("kind") != "address" and item.get("enabled")
        )
    except Exception:
        # Static trust remains available during early initialization/migrations.
        pass
    return next((item for item in trusted if item and (domain == item or domain.endswith("." + item))), "")


def is_trusted_domain(value: str) -> bool:
    return bool(trusted_domain_match(value))


def list_allowlist_entries() -> list[dict]:
    """Return effective trust entries, including read-only configured domains."""
    result = []
    seen = set()

    def add_readonly(domain: str, source: str, note: str):
        normalized = normalize_domain(domain)
        if not normalized or normalized in seen:
            return
        seen.add(normalized)
        result.append({
            "id": f"readonly:{normalized}", "kind": "domain", "value": normalized,
            "domain": normalized, "enabled": True, "readonly": True,
            "source": source, "note": note,
        })

    add_readonly(config.COMPANY_DOMAIN, "企业域名", "当前企业内部邮件域名")
    for domain in sorted(config.BUILTIN_TRUSTED_DOMAINS):
        add_readonly(domain, "内置白名单", "MailAI 内置可信业务域名")
    for domain in sorted(set(config.TRUSTED_DOMAINS) - set(config.BUILTIN_TRUSTED_DOMAINS)):
        add_readonly(domain, "配置白名单", "由运行环境配置")

    for entry in db.list_security_allowlist():
        value = entry.get("value") or entry.get("domain") or entry.get("email") or ""
        if entry.get("kind") == "domain" and value.casefold() in seen:
            continue
        result.append({**entry, "readonly": False, "source": "用户添加"})
    return result


def allowlist_match(from_addr: str) -> dict | None:
    sender_address = normalize_address(from_addr)
    sender_domain = normalize_domain(from_addr)
    if not sender_domain and not sender_address:
        return None
    entries = db.list_security_allowlist()
    for entry in entries:
        if entry.get("kind") == "address" and entry.get("enabled") \
                and normalize_address(entry.get("value", "")) == sender_address:
            return {**entry, "sender_domain": sender_domain, "sender_address": sender_address}
    for entry in entries:
        if entry.get("kind") == "address":
            continue
        domain = normalize_domain(entry.get("domain", ""))
        if entry.get("enabled") and domain and (sender_domain == domain or sender_domain.endswith("." + domain)):
            return {**entry, "sender_domain": sender_domain}
    configured = trusted_domain_match(sender_domain, include_company=False)
    if configured:
        return {"id": 0, "kind": "domain", "domain": configured, "value": configured,
                "enabled": True, "note": "内置可信业务域名", "sender_domain": sender_domain}
    return None


def apply_allowlist(findings: list[dict], matched: dict | None) -> list[dict]:
    if not matched:
        return findings
    return [item for item in findings if item.get("code") in ALLOWLIST_BLOCKING_CODES]


def list_categories() -> list[dict]:
    rules = list_rules()
    result = []
    for category, guide in CATEGORY_GUIDE.items():
        items = [item for item in rules if item["category"] == category]
        ratios = [item["weight"] / item["default_weight"] for item in items if item["default_weight"] > 0]
        ratio = sum(ratios) / len(ratios) if ratios else 1
        sensitivity = "relaxed" if ratio < .83 else ("strict" if ratio > 1.17 else "balanced")
        result.append({"category": category, **guide, "enabled_count": sum(bool(item["enabled"]) for item in items),
                       "total": len(items), "sensitivity": sensitivity})
    return result


def configure_category(category: str, enabled: bool, sensitivity: str) -> list[dict]:
    if category not in CATEGORY_GUIDE or sensitivity not in SENSITIVITY_FACTORS:
        raise ValueError("不支持的规则场景或敏感度")
    factor = SENSITIVITY_FACTORS[sensitivity]
    items = [(code, enabled, min(100, max(0, round(meta["default_weight"] * factor))))
             for code, meta in CATALOG.items() if meta["category"] == category]
    db.set_rule_settings(items)
    return [item for item in list_rules() if item["category"] == category]


def list_rules() -> list[dict]:
    settings = db.list_rule_settings()
    return [{"code": code, **meta,
             "enabled": bool(settings.get(code, {}).get("enabled", 1)),
             "weight": settings.get(code, {}).get("weight") if settings.get(code, {}).get("weight") is not None else meta["default_weight"],
             "customized": code in settings,
             "trigger": TRIGGER_GUIDE.get(code, meta["description"]),
             "allowlist_behavior": ("白名单邮件仍会检查此项" if code in ALLOWLIST_BLOCKING_CODES
                                    else "命中可信发件人白名单时忽略此项")}
            for code, meta in CATALOG.items()]


def apply(findings: list[dict]) -> list[dict]:
    settings = db.list_rule_settings()
    result = []
    for finding in findings:
        code = finding.get("code", "")
        setting = settings.get(code)
        if setting and not setting["enabled"]:
            continue
        item = dict(finding)
        if setting and setting.get("weight") is not None:
            item["weight"] = setting["weight"]
        result.append(item)
    return result


def present_findings(findings: list[dict] | None) -> list[dict]:
    """Add user-facing copy without discarding the original technical evidence.

    Findings are persisted in the database, so changing rule producers alone would
    leave historical mail with the old, terse wording.  Presentation metadata is
    therefore added when a message is read.
    """
    result = []
    for finding in findings or []:
        item = dict(finding)
        code = str(item.get("code") or "")
        # AUTH_NONE was retired because many legitimate mail gateways omit this
        # optional aggregate header. Hide stale persisted findings as well.
        if code == "AUTH_NONE":
            continue
        raw_detail = str(item.get("detail") or "").strip()
        meta = CATALOG.get(code, {})
        title = meta.get("name") or "安全信号"
        explanation = raw_detail or meta.get("description") or "系统发现了一项需要留意的安全信号"

        if code == "DISPLAY_SPOOF":
            title = "发件人名称可能造成误认"
            identity = re.split(r"[:：]", raw_detail, maxsplit=1)[-1].strip() if raw_detail else "内部人员或系统"
            explanation = f"邮件来自外部地址，但显示名称看起来像“{identity}”，请确认是否确为本人发送。"
        elif code == "DNS_SPF":
            title = "发件域名缺少代发保护"
            matched = re.search(r"发件域\s+([^\s]+)", raw_detail)
            domain = matched.group(1) if matched else "该发件域名"
            explanation = f"{domain} 没有公开允许哪些服务器代发邮件（SPF），因此更难排除地址被冒用的可能。"
        elif code == "URL_ANOMALY":
            title = "链接数量与往常不同"
            matched = re.search(r"(?:包含|出现)\s*(\d+)\s*个链接", raw_detail)
            count_text = f"出现 {matched.group(1)} 个链接" if matched else "包含链接"
            explanation = f"该发件人平时很少发送链接，但本邮件{count_text}，请确认是否符合日常业务场景。"
        elif code == "THREAD_SENDER_SHIFT":
            title = "这封回复来自新的发件方"
            explanation = f"{raw_detail}。请通过原有联系方式确认对方身份，避免回复链被冒用。"
        elif code == "THREAD_INTENT_SHIFT":
            title = "会话内容突然涉及敏感操作"
            explanation = "此前往来没有类似要求，本封却首次提出付款、账号或凭据操作，建议先线下复核。"
        elif code == "THREAD_LINK_SHIFT":
            title = "会话中突然出现新的链接"
            explanation = f"{raw_detail}。打开前请确认该链接确由原联系人提供。"
        elif code == "THREAD_ATTACHMENT_SHIFT":
            title = "会话中突然要求处理附件"
            explanation = f"{raw_detail}。请先核对发件人和附件用途。"

        item.update({
            "title": title,
            "explanation": explanation,
            "technical_code": code,
            "technical_detail": raw_detail,
        })
        result.append(item)
    return result


def thresholds() -> dict:
    stored = db.get_runtime_settings()
    result = dict(THRESHOLD_DEFAULTS)
    for key in result:
        try:
            result[key] = int(stored.get(key, result[key]))
        except (TypeError, ValueError):
            pass
    return result
