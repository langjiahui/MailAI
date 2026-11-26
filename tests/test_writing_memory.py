"""Sent mail memory uses confirmed, bounded evidence and never invokes a model."""

from datetime import datetime
import json
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import db, work_memory, writing_memory as memory, writing_style as style
from app.account_context import use
from app.llm import client
from app.web.routes.compose import _compose_assist_context
from app.web.schemas import ComposeAssistRequest

OWNER = 'me@example.test'
RECIPIENT = 'chen@example.test'
BEFORE = '陈工，\n项目组先前已经多轮讨论这次方案的细节。\n方案已确认，请于周三前反馈意见。'
AFTER = '陈工，\n方案已确认，请于周三前反馈意见。'


def outgoing(index, *, root='', body=AFTER, status='sent', baseline=None, target=RECIPIENT):
    html = '<p>' + body.replace('\n', '<br/>') + '</p><div data-mailai-signature="s">Best regards<br/>Signature info</div>'
    html += '<div data-mailai-quote="true"><p>They agreed to a new amount and a Friday deadline.</p></div>'
    row = dict(from_addr=OWNER,to_addr=target,subject='方案反馈', body_html=html,
               in_reply_to=root or f'<parent-{index}@example.test>')
    if baseline:
        row['id'] = db.save_draft(dict(row,writing_sample={'body':baseline}))
        with db.conn() as c:
            assert json.loads(c.execute('SELECT writing_sample FROM drafts WHERE id=?',(row['id'],)).fetchone()[0])['body'] == baseline
    record = db.create_sent_message(row)
    if status == 'sent':
        db.finish_sent_message(record, ok=True, message_id=f'<test-{index}@example.test>')
    elif status == 'partial':
        db.finish_sent_message(record, ok=True, smtp_response='partially accepted', message_id=f'<test-{index}@example.test>')
    return record


def main():
    assert style.authored_text({'body_html': '<div>Hello team,<br/>The delivery plan is confirmed.</div>'
        '<blockquote><p>Quoted<br/>text</p></blockquote><div class="gmail_signature">Someone</div>'}) == 'Hello team,\nThe delivery plan is confirmed.'
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        account = dict(ACCOUNT_ID='one',DB_PATH=str(root/'one.db'),DATA_DIR=tmp,IMAP_USER=OWNER)
        model_ready = [False]
        with use(account), patch.object(client, 'available', side_effect=lambda: model_ready[0]), \
             patch.object(client, 'chat_completion', side_effect=AssertionError('Background learning called the model')):
            db.init_db()
            assert not memory.epoch() and memory.process_batch() == 0
            waiting = memory.listing(0,30)['settings']
            assert not waiting['collect'] and not waiting['initialized'] and not waiting['model_ready']
            # Once a model is configured, learning starts automatically without manual enable.
            model_ready[0] = True
            token = memory.epoch()
            assert token
            settings = memory.listing(0,30)['settings']
            assert settings['collect'] and settings['initialized'] and settings['model_ready'] and settings['days'] == 90
            assert memory.configure(False,90,0) is None, 'Older settings tabs cannot overwrite new settings'
            settings = memory.configure(True,180,settings['revision'])
            assert settings['days'] == 180 and memory.epoch() == token, 'Adjusting history window keeps active baseline epoch'
            baseline = dict(value=BEFORE,prefix='',epoch=token,audience=[[RECIPIENT],[],[]])
            first = outgoing(1,root='<same@example.test>',baseline=baseline)
            outgoing(2,root='<same@example.test>',baseline=baseline)
            outgoing(3,root='<same@example.test>',baseline=baseline)
            pending = outgoing(4,baseline=baseline,status='sending')
            outgoing(5, status='partial')
            db.upsert_email(dict(uid=1,folder='Sent',status='sent',from_addr=OWNER,to_addr=RECIPIENT,
                                 message_id='<test-1@example.test>',body_text=AFTER,date=datetime.now().isoformat()))
            inbound_id = db.upsert_email(dict(uid=2,folder='INBOX',status='inbox',from_addr=RECIPIENT,to_addr=OWNER,
                                 message_id='<incoming@example.test>',body_text='Please confirm whether the design is ready for review.',
                                 date=datetime.now().isoformat()))
            assert memory.reply_language(inbound_id, '') == 'en'
            assert memory.process_batch() == 5
            assert not memory.listing(0,30)['items'], 'One conversation does not become a habit'
            assert not memory.recall(RECIPIENT,'','','reply',{})
            with db.conn() as c:
                assert c.execute('SELECT writing_sample FROM sent_messages WHERE id=?',(first,)).fetchone()[0] == ''
                assert c.execute('SELECT writing_sample FROM sent_messages WHERE id=?',(pending,)).fetchone()[0]
                assert c.execute('SELECT COUNT(*) FROM writing_memory_samples WHERE message_key IS NOT NULL').fetchone()[0] == 3
            db.finish_sent_message(pending, ok=True, message_id='<test-4@example.test>')
            outgoing(6,baseline=baseline)
            assert memory.process_batch() == 2
            rules = memory.listing(0,30)['items']
            opening = next(rule for rule in rules if rule['field']=='opening' and rule['scope']=='contact')
            assert opening['status'] == 'adopted' and opening['count'] == 3
            assert all(entry['before'] and entry['after'] and 'Signature' not in entry['after'] for entry in opening['evidence'])
            with db.conn() as c:
                c.execute("UPDATE emails SET pending_action='trash_local',remote_missing=1 WHERE uid=1")
            opening_after_trash = next(rule for rule in memory.listing(0,30)['items'] if rule['id']==opening['id'])
            assert all(entry['id'] != first for entry in opening_after_trash['evidence']), 'Deleted sent mail must not surface in evidence'
            with db.conn() as c:
                c.execute("UPDATE emails SET pending_action='',remote_missing=0 WHERE uid=1")
            learned = memory.recall(RECIPIENT,'','','reply',{})
            assert learned['opening'] == {'value':'conclusion','scope':'contact'}
            mixed = memory.recall(RECIPIENT,'external@example.test','','reply',{})
            assert mixed and all(rule['scope']=='account' for rule in mixed.values()), 'No private style in mixed mail'
            assert not memory.recall(RECIPIENT,'','','compose',{}), 'New mail and replies are independent'
            language = next(rule for rule in rules if rule['field']=='language' and rule['scope']=='contact')
            assert memory.update(language['id'],language['revision'],'save',value='en')
            assert memory.update(opening['id'],opening['revision'],'pause')
            assert not memory.update(opening['id'],opening['revision'],'delete')
            length = next(rule for rule in rules if rule['field']=='length' and rule['scope']=='contact')
            with db.conn() as c:
                c.execute("UPDATE writing_memory_rules SET status='pending' WHERE id=?", (length['id'],))
            db.init_db()
            migrated = {row['id']:row for row in memory.listing(0,30)['items']}
            assert migrated[length['id']]['status'] == 'adopted', 'Previously suggested habits become active during upgrade'
            assert migrated[opening['id']]['status'] == 'paused'
            assert migrated[language['id']]['value'] == 'en'
            assert memory.recall(RECIPIENT,'','','reply',{})['opening']['scope'] == 'account'
            outgoing(7,baseline=baseline)
            assert memory.process_batch() == 1
            refreshed = {row['id']:row for row in memory.listing(0,30)['items']}
            assert refreshed[opening['id']]['status'] == 'paused' and refreshed[language['id']]['value'] == 'en'
            assert memory.update(opening['id'],refreshed[opening['id']]['revision'],'resume')
            meta = {}
            messages, _, _ = _compose_assist_context(ComposeAssistRequest(operation='reply',user_instruction='核对结果',
                use_work_preferences=True,recipients=RECIPIENT,recipient_fields={'to_addr':RECIPIENT},automatic_length=True),memory_info=meta)
            assert meta['rules']['language']['value']=='en' and '优先，否则使用英文' in messages[0]['content']
            assert '结论放在正文开头' in messages[-1]['content'] and BEFORE not in messages[-1]['content']
            _compose_assist_context(ComposeAssistRequest(operation='reply',user_instruction='核对结果',original_text=AFTER,
                use_work_preferences=True,recipients=RECIPIENT,recipient_fields={'to_addr':RECIPIENT}),memory_info=meta)
            assert meta['rules']['language'] == {'value':'zh','scope':'thread'}
            meta = {}
            _compose_assist_context(ComposeAssistRequest(operation='reply',user_instruction='核对结果',
                use_work_preferences=False,recipients=RECIPIENT,recipient_fields={'to_addr':RECIPIENT}),memory_info=meta)
            assert meta['rules'] == {}
            assert not style.edited_signals({'body':baseline},BEFORE.replace('周三','周五'),'方案反馈',[[RECIPIENT],[],[]],token)
            assert not style.edited_signals({'body':baseline},AFTER,'方案反馈',[['other@example.test'],[],[]],token)
            appended = dict(baseline,prefix='请核对本周计划。')
            assert style.edited_signals({'body':appended},'请核对本周计划。\n'+AFTER,'',[[RECIPIENT],[],[]],token)['opening']['value'] == 'conclusion'
            assert not style.edited_signals({'body':appended},'这段前缀已经重写。\n'+AFTER,'',[[RECIPIENT],[],[]],token)
            settings = memory.configure(False,90,settings['revision'])
            assert memory.recall(RECIPIENT,'','','reply',{}) and not memory.epoch()
            assert memory.process_batch() == 0, 'Manual pause must not auto-restart while model remains configured'
            master = work_memory.settings()
            work_memory.save_settings(False,False,master['revision'])
            assert not memory.recall(RECIPIENT,'','','reply',{})
            master = work_memory.settings()
            work_memory.save_settings(True,True,master['revision'])
            assert memory.clear(settings['revision'])
            settings = memory.listing(0,30)['settings']
            assert memory.configure(True,90,settings['revision'])
            assert memory.process_batch() == 0 and memory.listing(0,30)['total'] == 0
            assert len(db.list_sent_messages()) == 7 and 'writing_sample' not in db.get_sent_message(first)
        with use({**account, 'ACCOUNT_ID':'two', 'DB_PATH':str(root/'two.db')}), \
             patch.object(client, 'available', side_effect=lambda: model_ready[0]):
            db.init_db()
            model_ready[0] = False
            assert not memory.epoch() and memory.listing(0,30)['observed']==0
            model_ready[0] = True
            assert memory.epoch() != token and memory.listing(0,30)['observed']==0 and memory.listing(0,30)['total']==0
    print('PASS sent-mail learning: background scope, draft/send attribution, automatic application, upgrade, pause and clear')


if __name__ == '__main__':
    main()
