"""Offline IDLE wake-up, account isolation, pause and bounded listener count."""
import sys
from pathlib import Path
from unittest.mock import patch,MagicMock
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app import mail_idle,mailbox_jobs,imap_client
from app.account_context import current


def main():
    listener=mail_idle.Listener('a')
    client=MagicMock();client.capabilities.return_value=(b'IDLE',)
    def wake(timeout):listener.stop_event.set();return [(1,b'EXISTS')]
    client.idle_check.side_effect=wake
    mail=MagicMock();mail.__enter__.return_value.client=client
    with patch.object(mail_idle,'snapshot',return_value={'ACCOUNT_ID':'a','IMAP_USER':'a@example.test'}),patch.object(imap_client,'MailClient',return_value=mail),patch.object(mail_idle.system_settings,'_load_registry',return_value={'accounts':{'a':{'visible':True}}}),patch.object(mailbox_jobs,'poll_all') as poll:
        listener.run();poll.assert_called_once_with(force=False,account_id='a',from_idle=True);client.idle_done.assert_called_once();assert current.get() is None
    with patch.object(mail_idle,'Listener') as fake:
        mail_idle._listeners.clear();mail_idle._stopping=False
        accounts={str(i):{'visible':True} for i in range(20)}
        mail_idle.ensure(accounts);assert fake.call_count==8
        first=next(iter(mail_idle._listeners));mail_idle.ensure({first:{'visible':True,'auto_sync_paused':True}})
        assert not mail_idle._listeners
        mail_idle.stop();mail_idle.ensure(accounts);assert not mail_idle._listeners
        mail_idle._stopping=False
    print('PASS IDLE: scoped wakeup, context cleanup, pause, listener cap and shutdown')


if __name__=='__main__':main()
