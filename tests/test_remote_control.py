"""Offline phone-channel contracts: no real chat account, model, IMAP or SMTP."""
import os
import re
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch
from contextlib import closing
import json
import threading

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def main():
    with tempfile.TemporaryDirectory(prefix='mailai-remote-test-') as tmp:
        os.environ.update(MAILAI_HOME=tmp, IMAP_USER='desktop@example.test', IMAP_PASSWORD='fixture')
        from app import config, db, system_settings, credential_store, signatures, remote_control as remote, weixin_remote as wx, dingtalk_remote as ding
        from app.account_context import use
        from app.web.routes import compose
        from app.web.server import app
        from fastapi.testclient import TestClient
        registry = {'accounts':{}}
        vault = {}
        for key in ('a','b'):
            account = dict(user=key+'@example.test',host='imap.example.test',db_path=tmp+'/'+key+'.db',raw_dir=tmp+'/'+key+'-raw')
            registry['accounts'][key] = account
            with use(dict(ACCOUNT_ID=key,DB_PATH=account['db_path'],RAW_DIR=account['raw_dir'],IMAP_USER=account['user'])):
                db.init_db()
                db.upsert_email(dict(uid=1,from_addr='sender@example.test',to_addr=account['user'],subject=key+' 邮件',
                                     body_text='请确认安排',status='inbox',date='2026-09-28T09:00:00'))
                if key == 'a':
                    signatures.save({'name':'工作签名','html':'<div>顺颂商祺</div><div>张三</div>'}, make_default=True)
                else:
                    signatures.save({'name':'未启用签名','html':'<div>不应自动附加</div>'})
                    signatures.set_default('')
        system_settings._save_registry(registry)
        remote.PATH = Path(tmp)/'remote.sqlite3'
        with patch.object(credential_store,'available',return_value=True), patch.object(credential_store,'load',side_effect=lambda k:vault.get(k,'fixture' if k in ('a','b') else '')), patch.object(credential_store,'save',side_effect=lambda k,v: vault.__setitem__(k,v) is None), patch.object(system_settings,'account_password',return_value='fixture'):
            remote.save_config(dict(enabled=True,client_id='app',client_secret='private-secret',corp_id='corp',staff_id='me',account_ids=['a','b']))
            def message(text, msg=None, **kwargs):
                return remote.handle_message(staff_id='me',corp_id='corp',conversation_id='chat',message_id=msg or str(len(calls)),text=text,**kwargs)
            calls=[]
            counter=0
            def send(text, **kwargs):
                nonlocal counter
                counter+=1
                return message(text,str(counter),**kwargs)
            assert remote.handle_message(staff_id='other',corp_id='corp',conversation_id='chat',message_id='x',text='最新邮件') is None
            assert remote.handle_message(staff_id='me',corp_id='other',conversation_id='chat',message_id='x',text='最新邮件') is None
            assert send('最新邮件',private=False) is None
            first_response = send('最新邮件')
            assert 'a@example.test' in first_response and '已连接 MailAI' in first_response
            assert 'a 邮件' in send('查看第 1 封')
            assert '尚未发送' in send('回复：已收到')
            preview=send('回复第1封：明天反馈')
            assert '【默认签名】\n顺颂商祺\n张三' in preview
            token=re.search(r'确认发送 ([A-F0-9]{8})',preview)[1]
            assert not calls
            def fake_send(payload):
                calls.append((config.IMAP_USER,payload.model_dump()))
                return {'ok':True}
            with patch.object(compose,'api_send_mail',side_effect=fake_send):
                assert '不匹配' in send('确认发送 00000000')
                confirmation='confirm-durable'
                response=message('确认发送 '+token,confirmation)
                assert '服务器已接受' in response
                assert message('确认发送 '+token,confirmation)==response
                assert '不匹配' in send('确认发送 '+token)
                assert len(calls)==1 and calls[0][0]=='a@example.test'
                assert calls[0][1]['to_addr']=='sender@example.test'
                assert 'data-mailai-signature=' in calls[0][1]['body_html']
                assert '<div>顺颂商祺</div><div>张三</div>' in calls[0][1]['body_html']
                assert not calls[0][1]['preflight_confirmed']
                send('切换邮箱 b@example.test')
                assert 'b 邮件' in send('最新邮件')
                preview=send('回复第1封：<script>正文</script>')
                assert '【默认签名】' not in preview
                token=re.search(r'确认发送 ([A-F0-9]{8})',preview)[1]
                send('确认发送 '+token)
                assert calls[-1][0]=='b@example.test'
                assert '&lt;script&gt;' in calls[-1][1]['body_html']
                assert 'data-mailai-signature=' not in calls[-1][1]['body_html']
            # SMTP uncertainty consumes the preview rather than retrying the send.
            preview=send('回复第1封：请确认安排')
            token=re.search(r'确认发送 ([A-F0-9]{8})',preview)[1]
            with patch.object(compose,'api_send_mail',side_effect=RuntimeError('secret network failure')) as failed:
                response=send('确认发送 '+token)
                assert 'secret network failure' not in response
                send('确认发送 '+token)
                assert failed.call_count==1
            preview=send('回复第1封：过期预览')
            token=re.search(r'确认发送 ([A-F0-9]{8})',preview)[1]
            import time
            with patch.object(remote.time,'time',return_value=time.time()+601),patch.object(compose,'api_send_mail') as expired_send:
                assert '过期' in send('确认发送 '+token)
                expired_send.assert_not_called()
            # The real compose route still rejects dangerous content before SMTP.
            preview=send('回复第1封：高风险测试')
            token=re.search(r'确认发送 ([A-F0-9]{8})',preview)[1]
            with patch.object(compose.outgoing_guard,'local_issues',return_value=[{'level':'danger','message':'fixture'}]),patch.object(compose.smtp_client,'send') as blocked_send:
                assert '操作未完成' in send('确认发送 '+token)
                blocked_send.assert_not_called()
            assert config.IMAP_USER=='desktop@example.test'
            # Both transports must be isolated, even for the same user and message ID.
            with closing(remote.connection()) as c,c:
                c.execute('INSERT OR REPLACE INTO settings VALUES(2,?)',(json.dumps(dict(enabled=False,bot_id='bot',user_id='me',base_url=wx.BASE_URL,account_ids=['a'])),))
            vault['remote-weixin:bot']='wechat-secret'
            wx.save_config(dict(enabled=True,account_ids=['a']))
            def wxmsg(text,mid):
                return remote.handle_message(channel='weixin',staff_id='me',conversation_id='me',message_id=mid,text=text)
            assert 'a 邮件' in wxmsg('最新邮件','1')
            preview=wxmsg('回复第1封：微信回复','2')
            assert '【默认签名】\n顺颂商祺\n张三' in preview
            token=re.search(r'确认发送 ([A-F0-9]{8})',preview)[1]
            with patch.object(compose,'api_send_mail',side_effect=fake_send):
                assert '不匹配' in send('确认发送 '+token)
                wxmsg('确认发送 '+token,'3')
                wxmsg('确认发送 '+token,'3')
            assert len(calls)==3
            assert 'data-mailai-signature=' in calls[-1][1]['body_html']
            # Optional AI cannot send, change recipients, or override local access.
            from app import remote_language as language, mailbox_jobs
            from concurrent.futures import Future
            remote.save_config(dict(enabled=True, ai_enabled=True, client_id='app', corp_id='corp', staff_id='me', account_ids=['a','b']))
            assert remote.public_config()['ai_enabled']
            assert 'b@example.test' in send('状态')
            send('切换邮箱 a@example.test')
            welcome=send('最新邮件')
            assert '已连接 MailAI' not in welcome and '已连接 MailAI' not in send('最新邮件')  # AI-only setting changes preserve context.
            with patch.object(language.client,'available',return_value=True), patch.object(language.client,'chat_completion') as model:
                send('最新邮件'); send('回复第1封：收到'); send('确认发送 00000000')
                model.assert_not_called()
                def model_result(content):
                    model.return_value={'choices':[{'message':{'content':content}}]}
                model_result('正文收到，谢谢。')
                preview=send('起草回复第1封：礼貌确认收到')
                assert '尚未发送' in preview and '收件人：sender@example.test' in preview
                assert '正文收到，谢谢。' in preview
                assert model.call_args.kwargs['timeout']==8
                model_result('简短摘要')
                assert '简短摘要' in send('总结第1封')
                model_result('{"action":"read","number":1}')
                assert '请确认安排' in send('帮我看看第一封来信')
                model_result('{"action":"send","number":null}')
                with patch.object(compose,'api_send_mail') as forbidden:
                    assert '没有确定' in send('替我处理这封来信')
                    assert '明确指令' in send('帮我发送回复')
                    forbidden.assert_not_called()
                model_result('{"action":"read","number":true}')
                assert '没有确定' in send('看看那个邮件')
                model.return_value=None
                assert 'AI 暂不可用' in send('起草回复第1封：确认收到')
                assert 'a 邮件' in send('最新邮件')
                model.reset_mock()
                assert remote.handle_message(staff_id='stranger',corp_id='corp',conversation_id='chat',message_id='ai-unauthorized',text='总结第1封') is None
                model.assert_not_called()
            # Job completion sends one feedback after the original reply, never starts another job.
            job=Future();delivered=[];notified=threading.Event()
            def feedback(text): delivered.append(text);notified.set()
            with patch.object(mailbox_jobs,'poll_all',return_value={'ok':True}) as poll, patch.object(mailbox_jobs,'poll_future',return_value=job):
                response=message('查收邮件','sync-feedback')
                assert '后台收取' in response and not delivered
                remote.deliver_sync_feedback('dingtalk','sync-feedback',feedback,conversation_id='chat')
                remote.deliver_sync_feedback('dingtalk','sync-feedback',feedback,conversation_id='chat')
                job.set_result({'ok':True,'fetched':2,'errors':0})
                assert notified.wait(2) and len(delivered)==1 and '新增 2 封' in delivered[0]
                assert message('查收邮件','sync-feedback')==response
                assert poll.call_count==1
            # Failed jobs report failure without exposing raw exceptions or polling again.
            job=Future();notified.clear()
            with patch.object(mailbox_jobs,'poll_all',return_value={'ok':True}), patch.object(mailbox_jobs,'poll_future',return_value=job):
                message('查收邮件','sync-error')
                remote.deliver_sync_feedback('dingtalk','sync-error',feedback,conversation_id='wrong-chat')
                remote.deliver_sync_feedback('dingtalk','sync-error',feedback,conversation_id='chat')
                job.set_exception(RuntimeError('private backend secret'))
                assert notified.wait(2) and len(delivered)==2 and '收取未完成' in delivered[-1]
                assert 'private backend secret' not in delivered[-1]
            # Revoking access before completion prevents deferred mail disclosure.
            job=Future();remote.remember_sync('dingtalk','revoked',remote.settings(),'a',job)
            remote.deliver_sync_feedback('dingtalk','revoked',feedback)
            remote.save_config(dict(enabled=False,client_id='app',corp_id='corp',staff_id='me',account_ids=['b']))
            job.set_result({'ok':True,'fetched':1})
            for worker in list(remote._FEEDBACK_THREADS):
                worker.join(timeout=2)
            assert len(delivered)==2
            remote.save_config(dict(enabled=True,client_id='app',corp_id='corp',staff_id='me',account_ids=['a','b']))
            # Read/save endpoints remain local, do not echo secrets and validate enabling.
            app.router.on_startup.clear()
            with TestClient(app,base_url='http://127.0.0.1') as client, patch.object(ding,'restart',return_value={'phase':'disabled','message':'测试'}),patch.object(wx,'restart',return_value={'phase':'disabled','message':'测试'}):
                result=client.get('/api/system/remote-control',headers={'X-MailAI-Account':'obsolete'})
                assert result.status_code==200 and 'private-secret' not in result.text
                assert client.post('/api/system/remote-control/weixin/login',headers={'Origin':'https://evil.example.test'}).status_code==403
                assert client.post('/api/system/remote-control/weixin',json={'enabled':True,'account_ids':['unknown']}).status_code==400
            wx.save_config(dict(enabled=False,account_ids=['a']))
            # Real QR encoding, stale QR rejection, trusted redirects, secure confirmation.
            with patch.object(wx,'_request',return_value={'qrcode':'qr-id','qrcode_img_content':'https://example.test/scan'}):
                qr=wx.begin_login()
                assert qr['image'].startswith('data:image/png;base64,iVBOR')
                assert wx.poll_login('stale')['status']=='expired'
            with patch.object(wx,'_request',return_value={'status':'confirmed','bot_token':'new-secret','ilink_bot_id':'newbot','ilink_user_id':'本人','baseurl':wx.BASE_URL}):
                paired=wx.poll_login(qr['login_id'])
                assert paired['status']=='confirmed' and 'new-secret' not in json.dumps(paired)
                assert vault['remote-weixin:newbot']=='new-secret'
                assert not remote.settings('weixin')['enabled']
                assert wx.poll_login(qr['login_id'])['status']=='expired'
            for base in ['http://ilinkai.weixin.qq.com','https://ilinkai.weixin.qq.com.evil.test','https://user@ilinkai.weixin.qq.com','https://ilinkai.weixin.qq.com:9443','https://ilinkai.weixin.qq.com/path']:
                try: wx.trusted_base(base)
                except ValueError: pass
                else: raise AssertionError(base)
            for url in ['http://oapi.dingtalk.com/path','https://oapi.dingtalk.com.evil.test/path','https://oapi.dingtalk.com:9443/path']:
                try: ding.reply_text(url,'private')
                except ValueError: pass
                else: raise AssertionError(url)
            # Transport uses sender identity and stable outbound ID on platform replay.
            saved=remote.settings('weixin');wx.save_config(dict(enabled=True,account_ids=['a']))
            saved=remote.settings('weixin')
            msg=dict(message_type=1,from_user_id='本人',message_id=20,context_token='context',item_list=[{'type':1,'text_item':{'text':'最新邮件'}}])
            sent=[]
            with patch.object(wx,'_request',side_effect=lambda *a,**k:sent.append(k) or {'ret':0}):
                wx.process_message(saved,'new-secret',msg)
                wx.process_message(saved,'new-secret',msg)
                wx.process_message(saved,'new-secret',{**msg,'from_user_id':'other'})
                wx.process_message(saved,'new-secret',{**msg,'group_id':'group'})
            assert len(sent)==2 and sent[0]['body']['msg']['client_id']==sent[1]['body']['msg']['client_id']
            # The cursor advances with a durable pending reply, so one failure
            # cannot pin the entire platform batch after a restart.
            stop=threading.Event()
            def fail_message(*args): stop.set();raise RuntimeError('reply failed')
            with patch.object(wx,'_request',return_value={'msgs':[msg],'get_updates_buf':'new-cursor'}),patch.object(wx,'process_message',side_effect=fail_message):
                wx._listen(saved,'new-secret',stop)
            assert wx._cursor(saved['bot_id'])=='new-cursor'
            with closing(remote.connection()) as c:
                assert c.execute('SELECT COUNT(*) FROM weixin_pending WHERE bot_id=?',
                                 (saved['bot_id'],)).fetchone()[0] == 1
            with patch.object(wx,'_request',return_value={'ret':-14}):
                wx._listen(saved,'new-secret',threading.Event())
            assert wx.status()['phase']=='expired'
            assert 'private-secret' not in remote.PATH.read_bytes().decode(errors='ignore')
            assert 'new-secret' not in remote.PATH.read_bytes().decode(errors='ignore')
    print('PASS phone authorization, account isolation, confirmation receipts, QR pairing, secure storage and transport replay')


if __name__=='__main__': main()
