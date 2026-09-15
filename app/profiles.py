"""发件人行为基线：维护画像并基于历史行为检测异常。"""
import re
from collections import Counter
from datetime import datetime

from . import config, db
from .security import domutil


def _hour(dt_str: str) -> int:
    try:
        return datetime.fromisoformat(dt_str.replace(" ", "T")).hour
    except Exception:
        return -1


def _is_internal(addr: str) -> bool:
    d = domutil.registrable(_domain(addr))
    return d and d == domutil.registrable(config.COMPANY_DOMAIN)


def _domain(addr: str) -> str:
    if not addr or "@" not in addr:
        return ""
    return addr.split("@", 1)[1].lower()


def _body_signature(text: str) -> dict:
    """提取正文中的高频词作为语言特征签名。"""
    text = (text or "").lower()
    # 去掉标点、数字，取 2-4 字词
    words = re.findall(r'[一-龥]{2,4}|[a-z]{3,}', text)
    stop = {"的", "了", "是", "在", "我", "有", "和", "就", "不", "人", "都", "一", "一个", "上", "也", "很", "到", "说", "要", "去", "你", "会", "着", "没有", "看", "好", "自己", "这"}
    words = [w for w in words if w not in stop and len(w) >= 2]
    top = Counter(words).most_common(20)
    return {"top_words": [w for w, _ in top], "word_freq": dict(top[:20])}


def update_profile_from_email(email: dict) -> dict:
    """根据一封邮件更新/创建发件人画像，返回更新后的画像。"""
    sender = (email.get("from_addr") or "").lower()
    if not sender:
        return {}
    prof = db.get_or_create_sender_profile(sender)
    now = email.get("date") or datetime.now().isoformat(timespec="seconds")

    if not prof.get("first_seen"):
        prof["first_seen"] = now
    prof["last_seen"] = now
    prof["sender_key"] = sender
    prof["from_domain"] = _domain(sender)
    prof["message_count"] = (prof.get("message_count") or 0) + 1

    if _is_internal(sender):
        prof["internal_count"] = (prof.get("internal_count") or 0) + 1
    else:
        prof["external_count"] = (prof.get("external_count") or 0) + 1

    # 发送时段直方图
    hour = _hour(email.get("date") or "")
    hist = prof.get("hour_histogram") or {}
    if hour >= 0:
        hist[str(hour)] = hist.get(str(hour), 0) + 1
    prof["hour_histogram"] = hist

    # 附件历史
    atts = email.get("attachments") or []
    att_names = set(prof.get("attachment_names") or [])
    att_types = set(prof.get("attachment_types") or [])
    for a in atts:
        name = (a.get("name") or "").lower()
        if name:
            att_names.add(name)
        ct = (a.get("content_type") or "").lower()
        if ct:
            att_types.add(ct)
    prof["attachment_names"] = list(att_names)
    prof["attachment_types"] = list(att_types)

    # URL 历史
    urls = email.get("urls") or []
    prof["url_rate"] = ((prof.get("url_rate") or 0) * (prof["message_count"] - 1) + (1 if urls else 0)) / prof["message_count"]

    # 分类历史
    cats = Counter(prof.get("typical_categories") or [])
    cat = email.get("category")
    if cat:
        cats[cat] += 1
    prof["typical_categories"] = list(cats.keys())[:10]

    # 平均正文长度
    body_len = len(email.get("body_text") or "")
    old_count = prof["message_count"] - 1
    prof["avg_body_length"] = int(((prof.get("avg_body_length") or 0) * old_count + body_len) / prof["message_count"])

    # 语言签名
    sig = prof.get("linguistic_signature") or {}
    sig.update(_body_signature(email.get("body_text")))
    prof["linguistic_signature"] = sig

    # 风险分计算（基于异常程度）
    prof["risk_score"] = _compute_risk_score(prof, email)

    db.update_sender_profile(prof)
    return prof


def _compute_risk_score(prof: dict, email: dict) -> int:
    """根据画像与当前邮件的差异计算行为异常分。"""
    score = 0
    count = prof.get("message_count") or 1

    # 新外部发件人
    if count <= 1 and not _is_internal(email.get("from_addr", "")):
        score += 8

    # 发送时间异常
    hist = prof.get("hour_histogram") or {}
    hour = _hour(email.get("date") or "")
    if hist and str(hour) not in hist:
        score += 10

    # 附件模式突变
    atts = email.get("attachments") or []
    if atts:
        prev_att_types = set(prof.get("attachment_types") or [])
        if prev_att_types:
            current_types = {a.get("content_type", "").lower() for a in atts}
            if current_types - prev_att_types:
                score += 8
        else:
            score += 10  # 首次带附件

    # URL 模式突变
    urls = email.get("urls") or []
    if urls and (prof.get("url_rate") or 0) < 0.2:
        score += 6

    # 正文长度异常
    body_len = len(email.get("body_text") or "")
    avg = prof.get("avg_body_length") or 0
    if avg > 0 and body_len > avg * 3:
        score += 5

    return min(50, score)


def detect_anomalies(email: dict, prof: dict | None = None) -> list:
    """基于画像返回行为异常 findings（统一 {code, detail, weight}）。"""
    sender = (email.get("from_addr") or "").lower()
    if not sender:
        return []
    if prof is None:
        prof = db.get_or_create_sender_profile(sender)

    findings = []
    count = prof.get("message_count") or 0

    if count <= 1 and not _is_internal(sender):
        findings.append({
            "code": "FIRST_TIME_SENDER",
            "detail": f"首次收到 {sender} 邮件",
            "weight": 10,
        })

    hour = _hour(email.get("date") or "")
    hist = prof.get("hour_histogram") or {}
    if hist and str(hour) not in hist and count > 1:
        findings.append({
            "code": "OFF_HOUR_SENDER",
            "detail": f"发件时间 {hour}:00 偏离历史习惯（常见时段：{', '.join(sorted(hist.keys()))}）",
            "weight": 12,
        })

    atts = email.get("attachments") or []
    if atts:
        prev_att_types = set(prof.get("attachment_types") or [])
        current_types = {(a.get("content_type") or "").lower() for a in atts}
        if prev_att_types and (current_types - prev_att_types):
            findings.append({
                "code": "NEW_ATTACHMENT_TYPE",
                "detail": f"出现历史未见的附件类型：{', '.join(current_types - prev_att_types)}",
                "weight": 15,
            })
        elif not prev_att_types:
            findings.append({
                "code": "FIRST_ATTACHMENT",
                "detail": f"该发件人首次发送附件",
                "weight": 10,
            })

    urls = email.get("urls") or []
    if urls and (prof.get("url_rate") or 0) < 0.3 and count > 1:
        findings.append({
            "code": "URL_ANOMALY",
            "detail": f"该发件人历史很少发送 URL，本邮件包含 {len(urls)} 个链接",
            "weight": 10,
        })

    # 语言风格漂移：当前正文与历史高频词重合度低
    sig = prof.get("linguistic_signature") or {}
    top_words = set(sig.get("top_words", []))
    if top_words and count > 2:
        cur = set(_body_signature(email.get("body_text")).get("top_words", []))
        if cur:
            overlap = len(cur & top_words) / len(cur)
            if overlap < 0.1:
                findings.append({
                    "code": "LINGUISTIC_DRIFT",
                    "detail": f"正文用词风格与历史差异较大（重合度 {overlap:.0%}）",
                    "weight": 12,
                })

    return findings


def get_profile_for_display(sender: str) -> dict:
    """供前端展示的发件人画像（去除过细数据）。"""
    prof = db.get_or_create_sender_profile(sender.lower())
    return {
        "sender_key": prof.get("sender_key"),
        "from_domain": prof.get("from_domain"),
        "first_seen": prof.get("first_seen"),
        "last_seen": prof.get("last_seen"),
        "message_count": prof.get("message_count", 0),
        "internal_count": prof.get("internal_count", 0),
        "external_count": prof.get("external_count", 0),
        "common_hours": sorted((prof.get("hour_histogram") or {}).keys()),
        "attachment_types": prof.get("attachment_types", []),
        "typical_categories": prof.get("typical_categories", []),
        "avg_body_length": prof.get("avg_body_length", 0),
        "risk_score": prof.get("risk_score", 0),
    }
