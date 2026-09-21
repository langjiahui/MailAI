"""邮件解析：正文提取、URL/附件元数据、认证头、敏感信息打码。"""
import base64
import email.utils
from email import policy
from email.parser import BytesParser
import html as html_mod
import os
import re
import hashlib
from email.header import decode_header
from functools import lru_cache
from urllib.parse import unquote

import mailparser

from . import config

_URL_RE = re.compile(r'https?://[^\s<>"\'\]\)）】]+', re.I)
_HREF_RE = re.compile(r'href=["\'](https?://[^"\']+)["\']', re.I)
_TAG_RE = re.compile(r"<[^>]+>")
_PHONE_RE = re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)")
_IDCARD_RE = re.compile(r"(?<!\d)\d{17}[\dXx](?!\d)")
_BANKCARD_RE = re.compile(r"(?<!\d)\d{16,19}(?!\d)")
_CID_REF_RE = re.compile(r"cid:([^\"'\s>]+)", re.I)
_MOJIBAKE_MARKERS_RE = re.compile(r"(?:Ã.|Â.|Ð.|Ñ.|�|\uFFFD)")


def looks_corrupted(text: str) -> bool:
    """保守识别常见乱码，避免把编码异常当成邮件安全证据。"""
    value = str(text or "")
    compact = re.sub(r"\s+", "", value)
    if len(compact) < 12:
        return False
    if value.count("\ufffd") >= 2 or len(_MOJIBAKE_MARKERS_RE.findall(value)) >= 3:
        return True
    script_counts = [
        len(re.findall(r"[\u0370-\u03ff]", value)),
        len(re.findall(r"[\u0400-\u052f]", value)),
        len(re.findall(r"[\u0590-\u06ff]", value)),
        len(re.findall(r"[\u07c0-\u08ff]", value)),
    ]
    suspicious = sum(script_counts)
    # GBK/GB2312 被错误解码后通常混入多种希腊、斯拉夫、阿拉伯/NKo 字符。
    if suspicious >= 6 and sum(count > 0 for count in script_counts) >= 2 \
            and suspicious / len(compact) >= .06:
        return True
    latin_ext = sum(1 for char in compact if 0x80 <= ord(char) <= 0x024F)
    cjk = sum(1 for char in compact if '\u3400' <= char <= '\u9fff')
    if latin_ext >= 10 and latin_ext / len(compact) >= .18 and cjk == 0:
        return True
    return False


def _decoded_text_part(part) -> str:
    """按 MIME 声明解码正文；声明错误时在常见中英文编码中选择可靠候选。"""
    payload = part.get_payload(decode=True) or b""
    declared = (part.get_content_charset() or "").strip().lower()
    candidates = []
    for encoding in (declared, "utf-8", "gb18030", "gbk", "big5", "windows-1252"):
        if not encoding or encoding in {item[0] for item in candidates}:
            continue
        try:
            decoded = payload.decode(encoding, "strict")
        except (LookupError, UnicodeDecodeError):
            continue
        candidates.append((encoding, decoded))
        if encoding == declared and not looks_corrupted(decoded):
            return decoded
    if not candidates:
        try:
            return payload.decode(declared or "utf-8", "replace")
        except LookupError:
            return payload.decode("utf-8", "replace")

    def quality(item):
        encoding, decoded = item
        compact = re.sub(r"\s+", "", decoded)
        printable = sum(char.isprintable() for char in compact)
        cjk = sum(1 for char in compact if '\u3400' <= char <= '\u9fff')
        penalty = 120 if looks_corrupted(decoded) else 0
        return printable + cjk * 2 + (8 if encoding == declared else 0) - penalty

    return max(candidates, key=quality)[1]


def _message_bodies(msg, fallback_mail) -> tuple[str, str, bool]:
    """优先使用 stdlib MIME 解码，绕开第三方解析器对 GB2312 的错误转码。"""
    decoded = {}
    for kind in ("plain", "html"):
        part = msg.get_body(preferencelist=(kind,))
        if part:
            decoded[kind] = _decoded_text_part(part)
    body_plain = decoded.get("plain") or ("\n".join(fallback_mail.text_plain) if fallback_mail.text_plain else "")
    body_html = decoded.get("html") or ("\n".join(fallback_mail.text_html) if fallback_mail.text_html else "")
    body_text = body_plain or strip_html(body_html)
    body_text = re.sub(r"\n{3,}", "\n\n", body_text).strip()
    warning = looks_corrupted(body_text)
    if warning:
        body_text = "正文编码异常，已暂停基于正文内容的 AI 判断。请查看原始邮件确认内容。"
    return body_text, body_html, warning


def strip_html(raw_html: str) -> str:
    text = _TAG_RE.sub(" ", raw_html or "")
    text = html_mod.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def extract_urls(text: str, raw_html: str) -> list[str]:
    urls = set(_URL_RE.findall(text or ""))
    urls.update(_HREF_RE.findall(raw_html or ""))
    urls.update(_URL_RE.findall(raw_html or ""))
    clean = []
    for u in urls:
        u = u.rstrip(".,;，。；")
        if u.lower().startswith(("http://", "https://")):
            clean.append(u)
    return sorted(clean)


def _normalize_cid(value: str) -> str:
    """把 MIME Content-ID 与 HTML cid: 引用归一化为同一个键。"""
    return unquote(html_mod.unescape(str(value or ""))).strip().strip("<>").lower()


def _referenced_cids(raw: bytes) -> set[str]:
    """收集 HTML 正文实际引用的内嵌资源，避免把签名图标列为附件。"""
    referenced: set[str] = set()
    try:
        msg = BytesParser(policy=policy.default).parsebytes(raw)
        for part in msg.walk():
            if part.get_content_type() != "text/html":
                continue
            try:
                content = str(part.get_content())
            except Exception:
                payload = part.get_payload(decode=True) or b""
                content = payload.decode(part.get_content_charset() or "utf-8", "ignore")
            referenced.update(
                cid for cid in (_normalize_cid(item) for item in _CID_REF_RE.findall(content)) if cid
            )
    except Exception:
        pass
    return referenced


def _visible_attachments(raw: bytes, mail=None) -> list[dict]:
    """返回用户可见附件；HTML 引用的 CID 资源属于正文而非附件。"""
    parsed = mail or mailparser.parse_from_bytes(raw)
    referenced = _referenced_cids(raw)
    visible = []
    for item in parsed.attachments or []:
        disposition = str(item.get("content-disposition") or "").split(";", 1)[0].strip().lower()
        cid = _normalize_cid(item.get("content-id"))
        if disposition == "inline" or (cid and cid in referenced):
            continue
        visible.append(item)
    return visible


def _attachment_payload(item: dict) -> bytes:
    payload = item.get("payload") or b""
    if isinstance(payload, bytes):
        return payload
    if isinstance(payload, str):
        try:
            compact = payload.strip().replace("\n", "").replace("\r", "")
            decoded = base64.b64decode(compact, validate=True)
            return decoded if decoded else payload.encode("latin-1")
        except Exception:
            return payload.encode("latin-1")
    return b""


def attachment_metadata(raw: bytes) -> list[dict]:
    """提取与下载索引一致的用户可见附件元数据。"""
    mail = mailparser.parse_from_bytes(raw)
    return [
        {
            "name": item.get("filename") or "未命名",
            "content_type": item.get("mail_content_type") or "application/octet-stream",
            "size": len(_attachment_payload(item)),
        }
        for item in _visible_attachments(raw, mail)
    ]


def attachment_metadata_from_path(raw_path: str) -> list[dict] | None:
    """从本地原始邮件重建附件元数据；文件不存在或解析失败时返回 None。"""
    if not raw_path or not os.path.exists(raw_path):
        return None
    try:
        with open(raw_path, "rb") as f:
            return attachment_metadata(f.read())
    except Exception:
        return None


def extract_attachment(raw_path: str, index: int) -> dict | None:
    """从已保存的原始 .eml 文件中提取指定索引的附件内容。"""
    if not raw_path or not os.path.exists(raw_path):
        return None
    try:
        with open(raw_path, "rb") as f:
            raw = f.read()
        mail = mailparser.parse_from_bytes(raw)
        atts = _visible_attachments(raw, mail)
        if not atts or index < 0 or index >= len(atts):
            return None
        att = atts[index]
        payload = _attachment_payload(att)
        return {
            "name": att.get("filename") or "未命名",
            "content_type": att.get("mail_content_type") or "application/octet-stream",
            "size": len(payload),
            "payload": payload,
        }
    except Exception:
        return None


def extract_rich_body(raw_path: str, email_id: int) -> str:
    """从原始 MIME 恢复 HTML 正文，并把 cid 内嵌资源改写为受控本地地址。"""
    if not raw_path or not os.path.exists(raw_path):
        return ""
    try:
        with open(raw_path, "rb") as f:
            msg = BytesParser(policy=policy.default).parse(f)
        part = msg.get_body(preferencelist=("html",))
        if not part:
            return ""
        content = part.get_content()
        cid_map = {}
        inline_index = 0
        for item in msg.walk():
            cid = (item.get("Content-ID") or "").strip().strip("<>")
            if cid:
                cid_map[cid.lower()] = inline_index
                inline_index += 1
        def repl(match):
            cid = match.group(1).strip().strip("<>").lower()
            index = cid_map.get(cid)
            return f"/api/emails/{email_id}/inline/{index}" if index is not None else ""
        return re.sub(r"cid:([^\"' >]+)", repl, str(content), flags=re.I)
    except Exception:
        return ""


def extract_inline_resource(raw_path: str, index: int) -> dict | None:
    if not raw_path or not os.path.exists(raw_path):
        return None
    try:
        with open(raw_path, "rb") as f:
            msg = BytesParser(policy=policy.default).parse(f)
        items = [part for part in msg.walk() if part.get("Content-ID")]
        if index < 0 or index >= len(items):
            return None
        part = items[index]
        payload = part.get_payload(decode=True) or b""
        return {"payload": payload, "content_type": part.get_content_type(), "size": len(payload)}
    except Exception:
        return None


def redact(text: str) -> str:
    """送 LLM 前的敏感信息打码。"""
    if not config.REDACT_BEFORE_LLM:
        return text
    text = _PHONE_RE.sub("[手机号]", text)
    text = _IDCARD_RE.sub("[身份证号]", text)
    text = _BANKCARD_RE.sub("[银行卡号]", text)
    return text


def _decode_hdr(value) -> str:
    """解码 RFC2047 编码的邮件头（中文显示名等）。"""
    if not value:
        return ""
    out = []
    try:
        for txt, charset in decode_header(str(value)):
            out.append(txt.decode(charset or "utf-8", "ignore") if isinstance(txt, bytes) else txt)
    except Exception:
        return str(value)
    return "".join(out)


def _addr_of(value) -> str:
    """从地址头提取纯邮箱地址。"""
    _, addr = email.utils.parseaddr(_decode_hdr(value))
    return (addr or "").lower()


def _first_msgid(value: str) -> str:
    """从 In-Reply-To / References 头中提取第一个 Message-ID。"""
    if not value:
        return ""
    # Message-ID 形如 <abc@domain.com>；可能有多个用空白分隔
    m = re.search(r'<[^<>]+@[^<>]+>', value)
    return m.group(0).strip().lower() if m else ""


def _thread_id(msg) -> str:
    """基于 threading 头生成会话 ID。"""
    irt = _first_msgid(msg.get("In-Reply-To", ""))
    refs = _first_msgid(msg.get("References", ""))
    mid = (msg.get("Message-ID") or "").strip().lower()
    return irt or refs or mid or f"uid-{id(msg)}"


def recipient_header_names(message) -> dict[str, str]:
    """Return exact address/display-name pairs carried by recipient headers."""
    result = {}
    for field in ("To", "Cc", "Bcc"):
        for name, address in email.utils.getaddresses([_decode_hdr(message.get(field, ""))]):
            address = (address or "").strip().casefold()
            name = (name or "").strip(' \t\r\n"')
            if address and name and "@" not in name and name.casefold() != address:
                result[address] = name[:160]
    return result


@lru_cache(maxsize=8192)
def _cached_recipient_names(path: str, mtime_ns: int, size: int) -> dict[str, str]:
    # Keyed by file identity so newly synchronized/replaced raw mail is reparsed.
    with open(path, "rb") as source:
        lines, remaining = [], 1024 * 1024
        while remaining:
            line = source.readline(remaining)
            if not line:
                break
            lines.append(line)
            remaining -= len(line)
            if line in (b'\n', b'\r\n'):
                break
    message = BytesParser(policy=policy.default).parsebytes(b''.join(lines), headersonly=True)
    return recipient_header_names(message)


def recipient_names_from_raw_path(path: str) -> dict[str, str]:
    """Read only a bounded RFC822 header block from an existing local message."""
    if not path or not os.path.isfile(path):
        return {}
    try:
        stat = os.stat(path)
        return dict(_cached_recipient_names(os.path.abspath(path), stat.st_mtime_ns, stat.st_size))
    except (OSError, ValueError):
        return {}


def cc_from_raw_path(path: str) -> str | None:
    """Recover Cc for older records from a bounded local header block."""
    if not path:
        return None
    try:
        with open(path, 'rb') as source:
            lines, remaining = [], 1024 * 1024
            while remaining:
                line = source.readline(remaining)
                if not line:
                    break
                lines.append(line)
                remaining -= len(line)
                if line in (b'\n', b'\r\n'):
                    break
        msg = BytesParser(policy=policy.default).parsebytes(b''.join(lines), headersonly=True)
        return ', '.join(a for _, a in email.utils.getaddresses([_decode_hdr(v) for v in msg.get_all('Cc', [])]) if a)
    except (OSError, ValueError):
        return None


def parse_message(uid: int, raw: bytes, save_raw: bool = True, folder: str = "INBOX") -> dict:
    mail = mailparser.parse_from_bytes(raw)
    msg = BytesParser(policy=policy.default).parsebytes(raw)
    body_text, body_html, body_decode_warning = _message_bodies(msg, mail)

    # 地址头用 stdlib 解码+解析，对编码/多值鲁棒
    from_name, from_addr = "", ""
    pairs = email.utils.getaddresses([_decode_hdr(msg.get("From", ""))])
    if pairs:
        from_name, from_addr = pairs[0][0] or "", (pairs[0][1] or "").lower()
    to_pairs = email.utils.getaddresses([_decode_hdr(msg.get("To", ""))])
    to_addr = ", ".join(a for _, a in to_pairs if a)

    headers = {}
    for k, v in msg.items():
        key = k.lower()
        val = _decode_hdr(v)
        headers[key] = f"{headers[key]}; {val}" if key in headers else val
    auth_raw = headers.get("authentication-results", "")

    attachments = attachment_metadata(raw)

    raw_path = ""
    if save_raw:
        folder_key = hashlib.sha1((folder or "INBOX").encode("utf-8")).hexdigest()[:10]
        raw_folder = config.RAW_DIR if folder == config.INBOX_FOLDER else os.path.join(config.RAW_DIR, folder_key)
        os.makedirs(raw_folder, exist_ok=True)
        raw_path = os.path.join(raw_folder, f"{uid}.eml")
        with open(raw_path, "wb") as f:
            f.write(raw)

    date_str = mail.date.isoformat(sep=" ", timespec="seconds") if mail.date else ""

    return {
        "uid": uid,
        "message_id": (mail.message_id or "").strip(),
        "in_reply_to": _first_msgid(msg.get("In-Reply-To", "")),
        "references_header": msg.get("References", "").strip(),
        "thread_id": _thread_id(msg),
        "subject": _decode_hdr(mail.subject or "") or "(无主题)",
        "from_addr": from_addr,
        "from_name": from_name,
        "to_addr": to_addr,
        "cc_addr": ', '.join(a for _, a in email.utils.getaddresses([_decode_hdr(v) for v in msg.get_all('Cc', [])]) if a),
        "recipient_names": recipient_header_names(msg),
        "date": date_str,
        "snippet": re.sub(r"\s+", " ", body_text)[:200],
        "body_text": body_text,
        "body_html": body_html,
        "body_decode_warning": body_decode_warning,
        "urls": extract_urls(body_text, body_html),
        "attachments": attachments,
        "headers": headers,
        "auth_raw": auth_raw,
        "reply_to": _addr_of(msg.get("Reply-To", "")),
        "return_path": _addr_of(msg.get("Return-Path", "")),
        "list_unsubscribe": headers.get("list-unsubscribe", ""),
        "precedence": headers.get("precedence", ""),
        "raw_path": raw_path,
    }
