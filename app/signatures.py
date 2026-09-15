"""Per-mailbox signature profiles and safe AI-assisted signature creation."""
from __future__ import annotations

import html
import json
import re
import uuid

from . import config, db
from .llm import client as llm_client


SETTING_KEY = "mail_signatures_v1"
PROFILE_FIELDS = ("name", "title", "department", "company", "phone", "email", "website")


def sanitize_html(value: str) -> str:
    """Remove active content while retaining ordinary rich signature markup."""
    value = str(value or "")[:50000]
    value = re.sub(r"<\s*(script|style|iframe|object|embed|form)[^>]*>.*?<\s*/\s*\1\s*>", "", value,
                   flags=re.I | re.S)
    value = re.sub(r"<\s*(script|style|iframe|object|embed|form)[^>]*/?\s*>", "", value, flags=re.I)
    value = re.sub(r"\s+on[a-z]+\s*=\s*(['\"]).*?\1", "", value, flags=re.I | re.S)
    value = re.sub(r"\s+on[a-z]+\s*=\s*[^\s>]+", "", value, flags=re.I)
    value = re.sub(r"(href|src)\s*=\s*(['\"])\s*javascript:.*?\2", r'\1="#"', value, flags=re.I | re.S)
    return value.strip()


def _clean_profile(profile: dict | None) -> dict:
    source = profile if isinstance(profile, dict) else {}
    return {field: str(source.get(field) or "").strip()[:200] for field in PROFILE_FIELDS}


def load() -> dict:
    raw = db.get_runtime_settings().get(SETTING_KEY, "")
    try:
        state = json.loads(raw) if raw else {}
    except (TypeError, json.JSONDecodeError):
        state = {}
    items = []
    for item in state.get("items") or []:
        if not isinstance(item, dict) or not str(item.get("name") or "").strip():
            continue
        items.append({
            "id": str(item.get("id") or uuid.uuid4().hex),
            "name": str(item.get("name"))[:80],
            "html": sanitize_html(item.get("html") or ""),
        })
    default_id = str(state.get("default_id") or "")
    if default_id and default_id not in {item["id"] for item in items}:
        default_id = ""
    profile = _clean_profile(state.get("profile"))
    if not profile["email"]:
        profile["email"] = config.IMAP_USER
    return {"items": items[:20], "default_id": default_id, "profile": profile,
            "sender": config.IMAP_USER, "ai_available": llm_client.available()}


def save(item: dict, profile: dict | None = None, make_default: bool = False) -> dict:
    state = load()
    signature_id = str(item.get("id") or uuid.uuid4().hex)
    saved = {"id": signature_id, "name": str(item.get("name") or "我的签名").strip()[:80],
             "html": sanitize_html(item.get("html") or "")}
    if not saved["html"]:
        raise ValueError("签名内容不能为空")
    state["items"] = [saved if old["id"] == signature_id else old for old in state["items"]]
    if signature_id not in {old["id"] for old in state["items"]}:
        state["items"].append(saved)
    state["profile"] = _clean_profile(profile) if profile is not None else state["profile"]
    if make_default or not state["default_id"]:
        state["default_id"] = signature_id
    db.set_runtime_setting(SETTING_KEY, json.dumps({key: state[key] for key in ("items", "default_id", "profile")}, ensure_ascii=False))
    return state


def delete(signature_id: str) -> dict:
    state = load()
    state["items"] = [item for item in state["items"] if item["id"] != signature_id]
    if state["default_id"] == signature_id:
        state["default_id"] = state["items"][0]["id"] if state["items"] else ""
    db.set_runtime_setting(SETTING_KEY, json.dumps({key: state[key] for key in ("items", "default_id", "profile")}, ensure_ascii=False))
    return state


def set_default(signature_id: str) -> dict:
    state = load()
    if signature_id and signature_id not in {item["id"] for item in state["items"]}:
        raise ValueError("签名不存在")
    state["default_id"] = signature_id
    db.set_runtime_setting(SETTING_KEY, json.dumps({key: state[key] for key in ("items", "default_id", "profile")}, ensure_ascii=False))
    return state


def _signature_html(profile: dict, closing: str, tagline: str) -> str:
    name = html.escape(profile.get("name") or profile.get("email") or "")
    role = " · ".join(html.escape(profile.get(key) or "") for key in ("title", "department") if profile.get(key))
    company = html.escape(profile.get("company") or "")
    contact = []
    if profile.get("phone"):
        contact.append(f"电话 {html.escape(profile['phone'])}")
    if profile.get("email"):
        email_value = html.escape(profile["email"])
        contact.append(f'<a href="mailto:{email_value}" style="color:#28745a;text-decoration:none">{email_value}</a>')
    if profile.get("website"):
        website = profile["website"] if re.match(r"https?://", profile["website"], re.I) else "https://" + profile["website"]
        contact.append(f'<a href="{html.escape(website, quote=True)}" style="color:#28745a;text-decoration:none">{html.escape(profile["website"])}</a>')
    lines = [f'<div style="font-size:13px;color:#33473e"><div style="margin-bottom:10px">{html.escape(closing)}</div>',
             '<div style="width:36px;border-top:2px solid #3d8b6e;margin:0 0 10px"></div>',
             f'<div style="font-size:16px;font-weight:700;color:#214c3b">{name}</div>']
    if role: lines.append(f'<div style="margin-top:2px;color:#60736a">{role}</div>')
    if company: lines.append(f'<div style="margin-top:2px;color:#60736a">{company}</div>')
    if contact: lines.append(f'<div style="margin-top:7px;color:#73827b">{" &nbsp;·&nbsp; ".join(contact)}</div>')
    if tagline: lines.append(f'<div style="margin-top:8px;color:#4b7565;font-style:italic">{html.escape(tagline)}</div>')
    lines.append('</div>')
    return "".join(lines)


def generate(profile: dict, style: str = "专业简洁") -> list[dict]:
    profile = _clean_profile(profile)
    if not any(profile.values()):
        raise ValueError("请至少填写姓名或邮箱")
    system = ("你是企业邮件签名文案助手。只输出 JSON："
              '{"options":[{"name":"名称","closing":"结束语","tagline":"一句短标语"}]}。'
              "生成3套差异明显但克制可信的中文签名文案，不虚构用户资料，不添加联系方式，"
              "结束语不超过10字，标语不超过24字，不使用 Markdown。")
    result = llm_client.chat_json(system, f"风格：{style}\n用户资料：{json.dumps(profile, ensure_ascii=False)}")
    if not result:
        raise RuntimeError("AI 签名服务暂时不可用")
    options = []
    for index, option in enumerate((result.get("options") or [])[:3]):
        if not isinstance(option, dict):
            continue
        closing = str(option.get("closing") or "祝好").strip()[:20]
        tagline = str(option.get("tagline") or "").strip()[:60]
        options.append({"name": str(option.get("name") or f"AI 签名 {index + 1}")[:40],
                        "html": _signature_html(profile, closing, tagline)})
    if not options:
        raise RuntimeError("AI 没有返回可用签名")
    return options
