"""Provider contract tests; never contacts a vendor or changes user configuration."""
import io
import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import config, system_settings
from app.llm import client
from app.llm.providers import completion_url, adapt_body


def main():
    coding = adapt_body({"model":"kimi-for-coding", "temperature":0.1, "stream":True}, "kimi_code", {})
    assert "temperature" not in coding and coding["stream"] is True
    assert completion_url("https://api.kimi.com/coding/v1") == "https://api.kimi.com/coding/v1/chat/completions"
    for address, expected in [
        ('https://gateway.test', 'https://gateway.test/v1/chat/completions'),
        ('https://gateway.test/openapi/', 'https://gateway.test/openapi/v1/chat/completions'),
        ('https://api.moonshot.cn/v1/', 'https://api.moonshot.cn/v1/chat/completions'),
        ('https://gateway.test/compatible-mode/v1', 'https://gateway.test/compatible-mode/v1/chat/completions'),
        ('https://gateway.test/api/v4/chat/completions', 'https://gateway.test/api/v4/chat/completions')]:
        assert completion_url(address) == expected
    for bad in ('file:///tmp/key', 'https://user:secret@gateway.test', 'https://gateway.test?key=secret'):
        try: completion_url(bad)
        except ValueError: pass
        else: raise AssertionError(bad)
    keys = ('LLM_BASE_URL', 'LLM_MODEL', 'LLM_PROVIDER', 'LLM_API_KEY', 'LLM_EXTRA_PARAMS',
            'LLM_VERIFY_SSL', 'MULTIMODAL_MODEL', 'MULTIMODAL_ENABLED')
    old = {key: getattr(config, key) for key in keys}
    try:
        config.LLM_BASE_URL = 'https://old.test'
        config.LLM_PROVIDER = 'custom'
        config.LLM_API_KEY = 'old-test-key'
        config.LLM_EXTRA_PARAMS = {'legacy_param': True}
        draft = dict(provider='kimi', base_url='https://api.moonshot.cn/v1', model='kimi-k2.6',
                     api_key='new-test-key', extra_params={}, multimodal_enabled=True)
        with patch.object(client.urllib.request, 'urlopen') as http:
            rejected = system_settings.test_model({**draft, 'api_key': ''})
            assert not rejected['ok'] and '重新填写' in rejected['message']
            http.assert_not_called()
        response = {'choices': [{'message': {'content': 'OK'}, 'finish_reason': 'stop'}]}
        with patch.object(client.urllib.request, 'urlopen', return_value=io.BytesIO(json.dumps(response).encode())) as http:
            assert system_settings.test_model(draft)['ok']
            req = http.call_args.args[0]
            body = json.loads(req.data)
            assert req.full_url == 'https://api.moonshot.cn/v1/chat/completions'
            assert 'temperature' not in body and 'legacy_param' not in body
            assert body['thinking'] == {'type': 'disabled'}
            assert req.get_header('Authorization') == 'Bearer new-test-key'
        assert config.LLM_API_KEY == 'old-test-key'
        vault = {}
        def save_secret(key, value):
            vault[key] = value
            return True
        with tempfile.TemporaryDirectory() as td, patch.object(config, 'DATA_DIR', td), patch.object(system_settings, 'ENV_PATH', str(Path(td) / '.env')), patch.object(system_settings.db, 'add_audit_log'), patch.object(system_settings.credential_store, 'save', side_effect=save_secret), patch.object(system_settings.credential_store, 'load', side_effect=lambda key: vault.get(key, '')):
            # Existing installations predate verification tracking. A valid active
            # config with no profile/marker must stay usable after an upgrade.
            assert system_settings._current_model_verified(), 'legacy active configuration should remain verified'
            system_settings.save_model(draft)
            from dotenv import dotenv_values
            saved = dotenv_values(Path(td) / '.env')
            assert saved['LLM_PROVIDER'] == 'kimi' and saved['LLM_EXTRA_PARAMS'] == '{}'
            assert config.LLM_API_KEY == 'new-test-key'
            assert system_settings._current_model_verified(), 'successful draft test should mark the saved configuration verified'
            profiles = json.loads(Path(td, 'model_profiles.json').read_text())
            assert profiles['kimi']['verification_status'] == 'verified'
            system_settings.save_model({**draft, 'api_key': ''})
            assert config.LLM_API_KEY == 'new-test-key'
            system_settings.save_model({'provider': 'custom'})
            assert config.LLM_API_KEY == 'old-test-key'
            assert system_settings._current_model_verified(), 'legacy active configuration should remain trusted'
            assert config.LLM_BASE_URL == 'https://old.test'
            system_settings.save_model({
                'provider': 'custom', 'base_url': 'https://changed.test/v1',
                'model': 'changed-model', 'api_key': 'changed-test-key', 'extra_params': {}
            })
            assert not system_settings._current_model_verified(), 'newly changed configuration must remain unverified'
            profiles = json.loads(Path(td, 'model_profiles.json').read_text())
            assert profiles['custom']['verification_status'] == 'unverified'
            system_settings.save_model({'provider': 'kimi'})
            assert config.LLM_API_KEY == 'new-test-key'
            assert config.LLM_MODEL == draft['model']
            profile_text = Path(td, 'model_profiles.json').read_text()
            assert 'new-test-key' not in profile_text and 'old-test-key' not in profile_text
            assert not system_settings.test_model({**draft, 'base_url':'https://unrelated.test', 'api_key':''})['ok']
        with tempfile.TemporaryDirectory() as td, patch.object(config, 'DATA_DIR', td):
            legacy_profile = {key: value for key, value in system_settings._model_values({}).items() if key != 'api_key'}
            Path(td, 'model_profiles.json').write_text(json.dumps({'kimi': legacy_profile}), encoding='utf-8')
            assert system_settings._current_model_verified(), 'legacy saved profile should remain verified'
        sse = b'data: {"choices":[{"delta":{"reasoning_content":"hidden"}}]}\n\ndata: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n'
        with patch.object(client.urllib.request, 'urlopen', return_value=io.BytesIO(sse)) as http:
            assert ''.join(client.chat_completion_stream([{'role':'user','content':'hi'}])) == 'OK'
            body = json.loads(http.call_args.args[0].data)
            assert body['stream'] is True and 'temperature' not in body
        with patch.object(client.urllib.request, 'urlopen', side_effect=HTTPError('https://test', 401, 'secret', {}, io.BytesIO(b''))):
            result = system_settings.test_model(draft)
            assert not result['ok'] and '401' in result['message'] and 'secret' not in result['message']
        for malformed in ({}, {'choices': []}, {'choices': [{'message': {'content': ''}}]}):
            with patch.object(client, 'chat_completion', return_value=malformed):
                assert not system_settings.test_model(draft)['ok']
        with patch.object(client.urllib.request, 'urlopen', return_value=io.BytesIO(json.dumps(response).encode())) as http:
            client.chat_completion([{'role':'user','content':'hi'}], provider='deepseek', model='deepseek-v4-flash', extra_params={})
            assert json.loads(http.call_args.args[0].data)['thinking']['type'] == 'disabled'
        other = dict(provider='other', base_url='https://vendor.test/compatible-mode/v1',
                     model='vendor-model', api_key='vendor-test-key', extra_params={'temperature': None, 'enable_thinking': False})
        with patch.object(client.urllib.request, 'urlopen', return_value=io.BytesIO(json.dumps(response).encode())) as http:
            assert system_settings.test_model(other)['ok']
            req = http.call_args.args[0]
            body = json.loads(req.data)
            assert req.full_url == 'https://vendor.test/compatible-mode/v1/chat/completions'
            assert body['model'] == 'vendor-model' and 'temperature' not in body
            assert body['enable_thinking'] is False and 'thinking' not in body
        print('provider URL, key isolation, persistence, HTTP errors, JSON and SSE: PASS')
    finally:
        for key, value in old.items(): setattr(config, key, value)

if __name__ == '__main__': main()
