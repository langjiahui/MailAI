"""Offline deadlines, wake-ups and healthy-IDLE fallback; no real SMTP/IMAP."""
import sys
import tempfile
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch, MagicMock
from types import SimpleNamespace
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import db, energy_scheduler as energy, outbox, mail_idle, mailbox_jobs, task_notifications as notices
from app.account_context import use


def main():
    with tempfile.TemporaryDirectory() as folder:
        path=Path(folder)/'mail.db'; account={'db_path':str(path),'user':'fixture@example.test'}
        with use({'ACCOUNT_ID':'fixture','DB_PATH':str(path),'IMAP_USER':account['user']}):
            db.init_db()
            with db.conn() as c: notices.ensure_delivery_table(c)
            assert energy.next_delay({'a':account},'outbox')==60
            assert energy.next_delay({'a':account},'reminders')==60
            energy.outbox_changed.clear(); energy.reminders_changed.clear()
            with db.conn() as c: c.execute('SELECT count(*) FROM emails').fetchone()
            assert not energy.outbox_changed.is_set(), 'Reads cannot keep workers awake'
            when=(datetime.now()+timedelta(seconds=25)).isoformat(timespec='seconds')
            draft=db.save_draft({'subject':'scheduled fixture','send_at':when})
            outbox.enqueue('deadline',{'id':draft,'subject':'scheduled fixture','send_at':when})
            assert energy.outbox_changed.is_set() and energy.reminders_changed.is_set()
            delay=energy.next_delay({'a':account},'outbox'); assert 23<=delay<=26,delay
            outbox.reschedule('deadline',(datetime.now()+timedelta(hours=1)).isoformat())
            assert energy.next_delay({'a':account},'outbox')==60
            outbox.cancel('deadline'); assert energy.next_delay({'a':account},'outbox')==60
            # A write from the queue worker doesn't wake itself forever.
            energy.outbox_changed.clear(); energy.reminders_changed.clear()
            with patch.object(energy.threading,'current_thread',return_value=SimpleNamespace(name='outbox')):
                energy.database_changed()
            assert not energy.outbox_changed.is_set() and energy.reminders_changed.is_set()
            at=(datetime.now()+timedelta(seconds=12)).isoformat(timespec='seconds')
            with db.conn() as c:
                c.execute("INSERT INTO todos(title,status,remind_at) VALUES('fixture','open',?)",(at,))
                todo_id=c.execute('SELECT last_insert_rowid()').fetchone()[0]
            assert 10<=energy.next_delay({'a':account},'reminders')<=13
            later=(datetime.now()+timedelta(seconds=45)).isoformat(timespec='seconds')
            with db.conn() as c:
                c.execute("INSERT INTO task_notice_delivery(todo_id,remind_at,sent,retry_after) VALUES(?,?,0,?)",(todo_id,at,later))
            assert 43<=energy.next_delay({'a':account},'reminders')<=46, 'Honor failed-notification leases'
            with db.conn() as c: c.execute('UPDATE task_notice_delivery SET sent=1')
            assert energy.next_delay({'a':account},'reminders')==60, 'Submitted notices cannot wake repeatedly'
            with db.conn() as c: c.execute('UPDATE todos SET remind_at=?',((datetime.now()-timedelta(seconds=1)).isoformat(),))
            assert energy.next_delay({'a':account},'reminders')==1
            assert energy.next_delay({'a':{**account,'visible':False}},'reminders')==60
            retries={'a':(3,time.monotonic()+40)}
            assert 39<=energy.next_delay({'a':account},'outbox',retries=retries)<=41
            # A failed transaction must not emit a successful-change wakeup.
            energy.outbox_changed.clear()
            try:
                with db.conn() as c:
                    c.execute("INSERT INTO todos(title,status) VALUES('rolled back','open')")
                    raise RuntimeError('fixture rollback')
            except RuntimeError: pass
            assert not energy.outbox_changed.is_set()
    listener=MagicMock();listener.state='listening';listener.last_check=time.monotonic();listener.thread.is_alive.return_value=True
    with patch.dict(mail_idle._listeners,{'fixture':listener},clear=True):
        assert mail_idle.listening('fixture')
        listener.last_check=time.monotonic()-121; assert not mail_idle.listening('fixture')
        listener.last_check=time.monotonic();listener.state='polling';assert not mail_idle.listening('fixture')
    # Keep the configured fallback frequency even when IDLE appears healthy.
    # Server notifications and manual sync bypass the periodic cooldown.
    mailbox_jobs._stopping.clear();mailbox_jobs._pending.clear();mailbox_jobs._next_poll_at.clear()
    with patch.object(mail_idle,'ensure'),patch.object(mailbox_jobs.system_settings,'_load_registry',return_value={'accounts':{'fixture':{'visible':True}}}),patch.object(mailbox_jobs,'snapshot',return_value={'ACCOUNT_ID':'fixture'}),patch.object(mailbox_jobs._executor,'submit') as submit:
        mailbox_jobs._next_poll_at['fixture']=time.monotonic()+60
        mailbox_jobs.poll_all(force=False);submit.assert_not_called()
        mailbox_jobs._next_poll_at['fixture']=0
        mailbox_jobs.poll_all(force=False);submit.assert_called_once()
        mailbox_jobs._pending.clear();submit.reset_mock()
        mailbox_jobs._next_poll_at['fixture']=time.monotonic()+60
        mailbox_jobs.poll_all(force=True);submit.assert_called_once()
        mailbox_jobs._pending.clear();submit.reset_mock()
        mailbox_jobs._next_poll_at['fixture']=time.monotonic()+60
        mailbox_jobs.poll_all(force=False,account_id='fixture',from_idle=True);submit.assert_called_once()
    mailbox_jobs._pending.clear();mailbox_jobs._next_poll_at.clear()

    # Real sleeping workers: a newly committed job wakes immediately, but never
    # executes before its deadline. Sending and notification delivery are mocked.
    with tempfile.TemporaryDirectory() as folder:
        path=Path(folder)/'worker.db'; account={'db_path':str(path),'user':'fixture@example.test'}
        values={'ACCOUNT_ID':'fixture','DB_PATH':str(path),'IMAP_USER':account['user']}
        with use(values):db.init_db()
        registry={'accounts':{'fixture':account}}
        initial=threading.Event(); sent=threading.Event(); calls=[]
        def fake_send(payload):
            calls.append(time.monotonic());sent.set();return {'ok':True}
        def pass_outboxes(*args):
            with use(values):outbox.process(fake_send)
            initial.set()
        with patch.object(mailbox_jobs.system_settings,'_load_registry',return_value=registry),patch.object(mailbox_jobs,'_check_outboxes',side_effect=pass_outboxes):
            mailbox_jobs.start_outbox()
            try:
                assert initial.wait(3),'Worker did not initialize'
                created=time.monotonic()
                with use(values):outbox.enqueue('wake-test',{'subject':'fixture','to_addr':'client@example.test'},delay=1)
                assert not sent.wait(.2),'A delayed send fired early'
                assert sent.wait(3),'A committed send did not wake a sleeping worker'
                assert len(calls)==1 and calls[0]-created>=.95
            finally:assert mailbox_jobs.stop_outbox(timeout=3),'A 60-second idle wait must be interruptible'
        initial.clear();notified=threading.Event(); notices_count=[]
        original=notices.check_due_tasks
        def checked():
            original();initial.set()
        def fake_notice(*args):
            notices_count.append(time.monotonic());notified.set();return True
        with patch.object(notices.system_settings,'_load_registry',return_value=registry),patch.object(notices,'check_due_tasks',side_effect=checked),patch.object(notices,'deliver',side_effect=fake_notice):
            notices.start_reminders()
            try:
                assert initial.wait(3),'Reminder worker did not initialize'
                created=time.monotonic()
                with use(values):
                    with db.conn() as c:
                        c.execute("INSERT INTO todos(title,status,remind_at) VALUES('fixture','open',?)",((datetime.now()+timedelta(seconds=1)).isoformat(),))
                assert not notified.wait(.2),'A reminder fired early'
                assert notified.wait(3),'A committed reminder did not wake its worker'
                assert len(notices_count)==1 and notices_count[0]-created>=.95
            finally:assert notices.stop_reminders(timeout=3),'Reminder shutdown must interrupt its idle wait'
    print('PASS energy: empty-queue sleep, committed wakeups, due times, retry leases, rollback, IDLE fallback and manual sync')


if __name__=='__main__':main()
