"""Whole-message scope, honest file coverage, exclusions and history isolation."""
import asyncio
import json
import tempfile
from email.message import EmailMessage
from pathlib import Path
from unittest.mock import patch
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from app import config, db, assistant_mail_context as whole, assistant_vision, assistant_documents
from app.account_context import use
from app.web.routes import assistant
from app.web.schemas import AssistantRequest


def main():
    with tempfile.TemporaryDirectory() as root, use({'ACCOUNT_ID':'whole','DB_PATH':str(Path(root)/'mail.db'),'IMAP_USER':'user@example.test'}), patch.multiple(config,LLM_API_KEY='fixture',LLM_MODEL='fixture-model',MULTIMODAL_ENABLED=False,DOCUMENT_INPUT_MODE='text'):
        db.init_db()
        message=EmailMessage();message.set_content('BODY_DELIVERY_2026')
        metadata=[]
        for index in range(6):
            raw=f'OWNER_{index},DELIVERY_{index}\nTeam_{index},2026-12-{index+1:02d}'.encode()
            name=f'delivery-{index}.csv';message.add_attachment(raw,maintype='text',subtype='csv',filename=name)
            metadata.append({'name':name,'size':len(raw)})
        message.add_attachment(b'not a zip',maintype='application',subtype='zip',filename='archive.zip');metadata.append({'name':'archive.zip','size':9})
        raw_path=Path(root)/'mail.eml';raw_path.write_bytes(message.as_bytes())
        email_id=db.upsert_email({'uid':1,'subject':'Delivery confirmation','body_text':'BODY_DELIVERY_2026','attachments':metadata,'raw_path':str(raw_path)})
        with patch.object(assistant_vision.client,'chat_completion') as call:
            catalog=assistant.api_assistant_mail_context(email_id)
            assert len(json.loads(catalog.body)['items'])==7
            call.assert_not_called()
        calls=[]
        def answer(messages,**kwargs):
            calls.append(messages)
            return iter(['交付安排已核对【附件6】。'])
        with patch.object(assistant_vision.client,'chat_completion_stream',side_effect=answer):
            result=assistant.api_assistant_ask(AssistantRequest(question='总结这封邮件',email_ids=[email_id],open_email_id=email_id))
        parts=calls[-1][-1]['content'];text='\n'.join(p.get('text','') for p in parts)
        assert 'BODY_DELIVERY_2026' in text and all(f'OWNER_{i}' in text for i in range(6))
        assert 'archive.zip' in text and '暂不支持此格式' in text
        conversation=result['conversation_id']
        saved=assistant.api_assistant_conversation(conversation)
        assert saved['mail_context']['email_id']==email_id and len(saved['mail_context']['items'])==7
        assert saved['attachments']==[] and 'OWNER_0' not in json.dumps(saved)
        assert db.get_assistant_attachment_refs(conversation)==[]
        assistant.api_assistant_mail_context_update(conversation,{'email_id':email_id,'excluded':[0,1]})
        assert assistant.api_assistant_conversation(conversation)['mail_context']['excluded']==[0,1]
        # The actual request carries explicit choices; no model-side guessing about omissions.
        chosen={'email_id':email_id,'excluded':[0,1]}
        with patch.object(assistant_vision.client,'chat_completion_stream',side_effect=answer):
            follow=assistant.api_assistant_ask(AssistantRequest(question='具体交期呢？',email_ids=[email_id],open_email_id=email_id,conversation_id=conversation,mail_context=chosen))
        text='\n'.join(p.get('text','') for p in calls[-1][-1]['content'])
        assert 'OWNER_0' not in text and 'OWNER_1' not in text and 'OWNER_5' in text
        assert '用户已排除' in text and follow['conversation_id']==conversation
        with patch.object(assistant_vision.client,'chat_completion_stream') as model:
            assistant.api_assistant_ask(AssistantRequest(question='你能做什么',email_ids=[email_id],conversation_id=conversation,mail_context=chosen))
            model.assert_not_called()
        assert db.get_assistant_mail_context(conversation)['excluded']==[0,1]
        # A broken file is an explicit gap, while other files still reach the model.
        real_prepare=assistant_documents.prepare
        def partial(refs,context=None):
            if refs[0]['index']==2:raise ValueError('附件损坏')
            return real_prepare(refs,context)
        with patch.object(assistant_documents,'prepare',side_effect=partial),patch.object(assistant_vision.client,'chat_completion_stream',side_effect=answer):
            stream=assistant.api_assistant_ask_stream(AssistantRequest(question='核对正文与附件',email_ids=[email_id],mail_context=chosen))
            async def consume():return [json.loads(line) async for line in stream.body_iterator]
            events=asyncio.run(consume())
        assert events[-1]['type']=='done'
        coverage=next(e['items'] for e in events if e['type']=='materials')
        assert coverage[0]['status']=='excluded' and coverage[2]['status']=='unavailable' and coverage[5]['status']=='read'
        text='\n'.join(p.get('text','') for p in calls[-1][-1]['content'])
        assert 'OWNER_2' not in text and 'OWNER_5' in text
        assert whole.resolve(AssistantRequest(question='总结',email_ids=[email_id],include_mail_attachments=False)) is None
        assert whole.resolve(AssistantRequest(question='查找文件',email_ids=[email_id],search_mode=True)) is None
        assert whole.resolve(AssistantRequest(question='风险',email_ids=[email_id],alert_context=True)) is None
        # Long bodies are explicitly described as bounded, not certified as fully read.
        with patch.object(whole.db,'get_email',return_value={**db.get_email(email_id),'body_text':'x'*40000}):
            assert whole.describe(email_id)['body_partial']
        # Material reading does not disable existing mailbox-specific memory requests.
        with patch.object(assistant_vision.client,'chat_completion_stream') as model:
            assistant.api_assistant_ask(AssistantRequest(question='以后回信简短一点',email_ids=[email_id]))
            model.assert_not_called()
        with use({'ACCOUNT_ID':'other','DB_PATH':str(Path(root)/'other.db')}):
            db.init_db();assert db.get_assistant_mail_context(conversation) is None
            try:whole.describe(email_id)
            except ValueError:pass
            else:raise AssertionError('Read materials from a different account')
        assert 'fixture' not in json.dumps(db.get_assistant_mail_context(conversation))
    print('PASS whole email: six automatic files, local catalog, explicit gaps, exclusions, continuous history, memory and account isolation')


if __name__=='__main__':main()
