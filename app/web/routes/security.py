"""安全策略：规则配置、白名单、阈值、聚类战役与处置模式。"""
import csv
import io
import json
import logging
from datetime import datetime, timedelta

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from ... import db, pipeline
from ...security import policy
from ..helpers import campaign_groups
from ..schemas import AllowlistRequest, RuleCategoryRequest

log = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/rules")
def api_rules():
    return {"rules": policy.list_rules(), "thresholds": policy.thresholds(),
            "allowlist": policy.list_allowlist_entries(), "categories": policy.list_categories()}


@router.post("/api/rules/allowlist")
def api_save_allowlist(payload: AllowlistRequest):
    kind = payload.kind if payload.kind in {"domain", "address"} else "domain"
    value = policy.normalize_address(payload.domain) if kind == "address" else policy.normalize_domain(payload.domain)
    if not value:
        example = "name@partner.example.com" if kind == "address" else "partner.example.com"
        raise HTTPException(400, f"请输入有效{'邮箱地址' if kind == 'address' else '域名'}，例如 {example}")
    note = payload.note.strip()[:200]
    entry = (db.upsert_security_allowlist_address(value, payload.enabled, note) if kind == "address"
             else db.upsert_security_allowlist(value, payload.enabled, note) | {"kind": "domain", "value": value})
    db.add_audit_log(None, action="allowlist_change", actor="user",
                     reason=f"{'启用' if payload.enabled else '停用'}可信{('邮箱' if kind == 'address' else '域名')} {value}",
                     meta={"kind": kind, "value": value, "enabled": payload.enabled, "note": note})
    return {"ok": True, "entry": entry}


@router.delete("/api/rules/allowlist/{entry_id}")
def api_delete_allowlist(entry_id: int):
    entries = {item["id"]: item for item in db.list_security_allowlist() if item.get("kind") == "domain"}
    entry = entries.get(entry_id)
    if not entry or not db.delete_security_allowlist(entry_id):
        raise HTTPException(404, "白名单记录不存在")
    db.add_audit_log(None, action="allowlist_delete", actor="user",
                     reason=f"删除可信域名 {entry['domain']}", meta={"domain": entry["domain"]})
    return {"ok": True}


@router.delete("/api/rules/allowlist/{kind}/{entry_id}")
def api_delete_allowlist_typed(kind: str, entry_id: int):
    if kind not in {"domain", "address"}:
        raise HTTPException(400, "白名单类型无效")
    entries = {(item["kind"], item["id"]): item for item in db.list_security_allowlist()}
    entry = entries.get((kind, entry_id))
    deleted = (db.delete_security_allowlist_address(entry_id) if kind == "address"
               else db.delete_security_allowlist(entry_id))
    if not entry or not deleted:
        raise HTTPException(404, "白名单记录不存在")
    db.add_audit_log(None, action="allowlist_delete", actor="user",
                     reason=f"删除可信{('邮箱' if kind == 'address' else '域名')} {entry['value']}", meta=entry)
    return {"ok": True}


@router.post("/api/rules/categories/{category}")
def api_update_rule_category(category: str, payload: RuleCategoryRequest):
    try:
        rules = policy.configure_category(category, payload.enabled, payload.sensitivity)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    db.add_audit_log(None, action="rule_category_change", actor="user",
                     reason=f"更新{category}：{'开启' if payload.enabled else '关闭'}，{payload.sensitivity}",
                     meta={"category": category, **payload.model_dump()})
    return {"ok": True, "rules": rules, "categories": policy.list_categories()}


@router.post("/api/rules/{code}")
def api_update_rule(code: str, enabled: bool, weight: int):
    if code not in policy.CATALOG:
        raise HTTPException(404, "规则不存在")
    if weight < 0 or weight > 100:
        raise HTTPException(400, "权重必须在 0 到 100 之间")
    db.set_rule_setting(code, enabled, weight)
    db.add_audit_log(None, action="rule_config_change", actor="user",
                     reason=f"规则 {code}：{'启用' if enabled else '停用'}，权重 {weight}",
                     meta={"code": code, "enabled": enabled, "weight": weight})
    return {"ok": True}


@router.post("/api/rules/thresholds/update")
def api_update_thresholds(review_score: int, quarantine_score: int, spam_score: int):
    if not (0 <= review_score < quarantine_score <= 100):
        raise HTTPException(400, "人工复核阈值必须小于隔离阈值，且范围为 0-100")
    if not 0 <= spam_score <= 100:
        raise HTTPException(400, "垃圾邮件阈值范围为 0-100")
    for key, value in {"review_score": review_score, "quarantine_score": quarantine_score,
                       "spam_score": spam_score}.items():
        db.set_runtime_setting(key, str(value))
    db.add_audit_log(None, action="threshold_config_change", actor="user",
                     reason="更新风险判定阈值", meta=policy.thresholds())
    return {"ok": True, "thresholds": policy.thresholds()}


@router.post("/api/rules/actions/reset")
def api_reset_rules():
    db.delete_rule_settings()
    for key, value in policy.THRESHOLD_DEFAULTS.items():
        db.set_runtime_setting(key, str(value))
    db.add_audit_log(None, action="rule_config_reset", actor="user", reason="恢复规则默认配置")
    return {"ok": True}


@router.get("/api/security/campaigns")
def api_security_campaigns(days: int = 30):
    return {"items": campaign_groups(days), "days": max(1, min(days, 90))}


def _collect_ioc(days: int) -> dict:
    """汇总近 N 天判定为钓鱼的邮件中提取的 IOC（失陷指标）。

    只输出检测元数据（发件人/域名/IP/URL/附件哈希），不含邮件正文。
    """
    cutoff = (datetime.now() - timedelta(days=days)).isoformat(timespec="seconds")
    with db.conn() as c:
        senders = [dict(r) for r in c.execute(
            "SELECT lower(from_addr) AS value, COUNT(*) AS count, MAX(date) AS last_seen "
            "FROM emails WHERE verdict='phishing' AND COALESCE(date,'') >= ? "
            "GROUP BY lower(from_addr) ORDER BY count DESC", (cutoff,)).fetchall()]
        chains = [dict(r) for r in c.execute(
            "SELECT u.original_url, u.final_url, u.final_domain, u.final_ip, "
            "COUNT(*) AS count, MAX(u.created_at) AS last_seen "
            "FROM url_chains u JOIN emails e ON e.id = u.email_id "
            "WHERE e.verdict='phishing' AND u.created_at >= ? "
            "GROUP BY u.original_url ORDER BY count DESC", (cutoff,)).fetchall()]
        analyses = [r[0] for r in c.execute(
            "SELECT attachment_analysis FROM emails "
            "WHERE verdict='phishing' AND COALESCE(date,'') >= ?", (cutoff,)).fetchall()]

    sender_domains = {}
    for row in senders:
        domain = (row["value"] or "").rsplit("@", 1)[-1]
        if not domain:
            continue
        slot = sender_domains.setdefault(domain, {"value": domain, "count": 0, "last_seen": ""})
        slot["count"] += row["count"]
        slot["last_seen"] = max(slot["last_seen"], row["last_seen"] or "")

    urls, domains, ips = [], {}, {}
    for row in chains:
        urls.append({
            "value": row.get("final_url") or row.get("original_url") or "",
            "original_url": row.get("original_url") or "",
            "count": row["count"], "last_seen": row["last_seen"],
        })
        for bucket, key in ((domains, "final_domain"), (ips, "final_ip")):
            value = (row.get(key) or "").strip()
            if not value:
                continue
            slot = bucket.setdefault(value, {"value": value, "count": 0, "last_seen": ""})
            slot["count"] += row["count"]
            slot["last_seen"] = max(slot["last_seen"], row["last_seen"] or "")

    hashes = {}
    for raw in analyses:
        try:
            items = json.loads(raw or "[]")
        except (TypeError, json.JSONDecodeError):
            continue
        for item in items if isinstance(items, list) else []:
            digest = (item.get("sha256") or "").strip()
            if not digest:
                continue
            slot = hashes.setdefault(digest, {
                "value": digest, "count": 0, "last_seen": "", "names": []})
            slot["count"] += 1
            name = item.get("name") or ""
            if name and name not in slot["names"]:
                slot["names"].append(name)

    return {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "window_days": days,
        "senders": senders,
        "sender_domains": sorted(sender_domains.values(), key=lambda r: -r["count"]),
        "urls": urls,
        "domains": sorted(domains.values(), key=lambda r: -r["count"]),
        "ips": sorted(ips.values(), key=lambda r: -r["count"]),
        "attachment_sha256": sorted(hashes.values(), key=lambda r: -r["count"]),
    }


def _ioc_csv(data: dict) -> str:
    """IOC 列表转 CSV（带 BOM 便于 Excel 打开）。"""
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["type", "value", "count", "last_seen", "extra"])
    sections = (("sender", "senders"), ("sender_domain", "sender_domains"),
                ("url", "urls"), ("domain", "domains"), ("ip", "ips"),
                ("attachment_sha256", "attachment_sha256"))
    for kind, key in sections:
        for row in data[key]:
            extra = ""
            if kind == "url":
                extra = row.get("original_url", "")
            elif kind == "attachment_sha256":
                extra = ";".join(row.get("names") or [])
            writer.writerow([kind, row["value"], row["count"], row.get("last_seen", ""), extra])
    return "﻿" + buf.getvalue()


@router.get("/api/security/ioc")
def api_ioc_export(format: str = "json", days: int = 90):
    days = max(1, min(int(days or 90), 365))
    data = _collect_ioc(days)
    if format == "csv":
        return Response(
            content=_ioc_csv(data), media_type="text/csv",
            headers={"Content-Disposition": "attachment; filename=mailai-ioc.csv"},
        )
    return data


@router.get("/api/action_policy")
def api_action_policy():
    return pipeline.get_action_policy()


@router.post("/api/action_policy")
def api_set_action_policy(mode: str):
    try:
        return pipeline.set_action_mode(mode)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
