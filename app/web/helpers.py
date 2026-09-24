"""路由共享辅助函数。从 server.py 拆分，供 app/web/routes/ 各模块复用。"""
import re
import sys
import threading
from email.utils import getaddresses

from fastapi import HTTPException

from .. import config, db, pipeline, system_settings
from ..security import campaigns


def current_server():
    """延迟绑定 app.web.server 模块，使测试可以在导入后 patch server.MailClient。"""
    return sys.modules["app.web.server"]


_campaign_cache_lock = threading.Lock()
_campaign_cache: dict[tuple[str, int], list[dict]] = {}


def campaign_groups(days: int = 30) -> list[dict]:
    """按邮箱修订号缓存聚类结果，避免每次打开详情都重复做两两比对。"""
    bounded_days = max(1, min(int(days or 30), 90))
    revision = db.mailbox_revision()["revision"]
    key = (config.DB_PATH, revision, bounded_days)
    with _campaign_cache_lock:
        cached = _campaign_cache.get(key)
    if cached is not None:
        return cached
    result = campaigns.cluster(db.list_emails(days=bounded_days, limit=600))
    with _campaign_cache_lock:
        for old_key in list(_campaign_cache):
            if old_key[0] == config.DB_PATH and old_key[1] != revision:
                _campaign_cache.pop(old_key, None)
        _campaign_cache[key] = result
    return result


def complete_mailbox_initialization():
    inbox = pipeline.fetch_all(continue_with_folders=True)
    if not inbox.get("canceled"):
        pipeline.sync_auxiliary_folders(preserve_cancel=True, inbox_warning=inbox.get("warning", ""))


def mail_connection_detail(exc: Exception) -> str:
    root = exc.cause if isinstance(exc, system_settings.MailConnectionError) else exc
    stage = "发件（SMTP）" if getattr(exc, "stage", "") == "smtp" else "收件（IMAP）"
    name = type(root).__name__
    message = str(root).lower()
    if any(word in message for word in ("authentication", "login", "535", "password")):
        return f"{stage}账号或授权码验证失败。请确认已开启客户端登录，并重新填写客户端授权码。"
    if any(word in message for word in ("certificate", "ssl", "tls")):
        return f"{stage}SSL 证书校验失败。请确认服务器地址正确；仅在可信内网使用自签名证书时关闭证书校验。"
    if isinstance(root, TimeoutError) or any(word in message for word in ("timed out", "timeout")):
        return f"{stage}连接超时。请检查网络、VPN 和服务器端口。"
    if name == "gaierror" or any(word in message for word in ("nodename nor servname", "name or service not known")):
        return f"{stage}服务器地址无法解析。请检查网络、VPN 和服务器地址。"
    if name in ("ConnectionRefusedError", "ConnectionError", "OSError"):
        return f"无法连接{stage}服务器。请检查服务器地址、端口、网络或 VPN。"
    return f"{stage}验证失败。请展开高级设置检查服务器参数。"


def resolved_contact_name(address: str, current_name: str, names: dict[str, dict]) -> tuple[str, str]:
    normalized_address = str(address or "").strip().casefold()
    current = str(current_name or "").strip().strip('"').strip()
    current_key = current.casefold()
    local_part = normalized_address.partition("@")[0]
    weak_placeholder = bool(current_key) and current_key in {normalized_address, local_part}
    match = names.get(normalized_address) or {}
    # A name explicitly saved by the user is authoritative. Learned history only
    # fills missing/placeholder names and never replaces a meaningful message name.
    if match.get("name") and (
        match.get("source") == "manual" or not current or "@" in current or weak_placeholder
    ):
        return str(match["name"]), str(match.get("source") or "history")
    return current, "message" if current else ""


def annotate_list_identity(item: dict, names: dict[str, dict] | None = None) -> None:
    """Describe the user's role and the useful counterparty for compact list rows."""
    names = names or {}
    sender = str(item.get("from_addr") or "").strip().casefold()
    current = str(config.IMAP_USER or "").strip().casefold()
    outgoing = bool(current and sender == current) or item.get("status") in ("sent", "draft")
    if outgoing:
        recipients = [(name.strip(), address.strip()) for name, address in getaddresses(
            [str(item.get("to_addr") or "")]
        ) if address.strip()]
        name, address = recipients[0] if recipients else ("", str(item.get("to_addr") or "").strip())
        name, source = resolved_contact_name(address, name, names)
        recipient_names = {}
        for original_name, recipient in getaddresses([
            str(value) for value in (item.get("to_addr"), item.get("cc_addr"), item.get("bcc_addr")) if value
        ]):
            resolved, _resolved_source = resolved_contact_name(recipient, original_name, names)
            if recipient and resolved:
                recipient_names[recipient.casefold()] = resolved
        item.update(direction="outgoing", direction_label="发给",
                    counterpart_name=name, counterpart_addr=address,
                    counterpart_count=len(recipients) or int(bool(address)),
                    counterpart_name_source=source, recipient_names=recipient_names)
    else:
        address = str(item.get("from_addr") or "").strip()
        name, source = resolved_contact_name(address, item.get("from_name"), names)
        if name:
            item["from_name"] = name
        item.update(direction="incoming", direction_label="来自",
                    counterpart_name=name, counterpart_addr=address,
                    counterpart_count=1, counterpart_name_source=source)


def annotate_list_identities(items: list[dict]) -> None:
    names = db.contact_display_names([
        value for item in items
        for value in (item.get("from_addr"), item.get("to_addr"), item.get("cc_addr"), item.get("bcc_addr"))
        if value
    ])
    for item in items:
        annotate_list_identity(item, names)


def valid_contact_email(value: str) -> str:
    email = (value or "").strip().lower()
    if not re.fullmatch(r"[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+", email):
        raise HTTPException(400, "请输入有效的邮箱地址")
    return email


def prepare_assistant_images(payload):
    from .. import assistant_vision
    try:
        images = assistant_vision.prepare([item.model_dump() for item in payload.images])
        if images and not assistant_vision.client.available():
            raise ValueError('尚未配置可用模型，图片未发送。请先检查模型连接。')
        if images and not payload.question.strip():
            payload.question = '请提炼这些图片的重点，区分明确事实、待确认信息和建议下一步。'
        return images
    except ValueError as exc:
        raise HTTPException(400, str(exc))


def prepare_assistant_materials(payload, images):
    from .. import assistant_attachments, assistant_vision
    try:
        materials = assistant_attachments.prepare([item.model_dump() for item in payload.attachments])
        if materials and not assistant_vision.client.available():
            raise ValueError('尚未配置可用模型，附件未发送。请先检查模型连接。')
        if len(images)+sum(bool(item.get('image')) for item in materials)>3:
            raise ValueError('上传图片与图片附件合计最多 3 张，请分批分析')
        if materials:
            payload.email_ids = list(dict.fromkeys([m['email_id'] for m in materials]+(payload.email_ids or [])))[:20]
            if not payload.question.strip():
                payload.question = '请结合所选附件与邮件正文，总结重点、差异和待确认事项，并说明提取范围。'
        return materials
    except ValueError as exc:
        raise HTTPException(400,str(exc))


def correspondence_payload(counterpart: str, limit: int = 50) -> dict:
    """Build the shared correspondence response for message and contact entry points."""
    own_address = str(config.IMAP_USER or "").strip().casefold()
    items = db.list_correspondence_emails(counterpart, limit=max(1, min(limit, 100)))
    return {
        "counterpart": counterpart,
        "count": len(items),
        "emails": [{
            "id": item.get("id"), "date": item.get("date"),
            "from_addr": item.get("from_addr"), "from_name": item.get("from_name"),
            "to_addr": item.get("to_addr"), "subject": item.get("subject"),
            "snippet": item.get("snippet"), "verdict": item.get("verdict"),
            "score": item.get("score"), "status": item.get("status"),
            "direction": "sent" if str(item.get("from_addr") or "").strip().casefold() == own_address else "received",
        } for item in items],
    }
