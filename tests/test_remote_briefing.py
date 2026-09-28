"""Phone briefings and durable followups, with isolated mailboxes and mocked transports."""
import importlib
import json
import os
import re
import sys
import tempfile
from contextlib import closing
from datetime import date, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def main():
    with tempfile.TemporaryDirectory(prefix='mailai-briefing-') as tmp:
        os.environ.update(MAILAI_HOME=tmp, IMAP_USER='fixture@example.test', IMAP_PASSWORD='fixture')
        from app import db, credential_store, system_settings, remote_control as remote, remote_language as language, weixin_remote as wx
        from app import remote_briefing, mail_assistant
        from app.account_context import use
        from app.remote_commands import canonicalize
        from app.web.routes import compose
        today = date.today()
        registry = {'accounts': {}}
        snapshots, task_ids = {}, {}
        for account_id in ('a', 'b'):
            account = dict(user=account_id + '@example.test', host='imap.example.test',
                           db_path=tmp + '/' + account_id + '.db', raw_dir=tmp + '/' + account_id + '-raw')
            registry['accounts'][account_id] = account
            snapshots[account_id] = dict(ACCOUNT_ID=account_id, DB_PATH=account['db_path'], RAW_DIR=account['raw_dir'], IMAP_USER=account['user'])
            with use(snapshots[account_id]):
                db.init_db()
                for uid, name, days, priority, status in (
                    (1, '重要', 1, '高', 'inbox'), (2, '普通', 0, '低', 'inbox'),
                    (3, '历史', 60, '高', 'inbox'), (4, '隔离', 0, '高', 'quarantine'),
                    (5, '待删除', 0, '高', 'inbox')):
                    db.upsert_email(dict(uid=uid, from_addr='sender@example.test', to_addr=account['user'],
                        subject=account_id + name, body_text='原邮件正文 ' + name, summary='已有摘要 ' + name,
                        date=(today - timedelta(days=days)).isoformat() + 'T09:00:00', priority=priority, status=status))
                emails = {r['subject']: r['id'] for r in db.list_emails(days=36500, limit=50)}
                with db.conn() as c:
                    c.execute("UPDATE emails SET pending_action='trash_sync' WHERE id=?", (emails[account_id+'待删除'],))
                db.add_todos(emails[account_id+'历史'], [
                    dict(title=account_id+'逾期事项', deadline=(today-timedelta(days=1)).isoformat()),
                    dict(title=account_id+'今天事项', deadline=today.isoformat()),
                    dict(title=account_id+'无日期事项'),
                    dict(title=account_id+'未来提醒事项', deadline=(today+timedelta(days=2)).isoformat()),
                    dict(title=account_id+'未来事项', deadline=(today+timedelta(days=3)).isoformat()),
                    dict(title=account_id+'完成事项')])
                db.add_todos(emails[account_id+'隔离'], [dict(title='不应显示隔离')])
                db.add_todos(emails[account_id+'待删除'], [dict(title='不应显示删除')])
                tasks = db.list_todos()
                task_ids[account_id] = {r['title']: r['id'] for r in tasks}
                with db.conn() as c:
                    c.execute('UPDATE todos SET remind_at=?,stage=? WHERE id=?',
                        (datetime.now().astimezone().isoformat(), 'waiting', task_ids[account_id][account_id+'未来提醒事项']))
                db.set_todo_status(task_ids[account_id][account_id+'完成事项'], 'done')
                rows = remote_briefing.today_tasks()
                assert [r['title'] for r in rows] == [account_id+'逾期事项', account_id+'今天事项', account_id+'未来提醒事项', account_id+'无日期事项']
                assert [r['subject'] for r in remote_briefing.important()] == [account_id+'重要']
                heading, desktop = mail_assistant.todo_query_rows('今天待办', rows)
                assert '今天提醒' in heading and len(desktop) == 4
        system_settings._save_registry(registry)
        with closing(remote.connection()) as c, c:
            c.execute('INSERT INTO settings VALUES(2,?)', (json.dumps(dict(enabled=False, ai_enabled=False,
                bot_id='bot', user_id='本人', base_url=wx.BASE_URL, account_ids=[])),))
        counter = 0
        def say(text, channel='weixin', conversation='chat'):
            nonlocal counter
            counter += 1
            return remote.handle_message(channel=channel, staff_id='本人' if channel=='weixin' else 'me',
                corp_id='' if channel=='weixin' else 'corp', conversation_id=conversation, message_id=str(counter), text=text)
        with patch.object(credential_store, 'load', return_value='fixture'), patch.object(system_settings, 'account_password', return_value='fixture'):
            wx.save_config(dict(enabled=True, ai_enabled=True, account_ids=['a','b']))
            remote.save_config(dict(enabled=True, ai_enabled=True, client_id='app', corp_id='corp', staff_id='me', account_ids=['a']))
            with patch.object(language.client, 'chat_completion') as model, patch.object(compose, 'api_send_mail') as smtp:
                for channel in ('weixin', 'dingtalk'):
                    answer = say('梳理重要邮件', channel)
                    assert 'a重要' in answer and '已有摘要 重要' in answer and 'a普通' not in answer and 'b重要' not in answer
                    assert '原邮件正文 重要' in say('查看第一封', channel)
                    assert '4 项' in say('看看今天待办', channel)
                    assert 'a逾期事项' in say('查看第一项待办', channel)
                    assert 'a今天事项' in say('下一项待办', channel)
                    assert '今天有提醒' in say('下一项', channel)
                    assert '原邮件正文 历史' in say('查看原邮件', channel)
                    assert 'a未来提醒事项' in say('返回待办', channel)
                    assert '原邮件正文 历史' in say('查看第１项原邮件', channel)
                    assert '直接输入回复正文' in say('回复这封', channel)
                    preview = say('收到，稍后处理。', channel)
                    token = re.search(r'确认发送 ([A-F0-9]{8})', preview)[1]
                    assert token in say('继续', channel)
                    say('取消回复', channel)
                model.assert_not_called()
                smtp.assert_not_called()
                assert '不可用' in say('查看第十一项待办')
                # Task list and selected task survive restarting the command engine.
                say('看看今天待办'); say('查看第一项待办')
                remote = importlib.reload(remote)
                assert 'a逾期事项' in say('继续')
                with use(snapshots['a']):
                    db.set_todo_status(task_ids['a']['a逾期事项'], 'done')
                assert '已完成' in say('查看当前待办')
                assert '已完成' in say('返回待办')
                assert '3 项' in say('看看今天待办')
                assert '暂无可返回' in say('返回待办', conversation='separate')
                say('切换邮箱 b@example.test')
                assert '暂无可返回' in say('返回待办')
                assert 'b逾期事项' in say('看看今天待办')
                assert 'a逾期事项' not in say('返回待办')
                with use(snapshots['b']), db.conn() as c:
                    c.execute("UPDATE todos SET status='done'")
                assert '没有符合条件' in say('看看今天待办')
                assert 'b重要' in say('梳理重要邮件')
                assert '暂无可返回' in say('返回待办')
                assert '原邮件正文 重要' in say('查看第一封')
                smtp.assert_not_called()
            for text in ('查看第一项待办', '查看第一项原邮件', '下一项待办'):
                command = canonicalize(text)
                assert canonicalize(command) == command
            # Progress tracks successfully delivered briefings per account/channel/chat.
            def view(text, *, acknowledge=True, channel='weixin', conversation='updates'):
                answer = say(text, channel, conversation)
                if acknowledge:
                    remote.delivered(channel=channel, staff_id='本人' if channel=='weixin' else 'me',
                        corp_id='' if channel=='weixin' else 'corp', conversation_id=conversation, message_id=str(counter))
                return answer
            with patch.object(language.client, 'chat_completion') as model, patch.object(compose, 'api_send_mail') as smtp:
                view('切换邮箱 a@example.test')
                first = view('有什么新邮件？', acknowledge=False)
                assert '首次查询' in first and 'a普通' in first and 'a重要' not in first
                assert '首次查询' in view('有什么新邮件？')  # failed delivery didn't advance
                assert '本次范围共 0 封' in view('有什么新邮件？')
                def insert(uid, name, old=True):
                    with use(snapshots['a']):
                        db.upsert_email(dict(uid=uid, from_addr='sender@example.test', to_addr='a@example.test',
                            subject=name, date=(today-timedelta(days=50) if old else today).isoformat()+'T00:00:00',
                            body_text='正文 '+name, priority='高', status='inbox'))
                for n in range(12):
                    insert(100+n, f'延迟来信{n:02}')
                update = view('有什么新邮件？')
                assert '共 12 封' in update and '延迟来信09' in update and '延迟来信10' not in update
                assert '更多新邮件' in update
                insert(200, '分页期间来信')
                remote = importlib.reload(remote)
                more = view('更多新邮件')
                assert '延迟来信10' in more and '延迟来信11' in more and '分页期间来信' not in more
                assert '正文 延迟来信10' in view('查看第一封')
                assert '分页期间来信' in view('有什么新邮件？')
                assert '共 0 封' in view('有什么新邮件？')
                # Explicit time range preserves incremental progress and mail read state.
                insert(201, '今日新来信', old=False)
                answer = view('今天00:00之后的邮件')
                assert '今日新来信' in answer and '不改变' in answer
                assert '今日新来信' in view('有什么新邮件？')
                assert '今日简报' in view('今天有什么重要的？')
                assert '今日新来信' in view('查看第一封')
                assert 'a今天事项' in view('查看第一项待办')
                assert '原邮件正文 历史' in view('查看原邮件')
                assert 'a今天事项' in view('返回待办')
                assert 'a今天事项' in view('继续')
                assert '今日新来信' in view('查看第一封')
                assert '今天高优先级' not in view('返回列表')
                with use(snapshots['a']), db.conn() as c:
                    assert c.execute('SELECT SUM(is_read) FROM emails').fetchone()[0] == 0
                assert '首次查询' in view('有什么新邮件？', channel='dingtalk')
                assert '首次查询' in view('有什么新邮件？', conversation='another-updates')
                view('切换邮箱 b@example.test')
                assert '首次查询' in view('有什么新邮件？')
                view('切换邮箱 a@example.test')
                assert '共 0 封' in view('有什么新邮件？')
                assert '时间无效' in view('今天25:00之后的邮件')
                assert '时间数字无法识别' in view('今天一二点之后的邮件')
                model.assert_not_called(); smtp.assert_not_called()
            from app.remote_time import parse
            moment = datetime(2026, 9, 28, 20, 0)
            assert parse('下午两点半之后收到什么', moment)[0] == moment.replace(hour=14, minute=30)
            assert parse('昨天上午九点之后的邮件', moment)[0] == datetime(2026,9,27,9)
            assert parse('今天１４：３０之后的邮件', moment)[0] == moment.replace(hour=14, minute=30)
            try:
                parse('今天23:00之后的邮件', moment)
                assert False, 'future ranges must fail explicitly'
            except ValueError:
                pass
            # Optional model can route only the read-only briefing actions.
            with patch.object(language.client, 'available', return_value=True), patch.object(language.client, 'chat_completion',
                return_value={'choices':[{'message':{'content':'{"action":"today_tasks","number":null}'}}]}):
                assert language.normalize('帮我安排一下今天的事情', True)[0] == '今天待办'
    print('PASS briefings, delivery checkpoints, lossless pagination, late sync, time ranges, both channels, restart, isolation and read-only safety')


if __name__ == '__main__':
    main()
