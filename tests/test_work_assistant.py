"""Work assistance: source bounds, concurrent saves, advisory review and outcomes."""
import json
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import db, config, work_assistant as work, companion_growth as growth, task_planner, mail_assistant, assistant_actions, sent_followups
from app.account_context import use
from app.llm import client
from app.web.routes.compose import _compose_assist_context
from app.web.schemas import ComposeAssistRequest


def main():
    with tempfile.TemporaryDirectory() as root:
        account = dict(ACCOUNT_ID='work', DB_PATH=str(Path(root)/'work.db'), IMAP_USER='me@example.test')
        with use(account):
            db.init_db()
            def mail(uid, mid, parent='', text='请提交排期。能否周五交付？'):
                return db.upsert_email(dict(uid=uid, message_id=mid, in_reply_to=parent,
                    thread_id=parent or mid, subject='相同主题', body_text=text,
                    from_addr='colleague@example.test', status='inbox', verdict='clean',
                    date=f'2026-11-05T10:{uid:02d}:00'))
            first = mail(1,'<first@example.test>')
            second = mail(2,'<second@example.test>','<first@example.test>', '已确认提交时间由周五调整到下周一。')
            other = mail(3,'<other@example.test>',text='不关联的合同报价。')
            discarded = mail(4,'<discarded@example.test>')
            work.save_context(discarded, note='随原邮件永久删除', revision=0)
            with db.conn() as c:
                c.execute('DELETE FROM emails WHERE id=?', (discarded,))
                assert c.execute('SELECT COUNT(*) FROM work_context WHERE email_id=?', (discarded,)).fetchone()[0] == 0
            before = db.mailbox_revision()
            with patch.object(client,'chat_completion',side_effect=AssertionError('Read triggered a model call')):
                result = work.overview(first)
                assert result['requests'] == ['请提交排期', '能否周五交付？']
                assert result['progress']['linked_count'] == 2
                assert result['progress']['changes']['items']
            assert db.mailbox_revision() == before and not db.list_todos(True)
            assert work.save_context(first, project='ERP 项目', role='协调人', note='等待名单', revision=0)['revision'] == 1
            assert '等待名单' in work.writing_context(second)
            assert '等待名单' not in work.writing_context(other)
            assert '等待名单' not in work.saved_context([other])
            try:
                work.save_context(first,note='过期页面覆盖',revision=0)
                raise AssertionError('Stale edit overwrote newer memory')
            except ValueError: pass
            # Two simultaneous writers can never silently overwrite each other.
            def save(note):
                with use(account):
                    try: return work.save_context(first,note=note,revision=1)['revision']
                    except ValueError: return 'conflict'
            with ThreadPoolExecutor(max_workers=2) as executor:
                assert sorted(executor.map(save, ['A','B']),key=str) == [2,'conflict']
            work.save_context(first,revision=2)
            assert not work.saved_context([first])
            try:
                work.save_context(first,note='复活旧记录',revision=0)
                raise AssertionError('Clear lost its revision')
            except ValueError: pass
            work.save_preferences('结论在前，简洁自然')
            version = work.preferences()['revision']
            try:
                work.save_context(first,note='不应部分保存',revision=3,style='过期偏好',style_revision=version-1)
                raise AssertionError('A stale preference write was accepted')
            except ValueError: pass
            assert not work.saved_context([first]), 'Context and preferences save atomically'
            assert work.preferences()['style'] == '结论在前，简洁自然'
            messages, basis, _ = _compose_assist_context(ComposeAssistRequest(operation='reply', source_email_id=first,
                use_work_preferences=True,user_instruction='同意延期'))
            prompt = json.dumps(messages,ensure_ascii=False)
            assert '关联往来与事项记录' in basis and '结论在前' in prompt and '下周一' in prompt
            assert '不关联的合同报价' not in prompt
            # Opting out does not carry any source or writing memory into the model.
            messages, basis, _ = _compose_assist_context(ComposeAssistRequest(operation='draft',user_instruction='安排会议'))
            assert '结论在前' not in json.dumps(messages,ensure_ascii=False)
            local = work.review(first,'详见附件。',[],semantic=False)
            assert local['items'][0]['kind'] == 'attachment'
            assert work.review(first,'正文'*7000,[],semantic=False)['limited']
            with patch.object(client,'available',return_value=False):
                assert work.review(first,'详见附件。',[],semantic=True)['model_used'] is False
            fake = {'choices':[{'message':{'content':json.dumps({'items':[
                {'question':'能否周五交付？','kind':'missing','note':'尚未回答交付时间'},
                {'question':'伪造的问题','kind':'missing','note':'不可显示'},
                {'question':'能否周五交付？','kind':'missing','note':'重复'},
                {'question':'请提交排期','kind':'done','note':'无效状态'}]})},'finish_reason':'stop'}]}
            with patch.object(client,'available',return_value=True), patch.object(client,'chat_completion',return_value=fake):
                review = work.review(first,'收到。',[],semantic=True)
            assert len(review['items']) == 1 and review['model_used']
            with patch.object(client,'available',return_value=True), patch.object(config,'LLM_PROVIDER','custom'), patch.object(config,'LLM_MODEL','Kimi-K2.5'), patch.object(client,'chat_completion',return_value=fake) as call:
                work.review(first,'收到。',[],semantic=True)
                assert call.call_args.kwargs['max_tokens'] == 4096, 'Reasoning gateways need the existing assistant output reserve'
            assert db.mailbox_revision() == before, 'All assistance reads must preserve mail state'
            # Successful task completion earns once, including reopen and parallel callers.
            task = task_planner.save(email_id=first,title='提交排期',stage='waiting')
            xp = growth.snapshot()['xp']
            # A pre-upgrade time goal remains earned, but cannot impersonate a
            # completed task under the new outcome goal.
            with growth.connection() as c:
                c.execute('INSERT OR REPLACE INTO companion_days VALUES(?,?,?,?,?)',
                          (growth._now().date().isoformat(),json.dumps({'active':600}),json.dumps(['focus']),0,0))
            assert not next(goal for goal in growth.snapshot()['quests'] if goal['id']=='finisher')['complete']
            db.set_todo_status(task['id'],'done')
            awarded = growth.snapshot()
            assert awarded['xp'] > xp and awarded['today']['counts']['task'] == 1
            db.set_todo_status(task['id'],'open')
            db.set_todos_status([task['id']],'done')
            assert growth.snapshot()['today']['counts']['task'] == 1
            assert growth.snapshot()['xp'] == awarded['xp']
            # Follow-up prepares a blank composer with thread headers and no send side effect.
            sent = db.create_sent_message(dict(to_addr='colleague@example.test',from_addr='me@example.test',
                subject='项目排期',body_html='<p>请反馈名单。</p>',mode='compose'))
            db.finish_sent_message(sent,ok=True,message_id='<sent@example.test>')
            seed = work.followup_seed(sent)
            assert seed['in_reply_to'] == '<sent@example.test>' and seed['message_html'] == ''
            assert seed['original_text'].strip() == '请反馈名单。'
            # Follow-up drafting never auto-sends; supports offline fallback + grounded AI draft + schedule/cancel.
            with patch.object(client, 'available', return_value=False):
                offline = work.followup_draft(sent, tone='polite')
                direct = work.followup_draft(sent, tone='direct', language='en')
            assert offline['model_used'] is False and offline['in_reply_to'] == '<sent@example.test>'
            assert '项目排期' in offline['draft_body'] and '<p>' in offline['message_html']
            assert '未连接' in offline['note']
            assert direct['model_used'] is False and 'Following up briefly' in direct['draft_body']
            fake_nudge = {'choices': [{'message': {'content': json.dumps({
                'subject': 'Re: 项目排期',
                'body': '您好：\n\n此前发出的「项目排期」邮件不知目前确认进展如何，方便时请反馈，感谢！',
                'signoff': '',
            })}, 'finish_reason': 'stop'}]}
            with patch.object(client, 'available', return_value=True), patch.object(client, 'chat_completion', return_value=fake_nudge):
                ai_draft = work.followup_draft(sent, tone='formal', use_work_preferences=True)
            assert ai_draft['model_used'] is True and '项目排期' in ai_draft['draft_body']
            with patch.object(client, 'available', return_value=True), patch.object(client, 'chat_completion', side_effect=RuntimeError('network down')):
                degraded = work.followup_draft(sent, tone='polite')
            assert degraded['model_used'] is False and '项目排期' in degraded['draft_body']
            scheduled = sent_followups.schedule(sent, days=3)
            assert scheduled['ok'] and scheduled['at']
            listed = sent_followups.items()
            assert listed[0]['sent_id'] == sent and listed[0]['snippet'] == '请反馈名单。' and listed[0]['state'] == 'scheduled'
            sent_followups.arrange(sent, cancel=True)
            assert sent_followups.items()[0]['state'] == 'canceled'
            sent_followups.schedule(sent, days=2)
            assert sent_followups.items()[0]['state'] == 'scheduled'
            assert len(db.list_sent_messages()) == 1
            # Explicit requests are sufficient to save; ordinary/temporary turns do not become personal memory.
            memory_before = db.mailbox_revision()
            old_style = work.preferences()
            assert work.memory_reply('我负责排期协调', [first]) is None
            assert work.memory_reply('这次回复请正式一点', [first]) is None
            assert work.memory_reply('以后回信需要写落款吗？', [first]) is None
            assert assistant_actions.detect_proposal('先聊聊怎么回复这封邮件', [first]) is None
            assert 'action' not in work.memory_reply('帮我记住')
            assert 'action' not in work.memory_reply('我负责排期协调，帮我记住')
            with patch.object(client,'chat_completion',side_effect=AssertionError('Saving a stated preference should not need a model')):
                saved = mail_assistant.ask('我负责排期协调，帮我记住', email_ids=[first])
                assert 'action' not in saved and '记下了' in saved['answer']
                events = list(mail_assistant.ask_stream('我负责排期协调，帮我记住', email_ids=[first]))
            assert 'action' not in dict(events)
            assert '我负责排期协调' in work.saved_context([first]) and work.preferences() == old_style
            saved=work.memory_reply('以后回信简短一点')
            assert 'action' not in saved and '记住了' in saved['answer']
            from app import work_memory
            assert '以后回信简短一点' in work_memory.writing_preferences()
            assert work.preferences()==old_style, 'Learned writing preferences remain separate from fixed requirements'
            assert '我负责排期协调' not in work_memory.writing_preferences()
            work.save_context(other, note='另一个事项保持原样', revision=0)
            cleared=work.memory_reply('清除这件事保存的事项背景', [first])
            assert 'action' not in cleared and '已清除' in cleared['answer']
            assert not work.saved_context([first]) and '另一个事项保持原样' in work.saved_context([other])
            assert '以后回信简短一点' in work_memory.writing_preferences()
            assert db.mailbox_revision() == memory_before and len(db.list_sent_messages()) == 1
            with db.conn() as c:
                c.execute('UPDATE emails SET remote_missing=1 WHERE id=?',(first,))
            for action in (lambda:work.overview(first), lambda:work.save_context(first,revision=3)):
                try: action(); raise AssertionError('Removed mail accepted')
                except ValueError: pass
        with use(dict(account, ACCOUNT_ID='other',DB_PATH=str(Path(root)/'other.db'))):
            db.init_db()
            assert work.preferences()['style'] == '' and work.saved_context([1]) == ''
            try: work.overview(first); raise AssertionError('Cross-account source accepted')
            except ValueError: pass
    print('PASS work context, source bounds, no-model reads, review citations, concurrent editing, outcome dedup and account isolation')


if __name__ == '__main__':
    main()
