"""Offline usage ledger and SSE trailing usage regression."""
import io
import json
import tempfile
import sys
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import config
from app.llm import client, usage

with tempfile.TemporaryDirectory() as root, patch.object(config,'USER_DATA_DIR',root), patch.object(config,'IMAP_USER','a@test'), patch.object(config,'LLM_API_KEY','fixture'):
    ctx = usage.context('custom','https://example.test/v1/chat/completions','model-a')
    usage.record(ctx, {'usage':{'prompt_tokens':10,'completion_tokens':5,'total_tokens':15}})
    usage.record(ctx, {'usage':{'total_tokens':15}})
    usage.record(usage.context('other','https://example.test/v1','model-b'))
    assert usage.summary()['total'] == 15
    assert usage.summary()['calls'] == 2
    assert usage.summary()['unreported'] == 1
    payload = b'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":4,"total_tokens":24}}\n\ndata: [DONE]\n\n'
    with patch.object(client.urllib.request,'urlopen',return_value=io.BytesIO(payload)), patch.object(config,'IMAP_USER','b@test'):
        assert ''.join(client.chat_completion_stream([{'role':'user','content':'PRIVATE BODY'}])) == 'ok'
    assert usage.summary()['total'] == 39
    assert usage.summary(account='b@test')['total'] == 24
    assert usage.summary(account='a@test')['total'] == 15
    assert usage.summary(period='today')['calls'] == 3
    # Kimi Code only reports stream usage when explicitly requested. Both the
    # assistant and daily digest must consume the trailing empty-choices event.
    def kimi_stream(req, **kwargs):
        body = json.loads(req.data)
        assert body['stream_options'] == {'include_usage': True}
        assert 'temperature' not in body
        return io.BytesIO(payload)
    with patch.object(config,'LLM_PROVIDER','kimi_code'), patch.object(config,'LLM_EXTRA_PARAMS',{}), patch.object(client.urllib.request,'urlopen',side_effect=kimi_stream):
        for require_completion in (False, True):
            before = usage.summary()['total']
            assert ''.join(client.chat_completion_stream([{'role':'user','content':'PRIVATE BODY'}], require_completion=require_completion)) == 'ok'
            assert usage.summary()['total'] == before + 24
        assert usage.summary()['unreported'] == 1
    # Explicit opt-out remains possible for gateways rejecting stream_options.
    with patch.object(config,'LLM_PROVIDER','kimi_code'), patch.object(config,'LLM_EXTRA_PARAMS',{'stream_options':None}), patch.object(client.urllib.request,'urlopen',return_value=io.BytesIO(b'data: [DONE]\n')) as request:
        list(client.chat_completion_stream([]))
        assert 'stream_options' not in json.loads(request.call_args.args[0].data)
    raw = Path(root,'model-usage.sqlite3').read_bytes()
    assert b'PRIVATE BODY' not in raw and b'fixture' not in raw
    with patch.object(usage,'connect',side_effect=OSError('locked')):
        usage.record(ctx)
print('PASS usage totals, unknowns, deduplication, account scope, stream terminal usage and privacy')
