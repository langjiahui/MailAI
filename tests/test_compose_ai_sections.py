"""AI draft parts should not leak into the message body or duplicate signatures."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.web.routes.compose import _structured_compose_result
from app.web.routes import compose
from app.web.schemas import ComposeAssistRequest
import json
import asyncio
from fastapi import HTTPException
import tempfile
from unittest.mock import patch


async def _events(response):
    return [json.loads(line) async for line in response.body_iterator]


def test_structured_parts():
    result = _structured_compose_result('{"subject":"项目材料", "body":"请查收文件。", "signoff":"此致\\n敬礼"}', True)
    assert result == {"subject": "项目材料", "body": "请查收文件。", "signoff": "此致\n敬礼"}
    assert _structured_compose_result('{"subject":"项目材料", "body":"请查收文件。", "signoff":"此致\\n敬礼"}', False)["signoff"] == ""


def test_plain_response_with_placeholder():
    result = _structured_compose_result("主题：项目材料\n\n请查收文件。\n\n此致\n敬礼\nXX（发件人姓名）", True)
    assert result["subject"] == "项目材料"
    assert result["body"] == "请查收文件。"
    assert result["signoff"] == ""


def test_reasoning_is_not_a_draft_part():
    result = _structured_compose_result('<think>internal notes</think>{"subject":"会议通知","body":"周五下午一点，802会议室。"}', False)
    assert result == {'subject':'会议通知', 'body':'周五下午一点，802会议室。', 'signoff':''}
    assert _structured_compose_result('<think>unfinished notes', False)['body'] == ''
    try:
        compose._compose_response_content({'choices':[{'message':{'content':'unfinished draft'}, 'finish_reason':'length'}]})
    except HTTPException as error:
        assert error.status_code == 502
    else:
        raise AssertionError('Truncated model output must not become a completed draft')


def test_compose_stream_progress_and_final_parts():
    def chunks(messages, **kwargs):
        assert "第一行写" in messages[0]["content"]
        assert kwargs["require_completion"] is True
        yield "主题：会议通知\n\n"
        yield "请明天参会。"

    previous = compose.llm_client.chat_completion_stream
    compose.llm_client.chat_completion_stream = chunks
    try:
        response = compose.api_compose_assist_stream(
            ComposeAssistRequest(operation="draft", user_instruction="写一封会议通知", has_signature=True))
        events = asyncio.run(_events(response))
    finally:
        compose.llm_client.chat_completion_stream = previous
    assert [event["type"] for event in events] == ["delta", "delta", "done"]
    assert events[-1]["subject"] == "会议通知"
    assert events[-1]["content"] == "请明天参会。"
    assert events[-1]["signoff"] == ""


def test_compose_stream_interruption_never_completes():
    def chunks(*args, **kwargs):
        yield "未完成的"
        raise RuntimeError("connection closed")

    previous = compose.llm_client.chat_completion_stream
    compose.llm_client.chat_completion_stream = chunks
    try:
        response = compose.api_compose_assist_stream(
            ComposeAssistRequest(operation="draft", user_instruction="写一封会议通知"))
        events = asyncio.run(_events(response))
    finally:
        compose.llm_client.chat_completion_stream = previous
    assert [event["type"] for event in events] == ["delta", "error"]


def test_checks_use_the_actual_allowed_reference_snapshot():
    from app import db, companion_growth
    from app.account_context import use
    with tempfile.TemporaryDirectory() as folder, use({'ACCOUNT_ID':'compose-reference',
        'DB_PATH':str(Path(folder)/'mail.db'),'IMAP_USER':'me@example.test'}):
        db.init_db()
        first = db.upsert_email(dict(uid=1,message_id='<reference-root@example.test>',
            thread_id='<reference-root@example.test>',subject='交付确认',body_text='请确认交付日期。',
            status='inbox',date='2026-11-05T09:00:00'))
        db.upsert_email(dict(uid=2,message_id='<reference-change@example.test>',
            in_reply_to='<reference-root@example.test>',thread_id='<reference-root@example.test>',
            subject='日期调整',body_text='交付日期现调整到2026年12月21日。',
            status='inbox',date='2026-11-05T10:00:00'))
        payload = ComposeAssistRequest(operation='reply',source_email_id=first,
            user_instruction='回复通知中的日期',original_text='请确认交付日期。')
        result = {'choices':[{'message':{'content':'{"subject":"日期确认","body":"已收到交付日期调整到2026年12月21日的通知。"}'},'finish_reason':'stop'}]}
        def chunks(*args,**kwargs):
            yield '主题：日期确认\n\n已收到交付日期调整到2026年12月21日的通知。'
        with patch.object(companion_growth,'safe_record'),patch.object(compose.llm_client,'chat_completion',return_value=result),patch.object(compose.llm_client,'chat_completion_stream',chunks):
            single = compose.api_compose_assist(payload)
            streamed = asyncio.run(_events(compose.api_compose_assist_stream(payload)))[-1]
            for reply in (single,streamed):
                assert next(item for item in reply['checks'] if item['text']=='2026年12月21日')['found_in_reference']
            # Text excluded by the prompt's length bound cannot count as model evidence.
            cropped = compose.api_compose_assist(ComposeAssistRequest(operation='draft',
                user_instruction='起草邮件',original_text='普通材料。'*1500+'2026年12月21日'))
            assert not next(item for item in cropped['checks'] if item['text']=='2026年12月21日')['found_in_reference']


if __name__ == "__main__":
    test_structured_parts()
    test_plain_response_with_placeholder()
    test_reasoning_is_not_a_draft_part()
    test_compose_stream_progress_and_final_parts()
    test_compose_stream_interruption_never_completes()
    test_checks_use_the_actual_allowed_reference_snapshot()
