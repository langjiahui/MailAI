"""Lightweight, local threat-campaign correlation for risky mail."""
from __future__ import annotations

import hashlib
import re
from collections import Counter
from email.utils import parseaddr
from urllib.parse import urlparse

from . import domutil


_SUBJECT_PREFIX = re.compile(r"^(?:(?:re|fw|fwd|回复|转发)\s*[:：]\s*)+", re.I)
_TOKEN = re.compile(r"[a-z0-9]{3,}|[\u4e00-\u9fff]{2,}", re.I)


def _domain_from_address(value: str) -> str:
    address = parseaddr(value or "")[1].casefold()
    return domutil.registrable(address.rsplit("@", 1)[-1]) if "@" in address else ""


def _subject_tokens(value: str) -> set[str]:
    value = _SUBJECT_PREFIX.sub("", value or "").casefold()
    tokens = set(_TOKEN.findall(value))
    compact = re.sub(r"\s+", "", value)
    if len(compact) >= 6:
        tokens.update(compact[i:i + 3] for i in range(min(len(compact) - 2, 80)))
    return tokens


def _body_tokens(value: str) -> set[str]:
    compact = re.sub(r"\s+", "", (value or "").casefold())[:600]
    return {compact[i:i + 4] for i in range(0, max(0, len(compact) - 3), 3)}


def _similarity(left: set[str], right: set[str]) -> float:
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def _url_domains(email: dict) -> set[str]:
    domains = set()
    for raw in email.get("urls") or []:
        try:
            host = urlparse(str(raw)).hostname or ""
        except ValueError:
            host = ""
        if host:
            domains.add(domutil.registrable(host))
    landing = str(email.get("final_landing_domain") or "").strip().casefold()
    if landing:
        domains.add(domutil.registrable(landing))
    return {value for value in domains if value}


def _attachment_hashes(email: dict) -> set[str]:
    values = set()
    for item in email.get("attachment_analysis") or []:
        if isinstance(item, dict) and item.get("sha256"):
            values.add(str(item["sha256"]).casefold())
    return values


def _features(email: dict) -> dict:
    return {
        "sender_domain": _domain_from_address(email.get("from_addr", "")),
        "subject": _subject_tokens(email.get("subject", "")),
        "body": _body_tokens(email.get("body_text", "") or email.get("snippet", "")),
        "url_domains": _url_domains(email),
        "hashes": _attachment_hashes(email),
    }


def _pair_signals(left: dict, right: dict) -> tuple[int, list[str]]:
    score, signals = 0, []
    if left["hashes"] & right["hashes"]:
        score += 6; signals.append("相同附件指纹")
    common_urls = left["url_domains"] & right["url_domains"]
    if common_urls:
        score += 4; signals.append("相同链接目标")
    subject_similarity = _similarity(left["subject"], right["subject"])
    if subject_similarity >= .58:
        score += 3; signals.append("主题高度相似")
    body_similarity = _similarity(left["body"], right["body"])
    if body_similarity >= .62:
        score += 3; signals.append("正文话术相似")
    if left["sender_domain"] and left["sender_domain"] == right["sender_domain"]:
        score += 1; signals.append("相同发件域")
    return score, signals


def cluster(rows: list[dict], *, min_size: int = 2, limit: int = 8) -> list[dict]:
    candidates = [row for row in rows if row.get("id") and (
        # 单封邮件可能只有中等强度信号；多封共享目标与话术本身就是增量证据。
        row.get("verdict") in ("phishing", "suspicious") or int(row.get("score") or 0) >= 30
    )][:600]
    if len(candidates) < min_size:
        return []

    features = [_features(row) for row in candidates]
    parent = list(range(len(candidates)))
    edge_signals: dict[tuple[int, int], list[str]] = {}

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(left: int, right: int) -> None:
        left_root, right_root = find(left), find(right)
        if left_root != right_root:
            parent[right_root] = left_root

    for left in range(len(candidates)):
        for right in range(left + 1, len(candidates)):
            score, signals = _pair_signals(features[left], features[right])
            if score >= 4:
                union(left, right)
                edge_signals[(left, right)] = signals

    groups: dict[int, list[int]] = {}
    for index in range(len(candidates)):
        groups.setdefault(find(index), []).append(index)

    result = []
    for indexes in groups.values():
        if len(indexes) < min_size:
            continue
        members = [candidates[index] for index in indexes]
        signal_counter = Counter()
        for (left, right), signals in edge_signals.items():
            if left in indexes and right in indexes:
                signal_counter.update(signals)
        member_ids = sorted(int(item["id"]) for item in members)
        campaign_id = hashlib.sha1(",".join(map(str, member_ids)).encode()).hexdigest()[:10]
        ordered = sorted(members, key=lambda item: (str(item.get("date") or ""), int(item["id"])), reverse=True)
        result.append({
            "id": campaign_id,
            "size": len(members),
            "max_score": max(int(item.get("score") or 0) for item in members),
            "phishing_count": sum(item.get("verdict") == "phishing" for item in members),
            "pending_count": sum(not item.get("reviewed") and not item.get("feedback") for item in members),
            "first_seen": min(str(item.get("date") or item.get("created_at") or "") for item in members),
            "last_seen": max(str(item.get("date") or item.get("created_at") or "") for item in members),
            "signals": [name for name, _ in signal_counter.most_common(4)],
            "email_ids": member_ids,
            "samples": [{
                "id": item["id"], "subject": item.get("subject") or "（无主题）",
                "from_addr": item.get("from_addr") or "", "date": item.get("date") or "",
                "score": int(item.get("score") or 0), "verdict": item.get("verdict") or "clean",
            } for item in ordered[:5]],
        })
    return sorted(result, key=lambda item: (item["size"], item["max_score"], item["last_seen"]), reverse=True)[:limit]


def for_email(email_id: int, groups: list[dict]) -> dict | None:
    for group in groups:
        if email_id in group.get("email_ids", []):
            return group
    return None
