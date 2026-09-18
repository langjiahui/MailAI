"""小邮助手：问答、告警、简报与会话历史。"""
import json
import logging

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse, Response, StreamingResponse

from ... import assistant_actions, config, db, mail_assistant
from ..helpers import prepare_assistant_images, prepare_assistant_materials
from ..schemas import AssistantRequest

log = logging.getLogger(__name__)
router = APIRouter()


@router.get("/api/assistant/alerts")
def api_assistant_alerts():
    return mail_assistant.alerts()


@router.get('/api/assistant/briefing')
def api_assistant_briefing(focus: str = 'execution'):
    from ... import secretary
    try:
        return secretary.briefing(focus)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@router.post('/api/emails/{email_id}/briefing-dismiss')
def api_briefing_dismiss(email_id: int):
    if not db.get_email(email_id):
        raise HTTPException(404, '邮件不存在')
    with db.conn() as c:
        c.execute('INSERT OR IGNORE INTO briefing_dismissed VALUES(?)', (email_id,))
    return {'ok': True}


@router.delete('/api/emails/{email_id}/briefing-dismiss')
def api_briefing_restore(email_id: int):
    with db.conn() as c:
        c.execute('DELETE FROM briefing_dismissed WHERE email_id=?', (email_id,))
    return {'ok': True}


@router.post("/api/assistant/alerts/seen")
def api_assistant_alerts_seen(payload: dict | None = None):
    return {"ok": True, "seen_at": mail_assistant.mark_risk_alerts_seen((payload or {}).get('ids', []))}


@router.post("/api/assistant/ask")
def api_assistant_ask(payload: AssistantRequest):
    from ... import assistant_vision, assistant_attachments
    images = prepare_assistant_images(payload)
    materials = prepare_assistant_materials(payload, images)
    try:
        conversation_id = payload.conversation_id
        if not conversation_id or not db.assistant_conversation_exists(conversation_id):
            conversation_id = db.create_assistant_conversation(payload.question.strip()[:36] or "新对话")
        db.add_assistant_message(conversation_id, "user", assistant_attachments.history_text(assistant_vision.history_text(payload.question, images),materials), images=images)
        db.set_assistant_alert_context(conversation_id, payload.email_ids if payload.alert_context else [])
        result = mail_assistant.ask(payload.question, payload.history, payload.email_ids, **({'images': images} if images else {}), **({'materials':materials} if materials else {}))
        db.add_assistant_message(conversation_id, "assistant", result["answer"], result.get("sources") or [])
        return {**result, "conversation_id": conversation_id}
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except Exception as exc:
        log.exception("邮件助手回答失败")
        raise HTTPException(500, f"助手暂时不可用: {exc}")


@router.post("/api/assistant/ask-stream")
def api_assistant_ask_stream(payload: AssistantRequest):
    from ... import assistant_vision, assistant_attachments
    images = prepare_assistant_images(payload)
    materials = prepare_assistant_materials(payload, images)
    conversation_id = payload.conversation_id
    if not conversation_id or not db.assistant_conversation_exists(conversation_id):
        conversation_id = db.create_assistant_conversation(payload.question.strip()[:36] or "新对话")
    db.add_assistant_message(conversation_id, "user", assistant_attachments.history_text(assistant_vision.history_text(payload.question, images),materials), images=images)
    db.set_assistant_alert_context(conversation_id, payload.email_ids if payload.alert_context else [])

    def generate():
        answer_parts, sources = [], []
        try:
            yield json.dumps({"type": "meta", "conversation_id": conversation_id}, ensure_ascii=False) + "\n"
            yield json.dumps({'type': 'scope', 'label': payload.scope_label or config.IMAP_USER}, ensure_ascii=False) + '\n'
            for event, value in mail_assistant.ask_stream(payload.question, payload.history, payload.email_ids, **({'images': images} if images else {}), **({'materials':materials} if materials else {})):
                if event == "sources":
                    sources = value
                    yield json.dumps({"type": "sources", "sources": value}, ensure_ascii=False) + "\n"
                elif event == "action":
                    yield json.dumps({"type": "action", "action": value}, ensure_ascii=False) + "\n"
                elif event == "status":
                    yield json.dumps({"type": "status", **value}, ensure_ascii=False) + "\n"
                else:
                    answer_parts.append(value)
                    yield json.dumps({"type": "delta", "content": value}, ensure_ascii=False) + "\n"
            answer = "".join(answer_parts).strip()
            answer = mail_assistant.validated_citations(answer, sources)
            if not answer:
                answer = mail_assistant._empty_answer(payload.question)
                yield json.dumps({"type": "delta", "content": answer}, ensure_ascii=False) + "\n"
            db.add_assistant_message(conversation_id, "assistant", answer, sources)
            yield json.dumps({"type": "done"}, ensure_ascii=False) + "\n"
        except Exception as exc:
            log.exception("助手流式回答失败")
            message = str(exc) if isinstance(exc, assistant_vision.ImageAnalysisError) else '分析中断，已生成的内容保留，可重试。'
            answer = mail_assistant.validated_citations(''.join(answer_parts), sources) + '\n\n' + message
            db.add_assistant_message(conversation_id, "assistant", answer, sources)
            yield json.dumps({"type": "error", "message": message}, ensure_ascii=False) + "\n"
    return StreamingResponse(generate(), media_type="application/x-ndjson")


@router.post("/api/assistant/actions/execute")
def api_assistant_action_execute(payload: dict):
    """执行用户已确认的助手建议操作（白名单：create_todo/draft_reply/mark_read）。

    助手本身从不执行操作——这里处理的是界面上用户点击"确认执行"后的提交，
    审计日志以 actor="assistant_confirmed" 记录。
    """
    action_type = str(payload.get("type") or "")
    params = payload.get("params") if isinstance(payload.get("params"), dict) else {}
    try:
        return assistant_actions.execute_action(action_type, params)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except Exception:
        log.exception("助手受控操作执行失败")
        raise HTTPException(500, "操作执行失败，请稍后重试")


@router.get("/api/assistant/semantic")
def api_assistant_semantic_status():
    from ... import semantic
    return semantic.index_stats()


@router.post("/api/assistant/semantic/reindex")
def api_assistant_semantic_reindex():
    """重建语义索引。首次会联网下载嵌入模型（约 100MB），由用户显式触发。"""
    from ... import semantic
    if not semantic.deps_available():
        raise HTTPException(400, "未安装语义检索依赖（fastembed），请安装 requirements-semantic.txt 后重启")
    try:
        return semantic.reindex()
    except Exception as exc:
        log.exception("语义索引重建失败")
        raise HTTPException(500, f"索引重建失败: {exc}")


@router.get("/api/assistant/conversations")
def api_assistant_conversations(limit: int = 50):
    return db.list_assistant_conversations(limit)


@router.get("/api/assistant/images/{image_id}")
def api_assistant_image(image_id: int, thumbnail: bool = False):
    item = db.get_assistant_image(image_id, thumbnail)
    if not item:
        raise HTTPException(404, "图片不存在或已清理")
    return Response(item['data'], media_type='image/jpeg' if thumbnail else item['mime'],
                    headers={'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'})


@router.get("/api/assistant/conversations/{conversation_id}")
def api_assistant_conversation(conversation_id: int):
    if not db.assistant_conversation_exists(conversation_id):
        raise HTTPException(404, "会话不存在")
    messages = db.get_assistant_messages(conversation_id)
    return {"id": conversation_id, "messages": messages, **db.assistant_alert_context(conversation_id, messages)}


@router.get('/api/emails/{email_id}/assistant-attachments')
def api_assistant_attachment_catalog(email_id:int):
    from ... import assistant_attachments
    try:return assistant_attachments.catalog(email_id)
    except ValueError as exc:raise HTTPException(400,str(exc))


@router.get('/api/emails/{email_id}/assistant-attachments/{index}')
def api_assistant_attachment_preview(email_id:int,index:int):
    from ... import assistant_attachments
    try:
        item=assistant_attachments.extract(email_id,index)
        item['text']=item['text'][:2200]
        return JSONResponse(item, headers={'Cache-Control':'no-store'})
    except ValueError as exc:raise HTTPException(400,str(exc))
