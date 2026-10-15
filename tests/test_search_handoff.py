"""Fast mail search is local; explicit AI search stays within its hard filters."""
import asyncio
import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app import db, mail_assistant, semantic, system_settings
from app.account_context import use
from app.web.routes import assistant, mail_read
from app.web.schemas import AssistantRequest


def main():
    with tempfile.TemporaryDirectory() as folder, use({'ACCOUNT_ID':'search','DB_PATH':str(Path(folder)/'mail.db'),'IMAP_USER':'me@example.test'}), patch.object(mail_assistant.client,'available',return_value=False):
        db.init_db()
        def mail(uid,name='方君',**fields):
            return db.upsert_email(dict(uid=uid,from_name=name,from_addr=f'{uid}@example.test',subject='合同交期确认',
                                        body_text='合同交付日期改为下周二，请确认。',date='2026-10-15T10:00:00',**fields))
        first=mail(1)
        other=mail(2,'其他人')
        removed=mail(3,status='trash')
        missing=mail(4)
        with db.conn() as c:
            c.execute('UPDATE emails SET remote_missing=1 WHERE id=?',(missing,))
        with patch.object(semantic,'enabled',side_effect=AssertionError('Fast search must not inspect AI settings')), \
             patch.object(semantic,'search',side_effect=AssertionError('Fast search must not run inference')), \
             patch.object(mail_assistant.client,'chat_completion',side_effect=AssertionError('Fast search must not call a model')):
            assert mail_read.api_search_emails(q='合同',status='inbox')
            assert mail_read.api_search_emails(q='这个合同到底哪天交付') == []
            with patch.object(system_settings,'_load_registry',return_value={'accounts':{'search':{'db_path':str(Path(folder)/'mail.db'),'user':'me@example.test'}}}):
                assert system_settings.list_unified_inbox(q='方君')

        # Structured searches must not add guessed keywords or require a model.
        with patch.object(mail_assistant,'_ai_search_plan',side_effect=AssertionError('A field-only search does not need planning')):
            for query in ['找到发件人是方君的邮件','方君发来的邮件','来自方君的邮件']:
                assert [r['id'] for r in mail_assistant._search_sources(query)] == [first],query

        # A short follow-up still needs its earlier conversational conditions.
        with patch.object(mail_assistant,'_ai_search_plan',return_value={'sender':'方君','has_attachment':True,'terms':[],'text':''}):
            followup=mail_assistant._search_result('有附件',history=[{'role':'user','content':'发件人是方君'}])
            assert followup['snapshot']['criteria']['sender']=='方君'
            assert followup['snapshot']['criteria']['has_attachment'] is True

        # Semantic additions must obey sender, subject, date and mailbox filters.
        with patch.object(semantic,'enabled',return_value=True),patch.object(semantic,'search',return_value=[first,other,removed,missing]):
            rows=mail_assistant._search_sources('发件人是方君 语意线索')
            assert [r['id'] for r in rows] == [first]
            assert mail_assistant._search_sources('发件人是方君 主题包含不存在 语意线索') == []
            assert mail_assistant._search_sources('发件人是方君 开始日期是2026-10-16 语意线索') == []
        with patch.object(semantic,'enabled',return_value=True),patch.object(semantic,'search',side_effect=RuntimeError('test model unavailable')),patch.object(mail_assistant.log,'exception') as logged:
            assert mail_assistant._search_sources('发件人是方君 合同')[0]['id'] == first
            logged.assert_called_once()

        # Searching is read-only even when the query sounds like a mail action.
        with patch.object(semantic,'enabled',return_value=False), \
             patch.object(mail_assistant.client,'available',return_value=False), \
             patch.object(mail_assistant.assistant_actions,'detect_proposal',side_effect=AssertionError('Search must not propose actions')), \
             patch.object(mail_assistant.assistant_actions,'requests_document_reply',side_effect=AssertionError('Search must not prepare a reply')), \
             patch.object(mail_assistant,'_todo_answer',side_effect=AssertionError('Search must not switch to tasks')):
            query='合同发我看看，帮我回复这封邮件'
            answer=mail_assistant.ask(query,email_ids=[other],search_mode=True)
            assert answer['sources'] and 'action' not in answer
            events=list(mail_assistant.ask_stream(query,email_ids=[other],search_mode=True))
            assert 'action' not in [kind for kind,_ in events]
            assert first in [r['id'] for kind,value in events if kind=='sources' for r in value]
            response=assistant.api_assistant_ask(AssistantRequest(question=query,search_mode=True,email_ids=[other]))
            assert response['sources'] and 'action' not in response
            stream=assistant.api_assistant_ask_stream(AssistantRequest(question=query,search_mode=True))
            async def collect():
                return [json.loads(chunk) async for chunk in stream.body_iterator]
            chunks=asyncio.run(collect())
            assert chunks[-1]['type']=='done' and not any(c['type']=='action' for c in chunks)
            assert any(c['type']=='sources' and c['sources'] for c in chunks)
        with patch.object(semantic,'enabled',return_value=False),patch.object(mail_assistant.client,'available',return_value=True), \
             patch.object(mail_assistant.client,'chat_completion',return_value={'choices':[{'message':{'content':f'找到合同。[email_id:{first}]'}}]}) as model:
            answer=mail_assistant.ask('发件人是方君',search_mode=True)
            assert answer['sources'][0]['id']==first
            assert mail_assistant.SEARCH_INSTRUCTION in model.call_args.args[0][0]['content']
            assert '发件人姓名:方君' in model.call_args.args[0][-1]['content']
        def model_plan(value):
            return {'choices':[{'message':{'content':json.dumps(value,ensure_ascii=False)}}]}
        with patch.object(mail_assistant.client,'available',return_value=True),patch.object(semantic,'enabled',return_value=False):
            with patch.object(mail_assistant.client,'chat_completion',return_value=model_plan({'sender':'方君','keywords':['合同','交期']})) as planner:
                assert mail_assistant._search_sources('上次方君说合同的交期变了，是哪封')[0]['id']==first
                assert planner.call_args.kwargs['timeout']<=12
                mail_assistant._ai_search_plan('只看有附件的',[{'role':'user','content':'方君的合同'}])
                assert json.loads(planner.call_args.args[0][-1]['content'])['recent_requests']==['方君的合同']
            # Explicit field restrictions win over an incorrect model guess.
            with patch.object(mail_assistant.client,'chat_completion',return_value=model_plan({'sender':'其他人','keywords':['合同']})):
                assert [r['id'] for r in mail_assistant._search_sources('发件人是方君 合同')] == [first]
            for bad in ({'sql':'DROP TABLE emails'},{'after':'tomorrow'},{'mailbox':'unknown'},{'unread':'yes'},{'keywords':['合同',12]}):
                with patch.object(mail_assistant.client,'chat_completion',return_value=model_plan(bad)):
                    assert mail_assistant._ai_search_plan('合同') is None,bad
            with patch.object(mail_assistant.client,'chat_completion',return_value=model_plan({'sender':"x' OR 1=1 --",'keywords':['合同']})):
                assert mail_assistant._search_sources('找一个人发的合同') == []
            assert db.get_email(first)['subject']=='合同交期确认'
    print('PASS local-only fast search, explicit AI recall, hard filters, account/deletion scope, read-only search, sync/stream handoff and source citations')


if __name__=='__main__':
    main()
