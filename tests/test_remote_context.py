"""Durable chat flow with Chinese ordinals; no real platform, SMTP or model requests."""
import importlib
import json
import os
import re
import sys
import tempfile
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def main():
    with tempfile.TemporaryDirectory(prefix='mailai-phone-context-') as tmp:
        os.environ.update(MAILAI_HOME=tmp, IMAP_USER='desktop@example.test', IMAP_PASSWORD='fixture')
        from app import db, credential_store, system_settings, remote_control as remote, remote_language as language, weixin_remote as wx
        from app.account_context import use
        from app.remote_commands import canonicalize
        from app.web.routes import compose
        registry = {'accounts': {}}
        mail_ids = {}
        for account_id in ('a', 'b'):
            account = {'user': account_id + '@example.test', 'host': 'imap.example.test',
                       'db_path': tmp + '/' + account_id + '.db', 'raw_dir': tmp + '/' + account_id + '-raw'}
            registry['accounts'][account_id] = account
            with use(dict(ACCOUNT_ID=account_id, DB_PATH=account['db_path'], RAW_DIR=account['raw_dir'], IMAP_USER=account['user'])):
                db.init_db()
                for n in range(1, 4):
                    db.upsert_email(dict(uid=n, from_addr='sender@example.test', to_addr=account['user'],
                        subject=f'{account_id} 邮件 {n}', body_text=f'邮件 {n} 正文', status='inbox', date=f'2026-09-{29-n:02}T09:00:00'))
                mail_ids[account_id] = [r['id'] for r in db.list_emails(status='inbox', days=36500, limit=10, list_view=True)]
        system_settings._save_registry(registry)
        with closing(remote.connection()) as c, c:
            c.execute('INSERT INTO settings VALUES(2,?)', (json.dumps(dict(enabled=False, ai_enabled=False, bot_id='bot',
                user_id='本人', base_url=wx.BASE_URL, account_ids=[])),))
        counter = 0
        def say(text, conversation='本人', channel='weixin'):
            nonlocal counter
            counter += 1
            return remote.handle_message(channel=channel, staff_id='本人' if channel=='weixin' else 'me',
                corp_id='' if channel=='weixin' else 'corp', conversation_id=conversation, message_id=str(counter), text=text)
        with patch.object(credential_store, 'load', return_value='fixture'), patch.object(system_settings, 'account_password', return_value='fixture'):
            wx.save_config(dict(enabled=True, ai_enabled=False, account_ids=['a','b']))
            remote.save_config(dict(enabled=True, client_id='app', corp_id='corp', staff_id='me', account_ids=['a']))
            with patch.object(language.client, 'chat_completion') as model:
                assert 'a 邮件 1' in say('最新邮件')
                for text in ('查看第一封', '查看第1封', '查看第１封邮件', '请看看第一封来信！', '第一封'):
                    assert '邮件 1 正文' in say(text), text
                assert '邮件 2 正文' in say('下一封')
                assert '邮件 3 正文' in say('下一封邮件')
                assert '最后一封' in say('下一封')
                assert '邮件 2 正文' in say('上一封')
                assert '序号保持不变' in say('返回列表')
                assert '邮件 2 正文' in say('继续')
                inline = say('回复追风123123，知道了')
                assert '尚未发送' in inline and '追风123123，知道了' in inline
                assert '收件人：sender@example.test\n主题：Re: a 邮件 2\n发件邮箱：a@example.test' in inline
                assert '【回复正文】\n追风123123，知道了\n【正文结束】' in inline
                assert '复制并发送这一整行：\n确认发送 ' in inline and '确认前不会发送' in inline
                assert re.search(r'确认发送 [A-F0-9]{8}', inline)
                assert '已取消' in say('取消回复')
                assert '尚未发送' in say('回复第二封，明天反馈')
                assert '已取消' in say('取消回复')
                assert '还没有生成回复预览' in say('回复第二封收到')
                assert 'a 邮件 2' in say('状态') and '第 2 / 3' in say('上下文')
                assert '请直接输入回复正文' in say('回复这封')
                assert '等待回复正文' in say('状态')
                remote = importlib.reload(remote)
                assert '直接输入正文' in say('继续')
                body = '明天下午三点反馈：不修改数字 １２３，也保留第一封这几个字。'
                preview = say(body)
                assert body in preview and '尚未发送' in preview
                old_token = re.search(r'确认发送 ([A-F0-9]{8})', preview)[1]
                assert old_token in say('回复预览')
                say('查看这封')
                assert old_token in say('回复预览')
                revised = say('修改回复：更正为周五上午反馈。')
                new_token = re.search(r'确认发送 ([A-F0-9]{8})', revised)[1]
                assert old_token != new_token and '更正为周五上午反馈。' in revised
                with patch.object(compose, 'api_send_mail') as smtp:
                    assert '不匹配' in say('确认发送 ' + old_token)
                    smtp.assert_not_called()
                # A new process reads the same SQLite account, list, selected row and preview.
                remote = importlib.reload(remote)
                assert new_token in say('继续') and 'a@example.test' in say('状态')
                wx.save_config(dict(enabled=True, ai_enabled=True, account_ids=['a','b']))
                assert new_token in say('回复预览')  # AI-only changes don't erase the flow.
                with patch.object(compose, 'api_send_mail', return_value={'ok':True}) as smtp:
                    assert '服务器已接受' in say('确认发送 ' + new_token)
                    assert smtp.call_args.args[0].reply_to_email_id == mail_ids['a'][1]
                    say('确认发送 ' + new_token)
                    assert smtp.call_count == 1
                assert '无回复预览' in say('回复预览')
                assert '请直接输入' in say('回复第二封')
                assert '已取消' in say('取消')
                assert '邮件 2 正文' in say('查看这封')
                assert 'a 邮件 1' in say('最新邮件')
                assert '尚未发送' in say('回复第一封：收到')
                say('查看第二封')
                assert '无回复预览' in say('回复预览')
                # Separate conversation and separate transport never inherit current mail.
                assert '未选中' in say('查看这封', conversation='another-chat')
                assert '未选中' in say('查看这封', channel='dingtalk', conversation='chat')
                # Changing account explicitly discards list, current mail and old send token.
                say('切换邮箱 b@example.test')
                assert '未选中' in say('回复这封')
                assert 'b 邮件 1' in say('最新邮件')
                assert '邮件 1 正文' in say('查看第一封')
                assert '尚未发送' in say('回复：收到')
                assert '继续' in say('状态') or '待确认' in say('状态')
                model.assert_not_called()
            # AI gets structured position context, not the complete conversation transcript.
            with patch.object(language.client, 'available', return_value=True), patch.object(language.client, 'chat_completion',
                return_value={'choices':[{'message':{'content':'{"action":"read","number":null}'}}]}) as model:
                assert '邮件 1 正文' in say('再展开刚才那一封的正文给我')
                request = json.loads(model.call_args.args[0][1]['content'])
                assert request['context']['has_current'] and request['context']['current_number']==1
                assert '邮件 1 正文' not in model.call_args.args[0][1]['content']
            # Idle expiration and confirmation expiration remain independent.
            say('回复：等待确认')
            import time
            now = time.time()
            with patch.object(remote.time, 'time', return_value=now + 601):
                assert '预览已过期' in say('回复预览')
            with patch.object(remote.time, 'time', return_value=now + 1801):
                assert '已过期' in say('查看这封')
                assert '没有可继续' in say('继续')
            say('最新邮件'); say('查看第一封'); preview=say('回复：收到')
            token=re.search(r'确认发送 ([A-F0-9]{8})', preview)[1]
            wx.save_config(dict(enabled=True, ai_enabled=True, account_ids=['a']))
            with patch.object(compose, 'api_send_mail') as smtp:
                assert '不匹配' in say('确认发送 ' + token)
                smtp.assert_not_called()
            # Keep list ordinals stable while skipping a removed mail during navigation.
            say('最新邮件'); say('查看第一封')
            a=registry['accounts']['a']
            with use(dict(ACCOUNT_ID='a', DB_PATH=a['db_path'], RAW_DIR=a['raw_dir'], IMAP_USER=a['user'])):
                db.set_status(mail_ids['a'][1], 'trash')
            assert '邮件 3 正文' in say('下一封')
            assert '2. （邮件已不可用）' in say('返回列表')
            assert '邮件 1 正文' in say('上一封')
            preview=say('回复：收到');token=re.search(r'确认发送 ([A-F0-9]{8})',preview)[1]
            with use(dict(ACCOUNT_ID='a', DB_PATH=a['db_path'], RAW_DIR=a['raw_dir'], IMAP_USER=a['user'])):
                db.set_status(mail_ids['a'][0], 'quarantine')
            assert '已取消' in say('回复预览')
            with patch.object(compose,'api_send_mail') as smtp:
                assert '不匹配' in say('确认发送 '+token)
                smtp.assert_not_called()
            assert canonicalize('总结第十封')=='总结第 10 封'
            assert canonicalize('回复第两封：第一封，１３点反馈')=='回复第 2 封：第一封，１３点反馈'
            assert canonicalize('回复追风123123，知道了')=='回复：追风123123，知道了'
            assert canonicalize('回复这封，收到')=='回复：收到'
            assert canonicalize('查看第十一封')=='查看第 11 封'
            assert '无效' in say('查看第零封')
    print('PASS Chinese ordinals, navigation, staged replies, preview edits, restart recovery, scoped AI context and expiry')


if __name__ == '__main__':
    main()
