"""Search refinements use server snapshots, preserve constraints and survive history."""
import asyncio
import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app import db,assistant_search,mail_assistant,productivity
from app.account_context import use
from app.web.routes import assistant
from app.web.schemas import AssistantRequest


def main():
    with tempfile.TemporaryDirectory() as folder,use({'ACCOUNT_ID':'loop','DB_PATH':str(Path(folder)/'mail.db'),'IMAP_USER':'loop@example.test'}),patch.object(mail_assistant.client,'available',return_value=False):
        db.init_db()
        for n in range(45):
            db.upsert_email({'uid':n+1,'from_name':'方君','from_addr':'fang@example.test','subject':'采购合同','body_text':'合同交付安排',
                            'date':'2026-10-15T10:00:00' if n<25 else '2026-08-10T10:00:00','status':'inbox'})
        other=db.upsert_email({'uid':100,'from_name':'李明','from_addr':'li@example.test','subject':'采购合同','date':'2026-10-15'})
        conv=db.create_assistant_conversation('检索闭环')
        criteria=productivity.normalize_search_criteria({'sender':'方君','after':'2026-10-01','before':'2026-10-15','query':'采购 合同'})
        initial=mail_assistant._search_result('查合同',search_context={'criteria':criteria,'action':'retry'})
        run=assistant_search.create(conv,initial['snapshot']);assistant_search.finish(run['id'],db.add_assistant_message(conv,'assistant','候选邮件',[]))
        wrong=assistant_search.prepare(run['id'],conv,'exclude_results')
        with patch.object(mail_assistant,'_ai_search_plan',side_effect=AssertionError('Shortcuts must not ask a model to reinterpret filters')):
            changed=mail_assistant._search_result('结果不对',search_context=wrong)
            assert len(changed['sources'])==5
            assert not set(run['source_ids'])&{r['id'] for r in changed['sources']}
            assert other not in [r['id'] for r in changed['sources']]
            assert changed['snapshot']['criteria']['after']=='2026-10-01'
            wrong_run=assistant_search.create(conv,changed['snapshot']);assistant_search.finish(wrong_run['id'],db.add_assistant_message(conv,'assistant','换一批',[]))
            relaxed=assistant_search.prepare(wrong_run['id'],conv,'relax_dates')
            result=mail_assistant._search_result('放宽时间',search_context=relaxed)
            assert len(result['sources'])==20 and any(r['date'].startswith('2026-08') for r in result['sources'])
            assert 'after' not in result['snapshot']['criteria'] and result['snapshot']['criteria']['sender']=='方君'
            relaxed_run=assistant_search.create(conv,result['snapshot']);assistant_search.finish(relaxed_run['id'],db.add_assistant_message(conv,'assistant','放宽后',[]))
            undone=assistant_search.prepare(relaxed_run['id'],conv,'undo')
            assert undone['criteria']==assistant_search.get(wrong_run['id'])['criteria']
            assert undone['exclude_ids']==wrong['exclude_ids']
            assert len(mail_assistant._search_result('撤销',search_context=undone)['sources'])==5
            clue=assistant_search.prepare(run['id'],conv,'set_sender','李明')
            assert [r['id'] for r in mail_assistant._search_result('改发件人',search_context=clue)['sources']]==[other]
        selected=run['source_ids'][0]
        before=db.get_email(selected)['is_read']
        assert assistant_search.confirm(run['id'],selected)['found_id']==selected
        assert db.get_email(selected)['is_read']==before
        assert assistant_search.confirm(run['id'],None)['found_id'] is None
        for call in (lambda:assistant_search.get(run['id'],conv+100),lambda:assistant_search.get('missing'),
                     lambda:assistant_search.confirm(run['id'],other),lambda:assistant_search.prepare(run['id'],conv,'bad'),
                     lambda:assistant_search.prepare(run['id'],conv,'set_sender',' ')):
            try:call()
            except ValueError:pass
            else:raise AssertionError('Invalid run/action should fail')
        # API carries search snapshots through both NDJSON and saved history.
        request=AssistantRequest(question='放宽时间',conversation_id=conv,search_mode=True,search_run_id=wrong_run['id'],search_action='relax_dates')
        stream=assistant.api_assistant_ask_stream(request)
        async def collect():return [json.loads(chunk) async for chunk in stream.body_iterator]
        events=asyncio.run(collect());meta=[event['search'] for event in events if event['type']=='search'][-1]
        assert meta['status']=='complete' and 'relax_dates' not in meta['actions'] and 'undo' in meta['actions']
        history=assistant.api_assistant_conversation(conv)
        assert history['messages'][-1]['search']['id']==meta['id']
        assert not any(event['type']=='action' for event in events)
        # Failed runs keep their exact filters for a deterministic retry.
        failed=assistant_search.create(conv,result['snapshot']);assistant_search.finish(failed['id'],db.add_assistant_message(conv,'assistant','失败',[]),'error')
        retry=assistant_search.prepare(failed['id'],conv,'retry')
        assert retry['criteria']==assistant_search.get(failed['id'])['criteria']
        with use({'ACCOUNT_ID':'another','DB_PATH':str(Path(folder)/'other.db')}):
            db.init_db()
            try:assistant_search.get(run['id'])
            except ValueError:pass
            else:raise AssertionError('Search state crossed accounts')
    print('PASS deterministic result rejection, date/keyword/sender changes, undo, safe confirmation, history/stream state, exact retry and account isolation')


if __name__=='__main__':main()
