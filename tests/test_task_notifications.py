"""Offline notification delivery: account isolation, retries and durable deduplication."""
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch, MagicMock
from types import SimpleNamespace
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import db, task_notifications as notices
from app.account_context import use


def main():
    now = datetime.now()
    sent = []
    def send(title, body, target):
        sent.append((title, body, target))
        return True
    with tempfile.TemporaryDirectory() as root:
        accounts = {}
        for key in ('a', 'b'):
            account = accounts[key] = {'db_path': str(Path(root) / (key + '.db')), 'user':key+'@example.test'}
            with use({'ACCOUNT_ID':key, 'DB_PATH':account['db_path']}):
                db.init_db()
                eid=db.upsert_email(dict(uid=1,subject='test',date=now.isoformat()))
                db.add_todos(eid,[{'title':'处理合同'},{'title':'核对附件'},{'title':'尚未到期'},{'title':'已完成'}])
                with db.conn() as c:
                    c.execute('UPDATE todos SET remind_at=?',((now-timedelta(minutes=1)).isoformat(),))
                    c.execute('UPDATE todos SET remind_at=? WHERE id=3',((now+timedelta(days=1)).isoformat(),))
                db.set_todo_status(4,'done')
        assert notices.dispatch_account('a',accounts['a'],now,send)==2
        assert len(sent)==1 and sent[0][2]['accountId']=='a'
        # State survives new calls/connections, not just a browser session.
        assert notices.dispatch_account('a',accounts['a'],now+timedelta(minutes=5),send)==0
        assert notices.dispatch_account('b',accounts['b'],now,lambda *args:False)==0
        assert notices.dispatch_account('b',accounts['b'],now+timedelta(seconds=30),send)==0
        assert notices.dispatch_account('b',accounts['b'],now+timedelta(seconds=61),send)==2
        with use({'ACCOUNT_ID':'a','DB_PATH':accounts['a']['db_path']}):
            with db.conn() as c:
                c.execute('UPDATE todos SET remind_at=? WHERE id=1',((now+timedelta(minutes=1)).isoformat(),))
        assert notices.dispatch_account('a',accounts['a'],now+timedelta(minutes=2),send)==1
        with patch.object(notices.system_settings,'_load_registry',return_value={'accounts':accounts}), patch.object(notices,'deliver',side_effect=AssertionError('must not resend')):
            notices.check_due_tasks()
        with patch.object(notices.system_settings,'_load_registry',return_value={'accounts':accounts}):
            records=notices.reminder_records()
            assert len([r for r in records if r['state']=='scheduled'])==3
            assert len([r for r in records if r['state']=='submitted'])==3
            assert {r['account_id'] for r in records}=={'a','b'}
        from app import windows_desktop
        tray=MagicMock()
        with patch.object(notices.sys,'platform','win32'), patch.object(windows_desktop,'_runtime',SimpleNamespace(tray=tray,notify_task_reminder=lambda title,body: (tray.notify(body,title),True)[1])):
            assert notices.capability()['supported']
            assert notices.deliver('到期','任务',{})
            tray.notify.assert_called_once_with('任务','到期')
        with patch.object(notices.sys,'platform','win32'), patch.object(windows_desktop,'_runtime',None):
            assert not notices.capability()['supported']
            assert not notices.deliver('到期','任务',{})
        # AppleScript receives text as data, without executing task text as code.
        from app import desktop
        with patch.object(notices.sys,'platform','darwin'), patch.object(desktop,'_runtime',None), patch.object(notices.subprocess,'run') as run:
            assert notices.deliver('待办','" & do shell script "bad',{'accountId':'a'})
            assert run.call_args.args[0][-1]=='" & do shell script "bad'
        native = MagicMock()
        center = MagicMock()
        kit = SimpleNamespace(NSUserNotification=native,
            NSUserNotificationCenter=center, NSUserNotificationDefaultSoundName='default')
        runtime = desktop.DesktopRuntime()
        target = {'accountId':'a','todoId':1,'remindAt':'time'}
        with patch.dict(sys.modules, {'AppKit':kit}), patch.object(runtime, '_call_after_safely', side_effect=lambda label, callback: (callback(), True)[1]):
            assert runtime._deliver_notification('任务提醒','核对附件',target)
            note = native.alloc.return_value.init.return_value
            assert 'mailai_task' in note.setUserInfo_.call_args.args[0]
            center.defaultUserNotificationCenter.return_value.deliverNotification_.assert_called_once_with(note)
        with patch.dict(sys.modules, {'AppKit':kit}), patch.object(runtime, '_call_after_safely', return_value=False):
            assert runtime._deliver_notification('任务提醒','核对附件',target) is False
        print('Task reminders passed: grouped delivery, restart dedup, retry lease, reschedule, completion, account isolation, safe source notification')

if __name__=='__main__': main()
