"""Exercise real SDK frame routing and HTTP construction without external calls."""
import asyncio
import json
import sys
import threading
from pathlib import Path
from unittest.mock import patch, Mock
import subprocess
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from app import dingtalk_remote as ding, weixin_remote as wx


def main():
    from app import credential_store
    with patch.object(credential_store,'_keyring',return_value=None),patch.object(credential_store.platform,'system',return_value='Darwin'),patch.object(credential_store.subprocess,'run',side_effect=subprocess.CalledProcessError(1,['security','-w','fixture-private-secret'])):
        with unittest.TestCase().assertLogs('app.credential_store',level='WARNING') as logs:
            assert not credential_store.save('fixture','fixture-private-secret')
        assert 'fixture-private-secret' not in '\n'.join(logs.output)
    response=Mock(status_code=200)
    response.json.return_value={'ret':0}
    with patch('requests.request',return_value=response) as request:
        wx._request(wx.BASE_URL,'/ilink/bot/getupdates',token='fixture-secret',body={'get_updates_buf':'cursor'},read_timeout=40)
        args,kwargs=request.call_args
        assert args[0]=='POST' and kwargs['timeout']==(8,40) and kwargs['allow_redirects'] is False
        assert kwargs['headers']['Authorization']=='Bearer fixture-secret'
        assert kwargs['json']['get_updates_buf']=='cursor' and kwargs['json']['base_info']['bot_agent']=='MailAI/1.0'
        wx._request(wx.BASE_URL,'/ilink/bot/get_qrcode_status',params={'qrcode':'fixture'})
        assert request.call_args[0][0]=='GET' and 'Authorization' not in request.call_args[1]['headers']
    response.json.return_value={'endpoint':'wss://stream.dingtalk.com/connect','ticket':'secret'}
    with patch('requests.post',return_value=response) as request:
        ding.open_connection({'client_id':'app'},'fixture-secret')
        assert request.call_args[1]['timeout']==(10,20)
        assert request.call_args[1]['allow_redirects'] is False
    # WeChat also advances only after the platform accepted the reply.
    saved = dict(bot_id='fixture',user_id='owner',base_url=wx.BASE_URL)
    message = dict(message_type=1,from_user_id='owner',message_id='fixture-msg',context_token='context',
                   item_list=[{'type':1,'text_item':{'text':'有什么新邮件？'}}])
    for failed in (False, True):
        with patch.object(wx.remote_control,'handle_message',return_value='新邮件简报'), \
                patch.object(wx.remote_control,'deliver_sync_feedback'), \
                patch.object(wx.remote_control,'delivered') as delivered, \
                patch.object(wx,'_request',return_value={'ret':1 if failed else 0}):
            try:
                wx.process_message(saved,'fixture-secret',message)
                assert not failed
            except ValueError:
                assert failed
            assert delivered.call_count == (0 if failed else 1)
    for reply_failure in (False,True):
        stop=threading.Event(); captured=[]; replies=[]
        class Socket:
            def __init__(self): self.received=False
            async def __aenter__(self): return self
            async def __aexit__(self,*args): return
            async def recv(self):
                if self.received:
                    while not stop.is_set(): await asyncio.sleep(.01)
                    raise asyncio.TimeoutError()
                self.received=True
                return json.dumps({'type':'CALLBACK','headers':{'topic':'/v1.0/im/bot/messages/get','messageId':'frame'},
                    'data':json.dumps({'msgId':'platform-message','msgtype':'text','text':{'content':'最新邮件'},
                                      'senderCorpId':'corp','senderStaffId':'me','conversationId':'chat','conversationType':'1',
                                      'sessionWebhook':'https://oapi.dingtalk.com/robot/sendBySession?session=fixture'})})
            async def send(self,text): replies.append(json.loads(text));stop.set()
        def engine(**kwargs): captured.append(kwargs);return '本机邮件列表'
        def reply(*args):
            if reply_failure: raise ValueError('fixture')
        with patch('websockets.connect',return_value=Socket()),patch.object(ding,'open_connection',return_value={'endpoint':'wss://stream.dingtalk.com/connect','ticket':'secret'}),patch.object(ding.remote_control,'handle_message',side_effect=engine),patch.object(ding,'reply_text',side_effect=reply),patch.object(ding.remote_control,'delivered') as delivered:
            asyncio.run(asyncio.wait_for(ding._listen({'client_id':'app'},'fixture-secret',stop),timeout=3))
            assert delivered.call_count == (0 if reply_failure else 1)
            if not reply_failure:
                assert delivered.call_args.kwargs == dict(channel='dingtalk',corp_id='corp',staff_id='me',conversation_id='chat',message_id='platform-message')
        assert captured==[dict(corp_id='corp',staff_id='me',conversation_id='chat',message_id='platform-message',text='最新邮件',private=True)]
        assert replies[0]['code']==(500 if reply_failure else 200)
    print('PASS authenticated WeChat HTTP headers, bounded requests and real DingTalk SDK callbacks/acknowledgements')


if __name__=='__main__': main()
