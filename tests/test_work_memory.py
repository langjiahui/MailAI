"""Automatic memory preserves temporary scope, user edits, deletion and old data."""
import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app import db,work_assistant as work,work_memory as memory
from app.account_context import use
from app.llm import client


def response(items):
    return {'choices':[{'message':{'content':json.dumps({'candidates':items},ensure_ascii=False)},'finish_reason':'stop'}]}


def candidate(message_id,quote,preference,kind='writing',**extra):
    return dict(preference=preference,kind=kind,scope='account',evidence=[dict(message_id=message_id,quote=quote)],**extra)


def analyze(items,**kwargs):
    with patch.object(client,'available',return_value=True),patch.object(client,'chat_completion',return_value=response(items)) as call:
        result=memory.analyze(**kwargs)
    return result,call


def main():
    with tempfile.TemporaryDirectory() as root:
        account=dict(ACCOUNT_ID='memory',DB_PATH=str(Path(root)/'memory.db'),DATA_DIR=root,IMAP_USER='me@example.test')
        with use(account):
            db.init_db();assert memory.settings()['auto_analyze'], 'New profiles automatically organize memory'
            db.set_runtime_setting('work_writing_preferences',json.dumps({'style':'不写敬礼'},ensure_ascii=False))
            fixed=work.preferences()
            first=db.create_assistant_conversation('交付讨论')
            writing='以后回信先说结论，正文简短一点。';wid=db.add_assistant_message(first,'user',writing)
            role='我长期负责采购协调，不负责审批。';rid=db.add_assistant_message(first,'user',role)
            once='这次只要两行，先回复已经收到。';oid=db.add_assistant_message(first,'user',once)
            next_once='下次给供应商的回复使用英文。';nid=db.add_assistant_message(first,'user',next_once)
            bid=db.add_assistant_message(first,'assistant','用户喜欢每次都承诺周五交付。')
            question='以后回信需要写落款吗？';qid=db.add_assistant_message(first,'user',question)
            result,call=analyze([
                candidate(wid,writing,'回信先说结论，正文简短',topic='writing.length'),
                candidate(rid,role,'长期负责采购协调，不负责审批','role',topic='role.authority'),
                candidate(oid,'只要两行','回信只要两行',topic='writing.length'),
                candidate(nid,'使用英文','回信使用英文'),
                candidate(bid,'用户喜欢每次都承诺周五交付。','回复必须承诺周五交付'),
                candidate(wid,'伪造原话','回信必须使用英文'),
                candidate(qid,'以后回信需要写落款','回信写落款')])
            assert result['candidates']==2
            prompt=json.loads(call.call_args.args[0][-1]['content'])
            assert bid not in {row['message_id'] for row in prompt['turns']}
            assert work.preferences()==fixed, 'Automatic writing memory must not rewrite explicit requirements'
            assert '正文简短' in memory.writing_preferences() and '长期负责采购协调' in memory.approved_context()
            assert '采购协调' not in memory.writing_preferences(), 'Role facts are not outgoing writing instructions'
            saved=memory.listing();assert saved['total']==2 and all(row['status']=='adopted' for row in saved['items'])
            with patch.object(client,'chat_completion',side_effect=AssertionError('No new turns should not call a model')):
                assert memory.analyze()['analyzed']==0
            # The same habit is revised in place, rather than endlessly appended.
            writing_row=next(row for row in saved['items'] if row['kind']=='writing')
            change='以后回信改为详细说明依据和步骤。';cid=db.add_assistant_message(first,'user',change)
            result,_=analyze([candidate(cid,change,'回信详细说明依据和步骤',topic='writing.length',target_id=writing_row['id'])])
            assert result['candidates']==1 and memory.listing()['total']==2
            changed=next(row for row in memory.listing()['items'] if row['id']==writing_row['id'])
            assert '详细' in changed['preference'] and '正文简短' not in memory.writing_preferences()
            assert len(changed['evidence'])==2
            memory.edit(changed['id'],'邮件先写结论，再解释关键依据',changed['revision'],fixed['revision'])
            edited=next(row for row in memory.listing()['items'] if row['id']==changed['id'])
            assert edited['user_edited'] and work.preferences()==fixed
            change='以后回信只要一行。';cid=db.add_assistant_message(first,'user',change)
            result,_=analyze([candidate(cid,change,'回信只要一行',topic='writing.length',target_id=edited['id'])])
            assert result['candidates']==0 and '解释关键依据' in memory.writing_preferences(), 'Background learning must preserve manual edits'
            try:
                memory.edit(edited['id'],'旧窗口覆盖',changed['revision'],fixed['revision']);raise AssertionError('Stale edits were accepted')
            except ValueError:pass
            # Delete the actual record, retain a small cutoff marker, never old text.
            memory.remove(edited['id'],edited['revision'],fixed['revision'])
            assert not any(row['id']==edited['id'] for row in memory.listing()['items'])
            assert work.preferences()==fixed and '解释关键依据' not in memory.writing_preferences()
            with db.conn() as c:
                assert not c.execute('SELECT 1 FROM work_preference_candidates WHERE id=?',(edited['id'],)).fetchone()
                assert c.execute('SELECT COUNT(*) FROM work_memory_forget').fetchone()[0]==2
                assert not memory._store_automatic(c,'换个说法重新出现',changed['evidence'],'旧分析','writing','writing.length')
            # Repeated observations across separate analysis batches mature automatically.
            a=db.create_assistant_conversation('第一次协作')
            text='把事情拆成小任务再推进。';aid=db.add_assistant_message(a,'user',text)
            result,_=analyze([candidate(aid,text,'把事情拆成小任务再推进','work_habit',topic='work_habit.planning')])
            assert result['candidates']==0
            observation=memory.listing('pending')['items'][0]
            b=db.create_assistant_conversation('另一次协作');bid=db.add_assistant_message(b,'user',text)
            result,_=analyze([candidate(bid,text,'按小任务推进工作','work_habit',topic='work_habit.planning',target_id=observation['id'])])
            assert result['candidates']==1 and '按小任务推进工作' in memory.approved_context()
            # Temporary instructions stay temporary even across conversations.
            for name in ('一次临时要求','又一次临时要求'):
                conv=db.create_assistant_conversation(name)
                temp='这封邮件回复正式一点。';tid=db.add_assistant_message(conv,'user',temp)
                result,_=analyze([candidate(tid,'回复正式一点','回信使用正式语气',topic='writing.tone')])
                assert result['candidates']==0
            assert not memory.listing('pending')['items']
            # Disabled memory neither recalls nor analyzes; switches survive initialization.
            state=memory.settings();memory.save_settings(False,False,state['revision']);db.init_db()
            assert not memory.settings()['auto_analyze']
            with patch.object(client,'chat_completion',side_effect=AssertionError('Disabled memory invoked AI')):
                assert memory.analyze()['analyzed']==0 and not memory.approved_context('帮我写回复') and not memory.writing_preferences()
            state=memory.settings();memory.save_settings(True,True,state['revision'])
            state=memory.settings();memory.clear(state['revision'])
            assert not memory.settings()['summary'] and work.preferences()==fixed
            assert db.assistant_conversation_exists(first)
            with patch.object(client,'chat_completion',side_effect=AssertionError('Forgotten chats were replayed')):
                assert memory.analyze()['analyzed']==0
            try:
                memory.save_settings(False,False,state['revision']);raise AssertionError('Stale settings overwrote clear')
            except ValueError:pass
            # Legacy confirmed rules and provenance remain manageable.
            with db.conn() as c:
                memory._remember(c,'回信自然简短',[],'旧版记录',status='adopted')
            legacy=memory.listing()['items'][0]
            work.save_preferences('不写敬礼\n回信自然简短',fixed['revision'])
            memory.remove(legacy['id'],legacy['revision'],work.preferences()['revision'])
            assert work.preferences()['style']=='不写敬礼'
        with use(dict(account,ACCOUNT_ID='other',DB_PATH=str(Path(root)/'other.db'))):
            db.init_db();assert memory.listing()['total']==0 and not memory.approved_context()
            conv=db.create_assistant_conversation('长历史')
            ids=[db.add_assistant_message(conv,'user',f'第 {i} 次沟通') for i in range(85)]
            batch,call=analyze([]);assert batch['analyzed']==80 and batch['more']
            assert [row['message_id'] for row in json.loads(call.call_args.args[0][-1]['content'])['turns']]==ids[:80]
            batch,_=analyze([]);assert batch['analyzed']==5 and not batch['more']
            active=db.create_assistant_conversation('活动中');active_id=db.add_assistant_message(active,'user','我希望先给结论')
            inactive=db.create_assistant_conversation('空闲对话');idle_id=db.add_assistant_message(inactive,'user','我希望一次只问一点')
            db.add_assistant_message(inactive,'assistant','好的')
            with db.conn() as c:c.execute("UPDATE assistant_conversations SET updated_at='2020-01-01T00:00:00' WHERE id=?",(inactive,))
            batch,call=analyze([],idle_only=True);assert batch['analyzed']==1
            assert json.loads(call.call_args.args[0][-1]['content'])['turns'][0]['message_id']==idle_id
            batch,call=analyze([]);assert batch['analyzed']==1
            assert json.loads(call.call_args.args[0][-1]['content'])['turns'][0]['message_id']==active_id
            new=db.add_assistant_message(active,'user','以后回信简短')
            def clear_in_flight(*args,**kwargs):
                memory.clear(memory.settings()['revision'])
                return response([candidate(new,'以后回信简短','回信简短')])
            with patch.object(client,'available',return_value=True),patch.object(client,'chat_completion',side_effect=clear_in_flight):
                try:memory.analyze();raise AssertionError('A late result restored cleared memory')
                except ValueError:pass
            assert memory.listing()['total']==0
            text='以后沟通先说结论';db.add_assistant_message(active,'user',text)
            memory.remember_explicit(text,'communication',text,'communication.order')
            row=memory.listing()['items'][0]
            text='以后沟通改为先解释原因';new_id=db.add_assistant_message(active,'user',text)
            def delete_in_flight(*args,**kwargs):
                memory.remove(row['id'],row['revision'],work.preferences()['revision'])
                return response([candidate(new_id,text,'先解释原因','communication',topic='communication.order',target_id=row['id'])])
            with patch.object(client,'available',return_value=True),patch.object(client,'chat_completion',side_effect=delete_in_flight):
                try:memory.analyze();raise AssertionError('A late model response restored a deleted item')
                except ValueError:pass
            assert memory.listing()['total']==0
            new_text='以后回信详细说明原因';mid=db.add_assistant_message(active,'user',new_text)
            def change_fixed_in_flight(*args,**kwargs):
                work.save_preferences('回信优先遵循本次明确要求',work.preferences()['revision'])
                return response([candidate(mid,new_text,'回信详细说明原因')])
            with patch.object(client,'available',return_value=True),patch.object(client,'chat_completion',side_effect=change_fixed_in_flight):
                try:memory.analyze();raise AssertionError('Old analysis ignored newly edited fixed requirements')
                except ValueError:pass
            assert memory.listing()['total']==0 and work.preferences()['style']=='回信优先遵循本次明确要求'
    print('PASS automatic memory: lasting/temporary scope, gradual observations, in-place updates, manual priority, deletion cutoff, disabled state, legacy rules, bounded batches, idle work, concurrency and account isolation')

if __name__=='__main__':main()
