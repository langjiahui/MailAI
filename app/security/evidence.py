"""把离散规则命中整理为可解释的多源证据维度。"""

DIMENSIONS = {
    "身份认证": {"SPF_FAIL", "DKIM_FAIL", "DMARC_FAIL"},
    "发件身份": {"DOMAIN_LOOKALIKE", "SENDER_LOOKALIKE", "DISPLAY_SPOOF", "REPLYTO_MISMATCH", "DNS_MX", "DNS_SPF"},
    "链接链路": {"URL_IP", "URL_ANCHOR", "URL_AT", "URL_BLOCKLIST", "URL_LOOKALIKE", "URL_PUNYCODE", "URL_SHORT", "URL_TLD", "URL_FINAL_BLOCKLIST", "URL_FINAL_LOOKALIKE", "URL_REDIRECT_CHAIN", "URL_SHORT_EXPANDED", "URL_CHAIN_ERROR"},
    "附件载荷": {"ATT_DANGER", "ATT_DOUBLE", "ATT_DANGER_EXT", "ATT_MACRO", "ATT_TYPE_MISMATCH", "ATT_ARCHIVE_EXE"},
    "社工话术": {"URGENCY", "CRED_BAIT"},
    "行为画像": {"FIRST_TIME_SENDER", "FIRST_ATTACHMENT", "SENDER_HOUR_ANOMALY", "SENDER_CONTENT_ANOMALY"},
    "会话变化": {"THREAD_SENDER_SHIFT", "THREAD_INTENT_SHIFT", "THREAD_LINK_SHIFT", "THREAD_ATTACHMENT_SHIFT"},
    "视觉内容": {"VISION_SOCIAL_ENGINEERING", "VISION_QR"},
}


def summarize(findings: list[dict] | None, score: int = 0) -> dict:
    findings = findings or []
    groups = []
    covered_indexes = set()
    for name, codes in DIMENSIONS.items():
        hits = [(i, f) for i, f in enumerate(findings) if f.get("code") in codes]
        if not hits:
            continue
        covered_indexes.update(i for i, _ in hits)
        values = [f for _, f in hits]
        groups.append({
            "name": name,
            "count": len(values),
            "weight": sum(max(0, int(f.get("weight", 0) or 0)) for f in values),
            "codes": [f.get("code", "") for f in values],
            "evidence": [f.get("detail", "") for f in values[:4]],
        })
    other = [f for i, f in enumerate(findings)
             if i not in covered_indexes and int(f.get("weight", 0) or 0) > 0]
    if other:
        groups.append({
            "name": "其他信号", "count": len(other),
            "weight": sum(int(f.get("weight", 0) or 0) for f in other),
            "codes": [f.get("code", "") for f in other],
            "evidence": [f.get("detail", "") for f in other[:4]],
        })
    return {
        "dimensions": groups,
        "dimension_count": len(groups),
        "signal_count": sum(g["count"] for g in groups),
        "score": max(0, min(100, int(score or 0))),
    }
