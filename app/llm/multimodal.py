"""图片附件多模态复核：识别二维码、仿冒登录页、付款/凭据诱导等视觉证据。"""
import base64
import logging

from .. import config, parser
from . import client

log = logging.getLogger(__name__)

_SYSTEM = """你是企业邮件安全视觉分析器。只分析图片中可见的安全证据，尤其关注：
1. 二维码及其可辨识的目标文本或域名；2. 仿冒登录页、账号验证、扫码登录；
3. 付款、红包、工资、发票等诱导；4. 紧迫、威胁或要求绕过正常流程的话术。
不要因为图片存在就判定恶意。必须输出严格 JSON：
{"risk": "clean|suspicious|phishing", "confidence": 0到1, "qr_present": true或false,
 "qr_target": "可辨识时填写，否则空字符串", "evidence": ["具体可见证据"], "summary": "一句话结论"}。"""


def _image_parts(email: dict) -> list[dict]:
    parts = []
    for idx, att in enumerate(email.get("attachments") or []):
        content_type = (att.get("content_type") or "").lower()
        if not content_type.startswith("image/"):
            continue
        full = parser.extract_attachment(email.get("raw_path"), idx)
        if not full:
            continue
        payload = full.get("payload") or b""
        if not payload or len(payload) > config.MULTIMODAL_MAX_IMAGE_BYTES:
            continue
        encoded = base64.b64encode(payload).decode("ascii")
        parts.append({
            "type": "image_url",
            "image_url": {"url": f"data:{content_type};base64,{encoded}"},
        })
        if len(parts) >= config.MULTIMODAL_MAX_IMAGES:
            break
    return parts


def analyze_images(email: dict) -> dict | None:
    if not config.MULTIMODAL_ENABLED or not client.available():
        return None
    images = _image_parts(email)
    if not images:
        return None
    reliable_body = "" if email.get("body_decode_warning") or parser.looks_corrupted(email.get("body_text", "")) \
        else email.get("body_text", "")[:1200]
    context = parser.redact(
        f"主题：{email.get('subject', '')}\n发件人：{email.get('from_addr', '')}\n"
        f"正文摘要：{reliable_body or '（正文编码异常，不作为视觉风险判断依据）'}"
    )
    messages = [
        {"role": "system", "content": _SYSTEM},
        {"role": "user", "content": [{"type": "text", "text": context}, *images]},
    ]
    result = client.chat_completion(
        messages, response_format={"type": "json_object"}, temperature=0.1,
        max_tokens=600, model=config.MULTIMODAL_MODEL,
    )
    if not result:
        return None
    content = result.get("choices", [{}])[0].get("message", {}).get("content") or ""
    parsed = client._extract_json(content)
    if not parsed:
        log.warning("多模态模型返回不可解析内容: %s", content[:200])
        return None
    risk = parsed.get("risk")
    if risk not in ("clean", "suspicious", "phishing"):
        return None
    try:
        parsed["confidence"] = max(0.0, min(1.0, float(parsed.get("confidence", 0))))
    except (TypeError, ValueError):
        parsed["confidence"] = 0.0
    parsed["evidence"] = [str(x)[:240] for x in (parsed.get("evidence") or [])[:6]]
    parsed["qr_present"] = bool(parsed.get("qr_present"))
    parsed["qr_target"] = str(parsed.get("qr_target") or "")[:500]
    parsed["summary"] = str(parsed.get("summary") or "")[:500]
    return parsed


def to_findings(review: dict | None) -> list[dict]:
    if not review or review.get("risk") == "clean" or review.get("confidence", 0) < 0.6:
        return []
    weight = 35 if review["risk"] == "phishing" else 15
    detail = review.get("summary") or "图片包含可疑社工诱导内容"
    findings = [{"code": "VISION_SOCIAL_ENGINEERING", "detail": detail, "weight": weight}]
    if review.get("qr_present"):
        target = review.get("qr_target") or "目标不可辨识"
        findings.append({"code": "VISION_QR", "detail": f"图片含二维码：{target}", "weight": 15})
    return findings
