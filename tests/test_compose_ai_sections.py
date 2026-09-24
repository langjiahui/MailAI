"""AI draft parts should not leak into the message body or duplicate signatures."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.web.routes.compose import _structured_compose_result
from app.web.routes import compose
from app.web.schemas import ComposeAssistRequest
import json
import asyncio


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


if __name__ == "__main__":
    test_structured_parts()
    test_plain_response_with_placeholder()
    test_compose_stream_progress_and_final_parts()
    test_compose_stream_interruption_never_completes()
