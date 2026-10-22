"""Opt-in live-model audit. Uses only synthetic mail in a temporary account.

Run with --live; --system-trust uses the OS trust store without disabling TLS.
The JSON report contains synthetic prompts/answers, never model credentials.
"""
import argparse
import asyncio
import json
import sys
import tempfile
import time
from datetime import date
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true', required=True)
    parser.add_argument('--system-trust', action='store_true')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--only', default='', help='Comma-separated scenario names for a focused rerun')
    args = parser.parse_args()
    if args.system_trust:
        import truststore
        truststore.inject_into_ssl()
    from app import config, db, mail_assistant, companion_growth
    from app.account_context import use
    from app.web.routes import assistant
    from app.web.schemas import AssistantRequest
    from app.llm import client

    if not client.available():
        raise SystemExit('No real model configured')
    report = {'model': config.LLM_MODEL, 'provider': config.LLM_PROVIDER,
              'tls_verified': config.LLM_VERIFY_SSL, 'turns': []}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    calls = []
    completion, streaming = client.chat_completion, client.chat_completion_stream

    def complete(messages, **kwargs):
        result = completion(messages, **kwargs)
        calls.append({'kind': 'completion', 'messages': messages, 'success': bool(result)})
        return result

    def stream(messages, **kwargs):
        chunks = []
        try:
            for chunk in streaming(messages, **kwargs):
                chunks.append(chunk)
                yield chunk
        finally:
            calls.append({'kind': 'stream', 'messages': messages, 'success': bool(chunks)})

    with tempfile.TemporaryDirectory(prefix='mailai-real-audit-') as folder, use({
        'ACCOUNT_ID': 'synthetic-real-audit', 'DB_PATH': str(Path(folder)/'mail.db'),
        'DATA_DIR': folder, 'USER_DATA_DIR': folder, 'IMAP_USER': 'audit@example.test',
        'RAW_DIR': str(Path(folder)/'raw'), 'SEMANTIC_ENABLED': False,
    }), patch.object(companion_growth, 'safe_record'), patch.object(client, 'chat_completion', complete), patch.object(client, 'chat_completion_stream', stream):
        db.init_db()
        facts = [
            ('赤松合同', '苏禾', '请林舟负责赤松合同盖章，截止2026年11月6日17:00。预算7319元，核对码PINE7319。用户只需核对盖章页。'),
            ('海盐培训', '陈露', '海盐培训定在2026年12月9日09:30，地点海棠厅。讲师孟青。只供知悉，未安排用户任务，未明确负责人和处理截止时间。核对码SALT4826。'),
            ('青岚验收', '顾宁', '青岚验收由许澄负责，截止2026年11月18日15:00。请用户核对验收单。预算2641元，核对码MIST2641。'),
        ]
        ids = []
        for n, (subject, sender, body) in enumerate(facts, 1):
            ids.append(db.upsert_email({'uid': n, 'subject': subject, 'from_name': sender,
                       'from_addr': f'sender{n}@example.test', 'body_text': body, 'summary': body,
                       'date': date.today().isoformat()+'T09:00:00', 'status': 'inbox'}))
        a, b, c = ids
        conv = db.create_assistant_conversation('真实模型隔离测试')

        def turn(name, question, expected, *, selected=None, opened=None, search=False, forbidden=(), required=(), live=True, stream_mode=True):
            if args.only and name not in args.only.split(','):
                return
            history = [{'role': row['role'], 'content': row['content']} for row in db.get_assistant_messages(conv)]
            start, call_start = time.monotonic(), len(calls)
            payload = AssistantRequest(question=question, conversation_id=conv, history=history,
                                       email_ids=selected, open_email_id=opened, search_mode=search)
            if stream_mode:
                response = assistant.api_assistant_ask_stream(payload)
                async def collect():
                    return [json.loads(chunk) async for chunk in response.body_iterator]
                events = asyncio.run(collect())
                answer = ''.join(e['content'] for e in events if e['type']=='delta')
                sources = next((e['sources'] for e in events if e['type']=='sources'), [])
                search_meta = [e['search'] for e in events if e['type']=='search']
                actions = [e for e in events if e['type']=='action']
                fallback = any(e.get('state')=='fallback' or e['type']=='error' for e in events)
            else:
                result = assistant.api_assistant_ask(payload)
                answer, sources = result['answer'], result['sources']
                search_meta, actions, fallback = [result['search']] if result.get('search') else [], [result['action']] if result.get('action') else [], False
            actual = [s['id'] for s in sources]
            real_calls = calls[call_start:]
            problems = []
            if set(actual) != set(expected): problems.append(f'sources {actual} != {expected}')
            if any(word in answer for word in forbidden): problems.append('old facts in answer')
            history_text = str([call['messages'][1:-1] for call in real_calls])
            if any(word in history_text for word in forbidden): problems.append('old facts in model history')
            if any(not any(word in answer for word in (fact if isinstance(fact, tuple) else (fact,))) for fact in required):
                problems.append('required facts absent')
            if live and (not any(call['success'] for call in real_calls) or fallback): problems.append('no completed live answer')
            if actions: problems.append('unexpected action proposal')
            item = {'name': name, 'question': question, 'expected_ids': expected, 'source_ids': actual,
                    'answer': answer, 'seconds': round(time.monotonic()-start, 2), 'problems': problems,
                    'calls': real_calls, 'search': search_meta}
            report['turns'].append(item)
            args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2))
            print(json.dumps({key:item[key] for key in ('name','source_ids','seconds','problems','answer')}, ensure_ascii=False), flush=True)

        turn('open_a', '总结这封邮件', [a], selected=[a], opened=a, required=('林舟','7319'))
        turn('followup_owner_deadline', '谁负责、什么时候截止？', [a], selected=[a], opened=a, required=('林舟',('11月6日','11-06')))
        turn('followup_tasks', '那我需要做什么？', [a], selected=[a], opened=a, required=('盖章',))
        turn('followup_short', '再说简单点', [a], selected=[a], opened=a)
        turn('followup_pronoun', '那它的截止时间呢？', [a], selected=[a], opened=a, required=(('11月6日','11-06'),))
        turn('switch_b_explicit', '总结这封邮件', [b], selected=[a], opened=b, forbidden=('林舟','7319','11月6日','赤松'))
        turn('missing_owner_deadline', '谁负责、什么时候截止？', [b], selected=[b], opened=b, forbidden=('林舟','7319','11月6日','许澄'))
        turn('training_not_task', '列个清单吧', [b], selected=[b], opened=b,
             forbidden=('林舟','7319','赤松','许澄','待办：仅需','预留时间参加','加入你的日程','加入日历','设置提醒'), required=('海盐',))
        turn('switch_a_bare', '谁负责、什么时候截止？', [a], selected=[b], opened=a, forbidden=('孟青','12月9日','海棠厅'), required=('林舟',))
        turn('switch_c_bare', '那我需要做什么？', [c], selected=[a], opened=c, forbidden=('林舟','7319','赤松'), required=('验收',))
        turn('new_search_b', '换个话题，找一下陈露发来的海盐培训邮件', [b], selected=[c], opened=c, search=False, forbidden=('许澄','2641','青岚'), required=('海盐',))
        turn('search_followup', '把这些邮件列成待办', [b], selected=[b], opened=c, forbidden=('许澄','2641','林舟','7319'))
        turn('new_search_a', '另外找一下苏禾发来的赤松合同', [a], selected=[b], opened=b, search=True, forbidden=('陈露','海盐','12月9日'), required=('赤松',))
        turn('new_topic_c', '总结青岚验收邮件', [c], selected=[a], opened=a, forbidden=('林舟','7319','赤松'), required=('许澄',), stream_mode=False)
        turn('new_topic_followup', '用三句话总结', [c], selected=[c], opened=a, forbidden=('林舟','7319','赤松'), required=('验收',))
        turn('group_summary', '总结这些邮件', [a,c], selected=[a,c], opened=a, forbidden=('海盐','孟青'), required=('赤松','青岚'))
        turn('ordinal_group', '总结第二封', [c], selected=[a,c], opened=a, forbidden=('林舟','7319','赤松'), required=('验收',))
        turn('ordinal_followup', '那我需要做什么？', [c], selected=[c], opened=a, forbidden=('林舟','7319','赤松'), required=('验收',))
        turn('help_boundary', '你能做什么？', [], selected=[c], opened=None, live=False)
        turn('orphan_followup', '列成待办', [], selected=None, opened=None, live=False, forbidden=('许澄','2641','林舟','7319'))
        assert db.list_todos() == [], 'Audit unexpectedly wrote tasks'
        assert not any(db.get_email(i)['is_read'] for i in ids), 'Audit unexpectedly marked mail read'
    failures = [t['name'] for t in report['turns'] if t['problems']]
    print(json.dumps({'model':report['model'], 'turns':len(report['turns']), 'failed':failures, 'report':str(args.output)}, ensure_ascii=False))
    raise SystemExit(bool(failures))


if __name__ == '__main__':
    main()
