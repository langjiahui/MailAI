"""写信：草稿、发件、签名、发送前检查与发件箱队列。"""
import logging

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from ... import config, db, outgoing_guard, signatures, smtp_client, system_settings
from ... import parser as mail_parser
from ...llm import client as llm_client
from ...parser import extract_rich_body
from ..helpers import annotate_list_identities, current_server
from ..schemas import (ComposeAssistRequest, DraftRequest, MailPreflightRequest,
                       QueuedMailRequest, SendMailRequest, SignatureGenerateRequest,
                       SignatureRequest)

log = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/drafts")
def api_drafts():
    local = db.list_drafts()
    remote = []
    for row in db.list_special_folder_emails("draft"):
        rich_body = extract_rich_body(row.get("raw_path"), row["id"]) or row.get("body_html") or ""
        remote.append({**row, "body_html": rich_body, "id": -row["id"], "remote_email_id": row["id"],
                       "updated_at": row.get("date"), "attachments": row.get("attachments") or [],
                       "_remote": True})
    return local + remote


@router.get("/api/drafts/{draft_id}")
def api_draft(draft_id: int):
    row = db.get_draft(draft_id)
    if not row:
        raise HTTPException(404, "草稿不存在")
    return row


@router.post("/api/drafts")
def api_save_draft(payload: DraftRequest):
    from ...outbox import draft_pending
    if payload.id and not db.get_draft(payload.id):
        raise HTTPException(409, "草稿已发送或删除，请关闭编辑窗口后重新打开")
    if draft_pending(payload.id):
        raise HTTPException(409, '这份草稿已有发送任务，请先在任务与发件箱中撤销或确认发送结果')
    if payload.source_draft_email_id:
        source = db.get_email(payload.source_draft_email_id)
        if not source or source.get("status") != "draft" or source.get("remote_missing"):
            raise HTTPException(409, "来源服务器草稿已变化，请重新打开草稿")
    draft_id = db.save_draft(payload.model_dump(), payload.id)
    return {"ok": True, "id": draft_id}


@router.delete("/api/drafts/{draft_id}")
def api_delete_draft(draft_id: int):
    from ...outbox import draft_pending
    if draft_pending(draft_id):
        raise HTTPException(409, '草稿已有发送任务，请先撤销发送或核对发送结果')
    if draft_id < 0:
        email_id = -draft_id
        row = db.get_email(email_id)
        if not row or row.get("status") != "draft":
            raise HTTPException(404, "服务器草稿不存在")
        try:
            with current_server().MailClient() as mail:
                target_uid, target = mail.move_to_trash(row["uid"], row["folder"])
            db.set_status(email_id, "trash", target)
            db.set_mail_state(email_id, uid=target_uid)
            db.add_audit_log(email_id, "discard_remote_draft", actor="user",
                             reason=f"移动服务器草稿到 {target}")
            return {"ok": True, "remote": True, "folder": target}
        except Exception as exc:
            log.exception("舍弃服务器草稿失败")
            raise HTTPException(502, f"舍弃服务器草稿失败: {exc}")
    db.delete_draft(draft_id)
    return {"ok": True}


@router.get("/api/mail/sent")
def api_sent_messages(limit: int = 500):
    local = db.list_sent_messages(limit)
    local_message_ids = {str(item.get("message_id") or "").strip().casefold()
                         for item in local if item.get("message_id")}
    remote = []
    for row in db.list_special_folder_emails("sent", limit):
        message_id = str(row.get("message_id") or "").strip().casefold()
        if message_id and message_id in local_message_ids:
            continue
        rich_body = extract_rich_body(row.get("raw_path"), row["id"]) or row.get("body_html") or ""
        remote.append({**row, "body_html": rich_body, "id": -row["id"], "remote_email_id": row["id"],
                       "sent_at": row.get("date"), "status": "sent",
                       "attachments": row.get("attachments") or [], "_remote": True})
    result = sorted(local + remote, key=lambda item: item.get("sent_at") or item.get("created_at") or "",
                    reverse=True)[:max(1, min(limit, 5000))]
    annotate_list_identities(result)
    return result


@router.get("/api/mail/sent/{record_id}")
def api_sent_message(record_id: int):
    row = db.get_sent_message(record_id)
    if not row:
        raise HTTPException(404, "发送记录不存在")
    return row


@router.get("/api/mail/send-capability")
def api_send_capability():
    configured = smtp_client.configured()
    matched = smtp_client.identity_matches_current_mailbox()
    verified = system_settings.current_smtp_verified()
    if not configured:
        reason = "当前邮箱尚未配置 SMTP"
    elif not matched:
        reason = "测试 SMTP 与当前企业邮箱不一致"
    elif not verified:
        reason = "收件邮箱已连接，但发件服务尚未验证；请在邮箱账号设置中修复"
    else:
        reason = ""
    return {
        "configured": matched and verified,
        "from_addr": config.IMAP_USER,
        "smtp_configured": configured,
        "identity_matched": matched,
        "smtp_verified": verified,
        "reason": reason,
    }


@router.post("/api/mail/compose/assist")
def api_compose_assist(payload: ComposeAssistRequest):
    operations = {
        "draft": "根据主题和已有要点起草一封完整邮件",
        "reply": "根据原邮件和已有内容生成直接、完整的回复",
        "forward": "根据原邮件和已有内容生成简洁的转发说明，只说明转发目的和希望收件人采取的行动，不复述完整原邮件",
        "polish": "润色邮件，修正语病并保持原意",
        "shorten": "压缩邮件，使其更简洁但不遗漏关键事项",
        "translate_en": "将邮件翻译为自然、专业的英文",
    }
    instruction = operations.get(payload.operation)
    if not instruction:
        raise HTTPException(400, "不支持的 AI 写信操作")
    if payload.operation in {"polish", "shorten", "translate_en"} and not payload.body_text.strip():
        raise HTTPException(400, "请先填写需要改写的正文")

    references: list[tuple[str, str]] = []
    basis: list[str] = []
    values = (
        ("写作要求", payload.user_instruction[:1000]),
        ("邮件主题", payload.subject[:300]),
        ("收件人", payload.recipients[:1000]),
        ("原邮件", payload.original_text[:5000]),
        ("已有正文", payload.body_text[:5000]),
    )
    for label, value in values:
        if value.strip():
            basis.append(label)
            references.append((label, value.strip()))
    attachment_names = [str(name).strip()[:240] for name in payload.attachment_names[:20] if str(name).strip()]
    if attachment_names:
        basis.append("附件名称")
        references.append(("附件名称（仅文件名，未读取附件正文）", "；".join(attachment_names)))
    if not references:
        raise HTTPException(400, "请先填写写作要求、主题或正文")

    length_guidance = {
        "简短": "控制在 120 字左右，直达结论和行动项",
        "详细": "可分段说明背景、事项和下一步，但避免冗余",
    }.get(payload.length, "篇幅适中，完整覆盖关键事项")
    reference_text = "\n\n".join(f"【{label}】\n{value}" for label, value in references)
    messages = [
        {"role": "system", "content": "你是企业邮件写作助手。只输出可直接使用的邮件正文，不解释过程，不使用 Markdown 代码块。严格依据用户提供的参考内容，不得虚构姓名、日期、数字、附件内容或承诺；信息不足时使用中性表达或明确保留待确认项。"},
        {"role": "user", "content": f"任务：{instruction}\n语气：{payload.tone}\n篇幅：{length_guidance}\n\n以下是本次允许参考的内容：\n{reference_text}"},
    ]
    result = llm_client.chat_completion(messages, temperature=0.25, max_tokens=1200, timeout=45)
    if not result:
        raise HTTPException(502, "AI 写作服务暂时不可用")
    content = result.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
    if not content:
        raise HTTPException(502, "AI 没有返回可用正文")
    return {"ok": True, "content": content, "basis": basis}


@router.get("/api/mail/signatures")
def api_mail_signatures():
    return signatures.load()


@router.post("/api/mail/signatures")
def api_save_mail_signature(payload: SignatureRequest):
    try:
        return signatures.save(payload.model_dump(), payload.profile, payload.make_default)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@router.delete("/api/mail/signatures/{signature_id}")
def api_delete_mail_signature(signature_id: str):
    return signatures.delete(signature_id)


@router.post("/api/mail/signatures/{signature_id}/default")
def api_default_mail_signature(signature_id: str):
    try:
        return signatures.set_default("" if signature_id == "none" else signature_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc))


@router.post("/api/mail/signatures/generate")
def api_generate_mail_signature(payload: SignatureGenerateRequest):
    try:
        return {"ok": True, "options": signatures.generate(payload.profile, payload.style)}
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except RuntimeError as exc:
        raise HTTPException(502, str(exc))


@router.post("/api/mail/preflight")
def api_mail_preflight(payload: MailPreflightRequest):
    try:
        normalized = smtp_client.normalize_recipient_fields(payload.model_dump())
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    envelope_recipients = normalized.pop("recipients")
    if not envelope_recipients:
        raise HTTPException(400, "至少需要一个有效的收件人")
    review = outgoing_guard.review(payload.model_dump(), envelope_recipients)
    return {**review, "recipients": smtp_client.recipient_fields_for_display(normalized),
            "recipient_count": len(envelope_recipients)}


@router.post("/api/mail/send")
def api_send_mail(payload: SendMailRequest):
    data = payload.model_dump()
    data["from_addr"] = config.IMAP_USER
    try:
        normalized = smtp_client.normalize_recipient_fields(data)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    envelope_recipients = normalized.pop("recipients")
    if not envelope_recipients:
        raise HTTPException(400, "至少需要一个有效的收件人")
    data.update(normalized)
    local_review = outgoing_guard.local_issues({
        **data,
        "body_text": mail_parser.strip_html(payload.body_html),
        "attachment_names": [str(item.get("name") or "") for item in payload.attachments if isinstance(item, dict)],
        "attachment_count": len(payload.attachments),
    }, envelope_recipients)
    dangerous = [item for item in local_review if item.get("level") == "danger"]
    if dangerous and not payload.preflight_confirmed:
        raise HTTPException(400, f"发送前仍有高风险项未确认：{dangerous[0]['message']}")
    record_id = db.create_sent_message(data)
    result = None
    try:
        result = smtp_client.send(data)
        db.finish_sent_message(record_id, ok=True, error=result.get("warning", ""),
                               smtp_response="partially accepted" if result.get("refused_recipients") else "accepted",
                               sent_folder=result["sent_folder"], message_id=result.get("message_id", ""))
        if payload.id:
            db.complete_sent_draft(payload.id)
        db.add_audit_log(None, "send_mail", actor="user", reason=f"发送邮件：{payload.subject}",
                         meta={"message_id": result["message_id"], "recipients": result["recipients"],
                               "preflight_issues": [item["code"] for item in local_review]})
        return {"ok": True, **result}
    except Exception as exc:
        if result is not None:
            log.exception("SMTP 已接收邮件，但本地发送记录更新失败")
            return {"ok": True, **result, "warning": (result.get("warning", "") +
                    " 邮件已被服务器接受，但本地记录更新失败，请勿重复发送。")}
        db.finish_sent_message(record_id, ok=False, error=str(exc)[:500])
        log.exception("发送邮件失败")
        import smtplib
        if isinstance(exc, (smtplib.SMTPRecipientsRefused, smtplib.SMTPAuthenticationError, smtplib.SMTPDataError, ValueError)):
            raise HTTPException(400, f"服务器未接受邮件：{exc}")
        raise HTTPException(502, f"发送失败: {exc}")


@router.post('/api/mail/outbox')
def api_queue_mail(payload: QueuedMailRequest):
    from ...outbox import enqueue
    data = payload.model_dump(exclude={'request_token'})
    try:
        return enqueue(payload.request_token, data)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@router.get('/api/mail/outbox')
def api_outbox():
    from ...outbox import items
    return items()


@router.post('/api/mail/outbox/{token}/cancel')
def api_cancel_outbox(token: str):
    from ...outbox import cancel
    try:
        return cancel(token)
    except ValueError as exc:
        raise HTTPException(409, str(exc))


@router.post('/api/mail/outbox/{token}/resolve')
def api_resolve_outbox(token: str, delivered: bool):
    from ...outbox import resolve
    try:
        return resolve(token, delivered)
    except ValueError as exc:
        raise HTTPException(409, str(exc))


@router.get("/api/drafts/{record_id}/attachments/{att_index}/preview")
def api_preview_draft_attachment(record_id: int, att_index: int, page: int = 0):
    from ...attachment_preview import preview_attachment
    att = db.get_sent_attachment(record_id, att_index, draft=True)
    if att is None:
        raise HTTPException(404, "附件不存在或数据已丢失")
    return preview_attachment(att, page=page)


@router.get("/api/drafts/{record_id}/attachments/{att_index}")
def api_download_draft_attachment(record_id: int, att_index: int):
    from urllib.parse import quote
    att = db.get_sent_attachment(record_id, att_index, draft=True)
    if att is None:
        raise HTTPException(404, "附件不存在或数据已丢失")
    return Response(content=att['payload'], media_type=att['content_type'], headers={
        'Content-Disposition': "attachment; filename*=UTF-8''" + quote(att['name'], safe=''),
        'Content-Length': str(att['size']), 'Cache-Control': 'no-store',
    })


@router.get("/api/mail/sent/{record_id}/attachments/{att_index}/preview")
def api_preview_sent_attachment(record_id: int, att_index: int, page: int = 0):
    from ...attachment_preview import preview_attachment
    att = db.get_sent_attachment(record_id, att_index)
    if att is None:
        raise HTTPException(404, "附件不存在或数据已丢失")
    return preview_attachment(att, page=page)


@router.get("/api/mail/sent/{record_id}/attachments/{att_index}")
def api_download_sent_attachment(record_id: int, att_index: int):
    from urllib.parse import quote
    att = db.get_sent_attachment(record_id, att_index)
    if att is None:
        raise HTTPException(404, "附件不存在或数据已丢失")
    return Response(content=att['payload'], media_type=att['content_type'], headers={
        'Content-Disposition': "attachment; filename*=UTF-8''" + quote(att['name'], safe=''),
        'Content-Length': str(att['size']), 'Cache-Control': 'no-store',
    })
