"""OpenAI Chat Completions provider presets and shared URL validation."""
from urllib.parse import urlsplit, urlunsplit

PRESETS = [
    dict(id='custom', name='自部署模型', base_url='', model='', multimodal_enabled=False),
    dict(id='other', name='其他厂商（通用 API）', base_url='', model='', multimodal_enabled=False),
    dict(id='deepseek', name='DeepSeek', base_url='https://api.deepseek.com/v1', model='deepseek-v4-flash', multimodal_enabled=False),
    dict(id='kimi_code', name='Kimi Code（编程订阅）', base_url='https://api.kimi.com/coding/v1', model='kimi-for-coding', multimodal_enabled=False),
    dict(id='kimi', name='Kimi（月之暗面）', base_url='https://api.moonshot.cn/v1', model='kimi-k2.6', multimodal_enabled=True),
    dict(id='ollama', name='Ollama（本地模型）', base_url='http://localhost:11434/v1', model='qwen2.5:7b-instruct', multimodal_enabled=False),
]

# 不校验 API Key 的本地服务：保存配置时允许使用占位密钥
KEYLESS_PROVIDERS = {'ollama'}
KEYLESS_PLACEHOLDER = 'ollama'


def completion_url(base_url):
    value = base_url.strip().rstrip('/')
    parsed = urlsplit(value)
    if (parsed.scheme not in ('http', 'https') or not parsed.hostname or
            parsed.username or parsed.password or parsed.query or parsed.fragment or
            any(c.isspace() for c in value)):
        raise ValueError('API 地址须为 http(s) 地址，不能包含账号、查询参数或片段')
    try:
        parsed.port
    except ValueError:
        raise ValueError('API 地址端口无效') from None
    path = parsed.path.rstrip('/')
    if not path.endswith('/chat/completions'):
        # Keep the legacy gateway /openapi -> /openapi/v1 contract.
        path += '/chat/completions' if path.endswith('/v1') else '/v1/chat/completions'
    return urlunsplit((parsed.scheme, parsed.netloc, path, '', ''))


def validate_extra(params):
    if not isinstance(params, dict):
        raise ValueError('扩展参数必须是 JSON 对象')
    if {'model', 'messages', 'stream', 'api_key', 'base_url'} & params.keys():
        raise ValueError('扩展参数不能覆盖模型、消息、流式开关或密钥地址')
    return params


def adapt_body(body, provider, extra):
    model = body['model'].lower()
    if provider == 'kimi_code':
        body.pop('temperature', None)
    elif provider == 'kimi' and model.startswith('kimi-k2.'):
        body.pop('temperature', None)
        if model in ('kimi-k2.5', 'kimi-k2.6'):
            body['thinking'] = {'type': 'disabled'}
    elif provider == 'kimi' and model.startswith('kimi-k3'):
        body.pop('temperature', None)
        body['reasoning_effort'] = 'low'
        if 'max_tokens' in body:
            body['max_completion_tokens'] = body.pop('max_tokens')
    elif provider == 'deepseek' and model.startswith('deepseek-v4'):
        body['thinking'] = {'type': 'disabled'}
    body.update(validate_extra(extra))
    # null explicitly omits an optional parameter for incompatible gateways.
    return {k: v for k, v in body.items() if v is not None}
