"""LLM HTTP 客户端：使用 urllib.request，兼容内网网关/自签证书等 httpx 握手失败的场景。"""
import json
import logging
import re
import socket
import time
import ssl
import urllib.error
import urllib.request
from typing import Any

from .. import config
from .providers import completion_url, adapt_body
from . import usage

log = logging.getLogger(__name__)
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_STREAM_LINE_BYTES = 128 * 1024
MAX_STREAM_TEXT = 100000


def _response_chunks(resp, deadline):
    """Bound bytes and wall time, including gateways that never finish output."""
    total = 0
    while True:
        if time.monotonic() >= deadline:
            raise RuntimeError('模型响应超时，请缩小分析范围后重试')
        chunk = resp.read1(16384)
        if not chunk:
            return
        total += len(chunk)
        if total > MAX_RESPONSE_BYTES:
            raise RuntimeError('模型响应过大，请分批分析')
        yield chunk


def _response_lines(resp, deadline):
    pending = b''
    for chunk in _response_chunks(resp, deadline):
        pending += chunk
        lines = pending.split(b'\n')
        pending = lines.pop()
        for line in lines:
            if len(line) > MAX_STREAM_LINE_BYTES:
                raise RuntimeError('模型返回了过大的数据行')
            yield line
        if len(pending) > MAX_STREAM_LINE_BYTES:
            raise RuntimeError('模型返回了过大的数据行')
    if pending:
        yield pending


def _ssl_context(verify_ssl: bool | None = None) -> ssl.SSLContext:
    """构造 SSL 上下文。
    默认使用系统证书并校验；内网自签/异常网关可设 LLM_VERIFY_SSL=false。"""
    should_verify = config.LLM_VERIFY_SSL if verify_ssl is None else verify_ssl
    if should_verify:
        ctx = ssl.create_default_context()
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    else:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        ctx.minimum_version = ssl.TLSVersion.TLSv1
        ctx.options |= ssl.OP_LEGACY_SERVER_CONNECT
    return ctx


def available() -> bool:
    return bool(config.LLM_API_KEY)


def chat_completion(messages: list[dict[str, Any]], *, response_format: dict | None = None,
                    temperature: float = 0.1, stream: bool = False,
                    max_tokens: int | None = None, timeout: int | None = None,
                    model: str | None = None, base_url: str | None = None,
                    api_key: str | None = None, verify_ssl: bool | None = None,
                    provider: str | None = None, extra_params: dict | None = None,
                    raise_errors: bool = False) -> dict | None:
    """调用 OpenAI 兼容 chat completions 接口，返回解析后的 JSON 响应。"""
    effective_api_key = config.LLM_API_KEY if api_key is None else api_key
    if not effective_api_key:
        return None
    effective_base_url = config.LLM_BASE_URL if base_url is None else base_url
    url = completion_url(effective_base_url)
    body: dict[str, Any] = {"model": model or config.LLM_MODEL, "messages": messages,
                            "temperature": temperature}
    if response_format:
        body["response_format"] = response_format
    if max_tokens:
        body["max_tokens"] = max_tokens
    body = adapt_body(body, provider or config.LLM_PROVIDER,
                      config.LLM_EXTRA_PARAMS if extra_params is None else extra_params)
    req = urllib.request.Request(
        url, data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": f"Bearer {effective_api_key}",
                 "Content-Type": "application/json; charset=utf-8"}, method="POST")
    usage_ctx = usage.context(provider or config.LLM_PROVIDER, url, body['model'])
    result = None
    try:
        deadline = time.monotonic() + min(timeout or config.LLM_TIMEOUT, 300)
        with urllib.request.urlopen(req, context=_ssl_context(verify_ssl), timeout=min(timeout or config.LLM_TIMEOUT, 300)) as resp:
            raw = b''.join(_response_chunks(resp, deadline)).decode("utf-8")
            try:
                result = json.loads(raw)
            except json.JSONDecodeError:
                pass
    except urllib.error.HTTPError as e:
        log.warning("LLM HTTP %s", e.code)
        e.close()
        if raise_errors:
            detail = {401: "API Key 无效", 403: "无权访问此模型", 402: "账户余额不足",
                      404: "接口地址或模型不存在", 429: "请求限流或额度不足",
                      400: "模型或请求参数不兼容"}.get(e.code, "服务商请求失败")
            raise RuntimeError(f"{detail}（HTTP {e.code}）") from None
        return None
    except (socket.timeout, urllib.error.URLError) as e:
        log.warning("LLM 连接失败: %s", e)
        if raise_errors:
            raise RuntimeError("连接失败或超时，请检查网络、API 地址和证书") from None
        return None
    except Exception as e:
        log.warning("LLM 请求异常: %s", e)
        if raise_errors:
            raise RuntimeError("模型请求失败，请检查接口与响应格式") from None
        return None
    finally:
        usage.record(usage_ctx, result if isinstance(result, dict) else None)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        log.warning("LLM 返回非 JSON: %s", raw[:200])
        return None


def chat_completion_stream(messages: list[dict[str, Any]], *, temperature: float = 0.2,
                           max_tokens: int | None = None, timeout: int | None = None,
                           model: str | None = None, require_completion: bool = False):
    """逐段产出 OpenAI 兼容 SSE 响应中的文本 delta。"""
    if not available():
        return
    url = completion_url(config.LLM_BASE_URL)
    body: dict[str, Any] = {
        "model": model or config.LLM_MODEL,
        "messages": messages,
        "temperature": temperature,
        "stream": True,
    }
    if max_tokens:
        body["max_tokens"] = max_tokens
    # Unknown gateways retain their existing request contract. They can opt in
    # through extra_params; absent usage is explicitly recorded as unreported.
    if config.LLM_PROVIDER in ('deepseek', 'kimi', 'kimi_code', 'ollama'):
        body['stream_options'] = {'include_usage': True}
    body = adapt_body(body, config.LLM_PROVIDER, config.LLM_EXTRA_PARAMS)
    usage_ctx = usage.context(config.LLM_PROVIDER, url, body['model'])
    usage_response = None
    req = urllib.request.Request(
        url, data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": f"Bearer {config.LLM_API_KEY}",
                 "Content-Type": "application/json; charset=utf-8",
                 "Accept": "text/event-stream"}, method="POST",
    )
    emitted = finished = False
    text_length = 0
    try:
        deadline = time.monotonic() + min(timeout or config.LLM_TIMEOUT, 300)
        with urllib.request.urlopen(req, context=_ssl_context(), timeout=min(timeout or config.LLM_TIMEOUT, 300)) as resp:
            for raw_line in _response_lines(resp, deadline):
                line = raw_line.decode("utf-8", errors="ignore").strip()
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    finished = True
                    break
                try:
                    event = json.loads(payload)
                    if event.get('usage'):
                        usage_response = event
                    choice = event.get("choices", [{}])[0]
                    if choice.get('finish_reason') == 'length' and require_completion:
                        raise RuntimeError('模型输出达到长度上限，分析尚未完成')
                    if choice.get('finish_reason') == 'stop':
                        finished = True
                    # 兼容标准 OpenAI SSE、部分内网网关的 message.content，及分段内容数组。
                    content = (choice.get("delta") or {}).get("content")
                    if content is None:
                        content = (choice.get("message") or {}).get("content")
                    if isinstance(content, list):
                        content = "".join(
                            str(part.get("text") or part.get("content") or "")
                            for part in content if isinstance(part, dict)
                        )
                    if isinstance(content, str) and content:
                        text_length += len(content)
                        if text_length > MAX_STREAM_TEXT:
                            raise RuntimeError('模型输出过长，请分批分析')
                        emitted = True
                        yield content
                    # Final usage can arrive after finish_reason, with choices=[].
                except (json.JSONDecodeError, TypeError, IndexError):
                    continue
        if require_completion and emitted and not finished:
            raise RuntimeError('模型连接提前结束，分析尚未完成')
    except Exception as exc:
        log.warning("LLM 流式请求异常: %s", exc)
        if require_completion and emitted:
            raise RuntimeError('分析连接中断，请重试') from exc
        return
    finally:
        usage.record(usage_ctx, usage_response)

def _extract_json(text: str) -> dict | None:
    text = text.strip()
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return None


def chat_json(system: str, user: str, max_retries: int = 2, *, timeout: int | None = None) -> dict | None:
    """要求模型输出 JSON 并解析；失败自动降级重试。"""
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
    for attempt in range(max_retries + 1):
        kwargs = {"timeout": timeout} if timeout is not None else {}
        if attempt == 0:
            kwargs["response_format"] = {"type": "json_object"}
        result = chat_completion(messages, temperature=0.1, **kwargs)
        if result is None:
            # 可能是 response_format 不被支持，下一轮降级
            continue
        content = result.get("choices", [{}])[0].get("message", {}).get("content") or ""
        parsed = _extract_json(content)
        if parsed is not None:
            return parsed
        log.warning("LLM 返回非 JSON（第 %d 次）: %s", attempt + 1, content[:200])
    return None
