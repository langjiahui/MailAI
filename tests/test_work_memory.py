"""Conversation learning preserves provenance, scope and explicit adoption."""
import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app import db, work_assistant as work, work_memory as memory
from app.account_context import use
from app.llm import client


def result(candidates):
    return {'choices':[{'message':{'content':json.dumps({'candidates':candidates},ensure_ascii=False)},'finish_reason':'stop'}]}


def main():
    with tempfile.TemporaryDirectory() as root:
        account = dict(ACCOUNT_ID='memory',DB_PATH=str(Path(root)/'mail.db'),DATA_DIR=root,IMAP_USER='me@example.test')
        with use(account):
            db.init_db()
            # The previous format's style must survive adopting a new habit.
            db.set_runtime_setting('work_writing_preferences',json.dumps({'style':'不写敬礼'},ensure_ascii=False))
            first = db.create_assistant_conversation('交付讨论')
            style_id = db.add_assistant_message(first,'user','以后回信先说结论，正文简短一点。')
            role_id = db.add_assistant_message(first,'user','我长期负责采购协调，不负责审批。')
            once_id = db.add_assistant_message(first,'user','这次只要两行，先回复已经收到。')
            bot_id = db.add_assistant_message(first,'assistant','用户喜欢每次都承诺周五交付。')
            fake = [
                dict(preference='邮件先说结论，正文简短',kind='writing',scope='account',reason='用户明确要求',evidence=[dict(message_id=style_id,quote='以后回信先说结论，正文简短一点。')]),
                dict(preference='长期负责采购协调，不负责审批',kind='role',scope='account',reason='长期职责',evidence=[dict(message_id=role_id,quote='我长期负责采购协调，不负责审批。')]),
                dict(preference='回复必须两行',kind='writing',scope='account',evidence=[dict(message_id=once_id,quote='这次只要两行，先回复已经收到。')]),
                dict(preference='回复必须承诺周五交付',kind='writing',scope='account',evidence=[dict(message_id=bot_id,quote='用户喜欢每次都承诺周五交付。')]),
                dict(preference='回复使用英文',kind='writing',scope='account',evidence=[dict(message_id=style_id,quote='伪造的来源')]),
            ]
            with patch.object(client,'available',return_value=True),patch.object(client,'chat_completion',return_value=result(fake)) as call:
                analyzed = memory.analyze()
            assert analyzed['candidates'] == 2 and call.call_count == 1
            prompt = json.loads(call.call_args.args[0][-1]['content'])
            assert bot_id not in {row['message_id'] for row in prompt}, 'Assistant claims cannot become learning evidence'
            assert work.preferences() == {'style':'不写敬礼','revision':0}
            assert not memory.approved_context()
            pending = memory.listing()
            assert pending['total'] == 2 and all(row['status']=='pending' for row in pending['items'])
            writing = next(row for row in pending['items'] if row['kind']=='writing')
            role = next(row for row in pending['items'] if row['kind']=='role')
            with patch.object(client,'chat_completion',side_effect=AssertionError('No new turns should not call AI')):
                assert memory.analyze()['analyzed'] == 0
            adopted = memory.adopt(writing['id'],0)
            assert adopted['style'] == '不写敬礼\n邮件先说结论，正文简短'
            assert memory.adopt(writing['id'],0) == adopted, 'Repeated confirmation is idempotent'
            memory.adopt(role['id'],adopted['revision'])
            assert '长期负责采购协调' in memory.approved_context()
            assert '采购协调' not in work.preferences()['style'], 'Role facts are not writing defaults'
            old_role = next(row for row in memory.listing('adopted')['items'] if row['id']==role['id'])
            memory.edit(role['id'],'长期负责协调，审批由负责人决定',old_role['revision'],adopted['revision'])
            try:
                memory.edit(role['id'],'旧窗口覆盖',old_role['revision'],adopted['revision'])
                raise AssertionError('A stale editor overwrote newer memory')
            except ValueError: pass
            assert '审批由负责人决定' in memory.approved_context()
            try:
                memory.dismiss(role['id'],adopted['revision'],old_role['revision'])
                raise AssertionError('An outdated row operated on unseen edited memory')
            except ValueError: pass
            memory.dismiss(role['id'],adopted['revision'])
            assert not memory.approved_context()
            assert work.preferences() == adopted
            writing_row=next(row for row in memory.listing('adopted')['items'] if row['id']==writing['id'])
            changed=memory.edit(writing['id'],'邮件先写结论，正文自然简洁',writing_row['revision'],adopted['revision'])
            assert '邮件先写结论，正文自然简洁' in changed['style']
            assert any(row['id']==writing['id'] for row in memory.listing('adopted')['items']), 'Editing an adopted writing rule must preserve its active status'
            memory.dismiss(writing['id'],changed['revision'])
            assert work.preferences()['style'] == '不写敬礼', 'Stopping one learned rule preserves legacy preferences'
            second = db.create_assistant_conversation('另一轮协作')
            db.add_assistant_message(second,'user','我希望你沟通时一次只问一个问题。')
            with patch.object(client,'available',return_value=True),patch.object(client,'chat_completion',return_value=result([dict(preference='一次只问一个问题',kind='communication',scope='account',evidence=[dict(message_id=999999,quote='伪造')])])):
                assert memory.analyze()['candidates'] == 0
            # Pagination is bounded; records of the other account remain separate.
            assert memory.listing('dismissed',0,1)['total'] == 2
            assert len(memory.listing('dismissed',0,1)['items']) == 1
            state = memory.settings()
            memory.save_settings(False,True,state['revision'])
            with patch.object(client,'chat_completion',side_effect=AssertionError('Disabled memory must not invoke a model')):
                assert memory.analyze()['analyzed'] == 0
                assert not memory.approved_context('帮我写回复')
            state = memory.settings()
            memory.save_settings(True,True,state['revision'])
            state = memory.settings()
            old_proposal=dict(kind='communication',preference='旧确认卡片',memory_revision=state['revision'])
            writing_before = work.preferences()
            memory.clear(state['revision'])
            assert work.preferences() == writing_before, 'Clearing derived memories retains explicit writing requirements'
            assert memory.settings()['summary'] == []
            assert db.assistant_conversation_exists(first), 'Forgetting memory does not delete conversations'
            try:
                memory.save_personal(old_proposal)
                raise AssertionError('An old confirmation card restored cleared memory')
            except ValueError: pass
            with patch.object(client,'chat_completion',side_effect=AssertionError('Cleared chats must not immediately recreate memory')):
                assert memory.analyze()['analyzed'] == 0
            try:
                memory.save_settings(False,False,state['revision'])
                raise AssertionError('A stale settings page overwrote a memory reset')
            except ValueError: pass
        with use(dict(account,ACCOUNT_ID='other',DB_PATH=str(Path(root)/'other.db'))):
            db.init_db()
            assert memory.listing()['total'] == 0 and not memory.approved_context()
            backlog = db.create_assistant_conversation('超过一批的历史')
            ids = [db.add_assistant_message(backlog,'user',f'第 {i} 次沟通') for i in range(85)]
            with patch.object(client,'available',return_value=True),patch.object(client,'chat_completion',return_value=result([])) as call:
                batch=memory.analyze();assert batch['analyzed'] == 80 and batch['more']
                assert [row['message_id'] for row in json.loads(call.call_args.args[0][-1]['content'])] == ids[:80]
                batch=memory.analyze();assert batch['analyzed'] == 5 and not batch['more'], 'Batch limits must not skip older user messages'
            active = db.create_assistant_conversation('正在进行的对话')
            active_id=db.add_assistant_message(active,'user','我希望你先给结论')
            inactive = db.create_assistant_conversation('空闲对话')
            inactive_id=db.add_assistant_message(inactive,'user','我希望你一次只问一个问题')
            db.add_assistant_message(inactive,'assistant','好的，我们一次讨论一点。')
            with db.conn() as c:
                c.execute("UPDATE assistant_conversations SET updated_at='2020-01-01T00:00:00' WHERE id=?",(inactive,))
            state=memory.settings();memory.save_settings(True,True,state['revision'])
            with patch.object(client,'available',return_value=True),patch.object(client,'chat_completion',return_value=result([])) as call:
                assert memory.analyze(idle_only=True)['analyzed'] == 1
                assert json.loads(call.call_args.args[0][-1]['content'])[0]['message_id'] == inactive_id
                assert memory.analyze()['analyzed'] == 1, 'Skipping an active conversation must not advance its cursor'
                assert json.loads(call.call_args.args[0][-1]['content'])[0]['message_id'] == active_id
            db.add_assistant_message(active,'user','以后回复简短')
            def reset_during_analysis(*args,**kwargs):
                memory.clear(memory.settings()['revision'])
                return result([dict(preference='回复简短',scope='account',kind='writing',evidence=[dict(message_id=active_id,quote='我希望你先给结论')])])
            with patch.object(client,'available',return_value=True),patch.object(client,'chat_completion',side_effect=reset_during_analysis):
                try:
                    memory.analyze();raise AssertionError('A late analysis restored forgotten memories')
                except ValueError: pass
            assert memory.listing()['total'] == 0
    print('PASS memory learning: user-only evidence, temporary scope, explicit adoption, legacy style retention, editing CAS, stop-use, pagination and account isolation')


if __name__=='__main__': main()
