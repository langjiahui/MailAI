"""安全策略：规则配置、白名单、阈值、聚类战役与处置模式。"""
import logging

from fastapi import APIRouter, HTTPException

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


@router.get("/api/action_policy")
def api_action_policy():
    return pipeline.get_action_policy()


@router.post("/api/action_policy")
def api_set_action_policy(mode: str):
    try:
        return pipeline.set_action_mode(mode)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
