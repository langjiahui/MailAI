"""Gateway reasoning must not reach previews, JSON parsers or final mail."""
import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import config
from app.llm import client
from app.llm.output import content_text, visible_text, VisibleTextStream
from app.llm.providers import adapt_body


class VisibleOutputTests(unittest.TestCase):
    def test_corporate_kimi_has_room_for_reasoning_without_changing_model_id(self):
        from app.mail_assistant import _assistant_request_limits
        for provider in ('custom', 'other'):
            with patch.object(config, 'LLM_PROVIDER', provider), patch.object(config, 'LLM_MODEL', 'Kimi-K2.6'):
                self.assertEqual(_assistant_request_limits(), (4096, 90))
                self.assertEqual(adapt_body({'model': config.LLM_MODEL, 'max_tokens': 4096}, provider, {}),
                                 {'model': 'Kimi-K2.6', 'max_tokens': 4096})
        with patch.object(config, 'LLM_PROVIDER', 'custom'), patch.object(config, 'LLM_MODEL', 'Qwen2.5-72B'):
            self.assertEqual(_assistant_request_limits(), (1600, 60))

    def test_qwen_request_default_and_explicit_override(self):
        body = {'model': 'Qwen3.6-35B', 'messages': [], 'stream': True}
        self.assertEqual(adapt_body(dict(body), 'custom', {})['chat_template_kwargs'], {'enable_thinking': False})
        self.assertEqual(adapt_body(dict(body), 'other', {'chat_template_kwargs': {'enable_thinking': True}})
                         ['chat_template_kwargs'], {'enable_thinking': True})
        self.assertNotIn('chat_template_kwargs', adapt_body({'model': 'unrelated-model'}, 'custom', {}))

    def test_tag_and_unicode_boundaries(self):
        for text in ['<think>internal notes</think>主题：会议通知\n\n周五一点，802会议室。',
                     "Here's a thinking process:\ninternal notes</think>主题：会议通知\n\n周五一点，802会议室。"]:
            expected = '主题：会议通知\n\n周五一点，802会议室。'
            self.assertEqual(visible_text(text), expected)
            for width in (1, 2, 5, 31, 1000):
                stream = VisibleTextStream()
                chunks = [stream.feed(text[i:i + width]) for i in range(0, len(text), width)]
                chunks.append(stream.finish())
                self.assertEqual(''.join(chunks), expected)
                self.assertTrue(all('internal' not in item and '<think' not in item for item in chunks))

    def test_unfinished_reasoning_never_becomes_mail(self):
        self.assertEqual(visible_text('<think>unfinished notes'), '')
        self.assertEqual(visible_text('<think>outer<think>inner</think>still internal</think>final'), 'final')
        self.assertEqual(visible_text("Here's a thinking process:\nunfinished notes"), '')
        self.assertEqual(visible_text('unmarked internal notes</think>final answer'), 'final answer')
        self.assertEqual(visible_text('Hello team,\nPlease attend.'), 'Hello team,\nPlease attend.')
        self.assertEqual(visible_text('Use <b>bold</b> text.'), 'Use <b>bold</b> text.')

    def test_multipart_reasoning_is_not_visible_text(self):
        self.assertEqual(content_text([{'type':'reasoning', 'text':'internal notes'},
                                       {'type':'text', 'text':'正文'}]), '正文')

    def test_json_and_sse_clients_expose_only_final_content(self):
        reply = {'choices': [{'message': {'content': '<think>internal notes</think>正文'}}]}
        sse = ''.join('data: ' + json.dumps({'choices':[{'delta':{'content':part}}]}) + '\n\n'
                      for part in ('<thi', 'nk>internal notes</th', 'ink>正', '文'))
        sse += 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n'
        with patch.object(config, 'LLM_API_KEY', 'fixture-only'), patch.object(client.usage, 'record'), \
                patch.object(client.urllib.request, 'urlopen', return_value=io.BytesIO(json.dumps(reply).encode())):
            self.assertEqual(client.chat_completion([])['choices'][0]['message']['content'], '正文')
        with patch.object(config, 'LLM_API_KEY', 'fixture-only'), patch.object(client.usage, 'record'), \
                patch.object(client.urllib.request, 'urlopen', return_value=io.BytesIO(sse.encode())):
            self.assertEqual(''.join(client.chat_completion_stream([], require_completion=True)), '正文')


if __name__ == '__main__':
    unittest.main()
