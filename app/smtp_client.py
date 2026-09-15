"""SMTP 发件与已发送归档。SMTP 账号可独立于当前 IMAP 收件账号。"""
import re
import base64
import hashlib
import smtplib
import ssl
import certifi
from email.header import decode_header
from email.message import EmailMessage
from email.utils import formataddr, formatdate, getaddresses, make_msgid

from imapclient import IMAPClient

from . import config


def _credentials() -> tuple[str, str]:
    if config.SMTP_USE_IMAP_CREDENTIALS:
        return config.IMAP_USER, config.IMAP_PASSWORD
    return config.SMTP_USER, config.SMTP_PASSWORD


def configured() -> bool:
    user, password = _credentials()
    return bool(config.SMTP_HOST and user and password)


def identity_matches_current_mailbox() -> bool:
    """禁止用其他 SMTP 身份回复当前邮箱，避免误用测试账号发件。"""
    user, _ = _credentials()
    return configured() and bool(config.IMAP_USER) and user.strip().lower() == config.IMAP_USER.strip().lower()


def _ssl_context():
    if config.SMTP_VERIFY_SSL:
        return ssl.create_default_context(cafile=certifi.where())
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def test_connection(values: dict) -> dict:
    """只建立 SMTP 会话并认证，不发送测试邮件。"""
    host = str(values.get("smtp_host") or "").strip()
    port = int(values.get("smtp_port") or 465)
    user = str(values.get("smtp_user") or values.get("user") or "").strip()
    password = str(values.get("password") or "")
    verify = bool(values.get("smtp_verify_ssl", values.get("verify_ssl", True)))
    ctx = ssl.create_default_context(cafile=certifi.where()) if verify else ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    if not verify:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    use_ssl = bool(values.get("smtp_ssl", True))
    client = (smtplib.SMTP_SSL(host, port, timeout=15, context=ctx) if use_ssl
              else smtplib.SMTP(host, port, timeout=15))
    with client:
        client.ehlo()
        if bool(values.get("smtp_starttls", False)) and not use_ssl:
            client.starttls(context=ctx)
            client.ehlo()
        client.login(user, password)
    return {"ok": True, "host": host, "port": port}


def _normalize_address_separators(value: str) -> str:
    parts, token = [], []
    quoted = escaped = False
    angle = 0
    for char in str(value or ''):
        if char in '\r\n' and (quoted or angle):
            raise ValueError('邮箱姓名或地址中不能包含换行')
        if escaped:
            token.append(char)
            escaped = False
            continue
        if char == '\\' and quoted:
            escaped = True
        elif char == '"':
            quoted = not quoted
        elif not quoted:
            if char == '<':
                angle += 1
            elif char == '>':
                angle -= 1
            elif not angle and char in ',，；;\r\n':
                if ''.join(token).strip():
                    parts.append(''.join(token).strip())
                token = []
                continue
        if angle < 0 or angle > 1:
            raise ValueError('邮箱地址的尖括号格式无效')
        token.append(char)
    if quoted or escaped or angle:
        raise ValueError('邮箱姓名的引号或地址的尖括号未闭合')
    if ''.join(token).strip():
        parts.append(''.join(token).strip())
    return ', '.join(parts)


def _parse_address_field(value: str, seen: set[str]) -> tuple[str, list[str]]:
    """Normalize user-friendly separators and return one safe header + envelope list."""
    raw = _normalize_address_separators(value)
    if not raw:
        return "", []
    parsed = getaddresses([raw])
    header_values: list[str] = []
    envelope: list[str] = []
    for name, address in parsed:
        addr = address.strip()
        if not addr:
            continue
        if not re.fullmatch(r"[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+", addr):
            raise ValueError(f"邮箱地址格式无效: {addr}")
        key = addr.casefold()
        if key in seen:
            continue
        seen.add(key)
        envelope.append(addr)
        header_values.append(formataddr((name.strip(), addr)) if name.strip() else addr)
    return ", ".join(header_values), envelope


def normalize_recipient_fields(data: dict) -> dict:
    """Canonicalize To/Cc/Bcc and remove duplicates in delivery priority order."""
    seen: set[str] = set()
    normalized: dict[str, str] = {}
    recipients: list[str] = []
    for key in ("to_addr", "cc_addr", "bcc_addr"):
        normalized[key], addresses = _parse_address_field(data.get(key, ""), seen)
        recipients.extend(addresses)
    if len(recipients) > config.SMTP_MAX_RECIPIENTS:
        raise ValueError(f"收件人不能超过 {config.SMTP_MAX_RECIPIENTS} 人")
    normalized["recipients"] = recipients
    return normalized


def recipient_fields_for_display(normalized: dict) -> dict[str, str]:
    """Turn RFC transport encoding back into stable, human-readable compose values."""
    result: dict[str, str] = {}
    for key in ("to_addr", "cc_addr", "bcc_addr"):
        values = []
        for encoded_name, address in getaddresses([str(normalized.get(key) or "")]):
            parts = []
            for value, charset in decode_header(encoded_name or ""):
                if isinstance(value, bytes):
                    parts.append(value.decode(charset or "utf-8", "replace"))
                else:
                    parts.append(value)
            name = "".join(parts).strip().replace("\r", " ").replace("\n", " ")
            if name:
                escaped = name.replace("\\", "\\\\").replace('"', '\\"')
                label = f'"{escaped}"' if re.search(r'[,;"<>，；():@\[\]\\]', name) else name
                values.append(f"{label} <{address}>")
            elif address:
                values.append(address)
        result[key] = ", ".join(values)
    return result


def _prepare_inline_images(html: str) -> tuple[str, list[tuple[bytes, str, str]]]:
    """Turn editor data-URL images into MIME related parts for real mail clients."""
    images: list[tuple[bytes, str, str]] = []
    allowed = {"png", "jpeg", "gif", "webp"}
    pattern = re.compile(r'(<img\b[^>]*\bsrc\s*=\s*)(["\'])data:image/([a-z0-9.+-]+);base64,([^"\']+)\2', re.I)

    def replace(match):
        subtype = match.group(3).lower().replace("jpg", "jpeg")
        if subtype not in allowed:
            raise ValueError(f"不支持的正文图片类型: {subtype}")
        try:
            payload = base64.b64decode(re.sub(r"\s+", "", match.group(4)), validate=True)
        except Exception as exc:
            raise ValueError("正文图片数据无效") from exc
        if len(payload) > 5 * 1024 * 1024:
            raise ValueError("单张正文图片不能超过 5MB")
        cid = make_msgid(domain="mailai.local")[1:-1]
        images.append((payload, subtype, cid))
        return f'{match.group(1)}{match.group(2)}cid:{cid}{match.group(2)}'

    cleaned = pattern.sub(replace, html)
    return cleaned, images


def build_message(data: dict) -> tuple[EmailMessage, list[str]]:
    if not configured():
        raise RuntimeError("SMTP 尚未配置")
    if not identity_matches_current_mailbox():
        raise RuntimeError("SMTP 发件账号与当前登录邮箱不一致，已阻止发送")
    normalized = normalize_recipient_fields(data)
    recipients = normalized.pop("recipients")
    if not recipients:
        raise ValueError("至少需要一个收件人")
    subject = (data.get("subject") or "").strip()
    if "\r" in subject or "\n" in subject:
        raise ValueError("主题不能包含换行")
    html = (data.get("body_html") or "").strip()
    if not html:
        raise ValueError("邮件正文不能为空")
    html = re.sub(r"<\s*(script|iframe|object|embed|form)[^>]*>.*?<\s*/\s*\1\s*>", "", html,
                  flags=re.I | re.S)
    html = re.sub(r"\s+on[a-z]+\s*=\s*(['\"]).*?\1", "", html, flags=re.I | re.S)
    html, inline_images = _prepare_inline_images(html)
    user, _ = _credentials()
    msg = EmailMessage()
    msg["From"] = user
    if normalized["to_addr"]:
        msg["To"] = normalized["to_addr"]
    if normalized["cc_addr"]:
        msg["Cc"] = normalized["cc_addr"]
    msg["Subject"] = subject or "（无主题）"
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain=user.split("@")[-1])
    if data.get("in_reply_to"):
        msg["In-Reply-To"] = data["in_reply_to"]
        msg["References"] = data.get("references") or data["in_reply_to"]
    plain = re.sub(r"<br\s*/?>", "\n", html, flags=re.I)
    plain = re.sub(r"<[^>]+>", "", plain)
    msg.set_content(plain)
    msg.add_alternative(html, subtype="html")
    total_size = sum(len(payload) for payload, _, _ in inline_images)
    if total_size > 25 * 1024 * 1024:
        raise ValueError("正文图片与附件总大小不能超过 25MB")
    html_part = msg.get_payload()[-1]
    for payload, subtype, cid in inline_images:
        html_part.add_related(payload, maintype="image", subtype=subtype, cid=f"<{cid}>",
                              filename=f"mailai-inline-{len(cid)}.{subtype}", disposition="inline")
    for item in data.get("attachments") or []:
        filename = re.sub(r"[\\/\r\n]", "_", str(item.get("filename") or "附件"))[:180]
        try:
            if not isinstance(item.get("data_base64"), str):
                raise ValueError("缺少附件内容")
            payload = base64.b64decode(item["data_base64"], validate=True)
        except Exception as exc:
            raise ValueError(f"附件 {filename} 数据无效") from exc
        if item.get("size") is not None and item["size"] != len(payload):
            raise ValueError(f"附件 {filename} 内容不完整，请移除后重新添加")
        if item.get("sha256") and hashlib.sha256(payload).hexdigest() != item["sha256"]:
            raise ValueError(f"附件 {filename} 校验失败，请移除后重新添加")
        total_size += len(payload)
        if len(payload) > 20 * 1024 * 1024 or total_size > 25 * 1024 * 1024:
            raise ValueError("附件总大小不能超过 25MB，单个附件不能超过 20MB")
        content_type = str(item.get("content_type") or "application/octet-stream")
        maintype, _, subtype = content_type.partition("/")
        msg.add_attachment(payload, maintype=maintype or "application",
                           subtype=subtype or "octet-stream", filename=filename)
    return msg, recipients


def _archive_sent(raw: bytes) -> str:
    host = config.SMTP_SENT_IMAP_HOST.strip() or config.IMAP_HOST.strip()
    if not host:
        return ""
    if host.casefold() != config.IMAP_HOST.strip().casefold():
        raise ValueError("归档服务器与当前收件服务器不一致，请检查配置")
    ctx = ssl.create_default_context(cafile=certifi.where())
    if not config.IMAP_VERIFY_SSL:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    with IMAPClient(host, port=config.IMAP_PORT, ssl=config.IMAP_SSL,
                    ssl_context=ctx if config.IMAP_SSL else None, timeout=15) as client:
        client.login(config.IMAP_USER, config.IMAP_PASSWORD)
        folders = client.list_folders()
        def text(value):
            return value.decode(errors="replace") if isinstance(value, bytes) else str(value)
        selectable = [(flags, name) for flags, _, name in folders
                      if not any(text(flag).casefold() == "\\noselect" for flag in flags)]
        target = config.SMTP_SENT_FOLDER.strip()
        if not target:
            target = next((name for flags, name in selectable
                           if any(text(flag).casefold() == "\\sent" for flag in flags)), "")
        if not target:
            target = next((name for _, name in selectable if text(name).casefold() in
                           {"sent", "sent messages", "sent items", "已发送", "已发送邮件"}), "Sent Messages")
        existing = next((name for _, name in selectable if text(name) == text(target)), None)
        if existing is None:
            if any(text(name) == text(target) for _, _, name in folders):
                raise ValueError("已发送文件夹不可写入")
            client.create_folder(target)
        else:
            target = existing
        client.append(target, raw, ["\\Seen"])
        return target.decode(errors="replace") if isinstance(target, bytes) else str(target)


def send(data: dict) -> dict:
    msg, recipients = build_message(data)
    user, password = _credentials()
    ctx = _ssl_context()
    if config.SMTP_SSL:
        client = smtplib.SMTP_SSL(config.SMTP_HOST, config.SMTP_PORT, timeout=30, context=ctx)
    else:
        client = smtplib.SMTP(config.SMTP_HOST, config.SMTP_PORT, timeout=30)
    accepted = False
    warnings = []
    try:
        client.ehlo()
        if config.SMTP_STARTTLS and not config.SMTP_SSL:
            client.starttls(context=ctx)
            client.ehlo()
        client.login(user, password)
        refused = client.send_message(msg, from_addr=user, to_addrs=recipients)
        accepted = True
    finally:
        try:
            client.quit()
        except Exception:
            try:
                client.close()
            except Exception:
                pass
            if accepted:
                warnings.append("邮件已被发送服务器接受，关闭连接时出现异常；无需重复发送。")
    raw = msg.as_bytes()
    if refused:
        warnings.append("部分收件人被拒绝：" + ", ".join(refused) + "。其他收件人已被服务器接受，请勿向全部收件人重复发送。")
    sent_folder = ""
    try:
        sent_folder = _archive_sent(raw)
    except Exception:
        warnings.append("邮件已被发送服务器接受，但服务器已发送归档失败；请勿重复发送。")
    return {"message_id": msg["Message-ID"], "recipients": len(recipients) - len(refused),
            "refused_recipients": list(refused), "sent_folder": sent_folder,
            "warning": " ".join(warnings)}
