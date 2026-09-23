"""Offline arrival retry, cooperative history, scheduling and notification contracts."""
import sys
import tempfile
from pathlib import Path
from concurrent.futures import Future
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import db, pipeline, mailbox_jobs, mail_assistant
from app.account_context import use
from app.imap_client import RawMessageBatch
from app.desktop import notification_text, DesktopRuntime
from app.windows_desktop import WindowsDesktopRuntime


def main():
    client = Mock()
    client.fetch.side_effect = lambda uids, _: {} if uids[0] == 10 else {11: {b'BODY[]': b'ok'}}
    client.search.return_value = [10]
    try:
        list(RawMessageBatch(client, 'INBOX', [10, 11]))
    except RuntimeError:
        pass
    else:
        raise AssertionError('A missing body must stop before a later UID advances the cursor')
    assert all(call.args[0] == [10] for call in client.fetch.call_args_list)
    mail = Mock()
    mail.__enter__ = Mock(return_value=mail)
    mail.__exit__ = Mock(return_value=False)
    mail.fetch_new.return_value = RawMessageBatch(client, 'INBOX', [10, 11], tolerate_missing=True)
    with patch.object(pipeline, 'MailClient', return_value=mail), \
         patch.object(pipeline, '_set_fetch_state'), patch.object(pipeline, '_reset_action_guard'), \
         patch.object(pipeline.db, 'already_processed', return_value=False), \
         patch.object(pipeline.db, 'set_last_uid') as cursor, \
         patch.object(pipeline, 'process_message', return_value={'status':'inbox'}) as process:
        result = pipeline.poll_once()
        assert result['errors'] == 1 and result['fetched'] == 1
        cursor.assert_not_called()
        assert process.call_args.args[1] == 11, 'Missing body must not block later new mail'
    client.search.return_value = []
    assert list(RawMessageBatch(client, 'INBOX', [10, 11])) == [(11, b'ok')]
    client.fetch.side_effect = lambda uids, _: {uids[0]: {b'BODY[]': b'ok'}}
    assert [uid for uid, _ in RawMessageBatch(client, 'INBOX', [10, 11])] == [10, 11]

    registry = {'accounts': {'a': {'visible': True}, 'b': {'visible': True}}}
    jobs = []
    def submit(_fn, values):
        job = Future()
        jobs.append((values['ACCOUNT_ID'], job))
        return job
    with patch.object(mailbox_jobs.system_settings, '_load_registry', return_value=registry), \
         patch.object(mailbox_jobs, 'snapshot', side_effect=lambda key: {'ACCOUNT_ID': key}), \
         patch.object(mailbox_jobs, '_pending', {}), patch.object(mailbox_jobs, '_next_poll_at', {}), \
         patch.object(mailbox_jobs, '_poll_again', set()), \
         patch.object(mailbox_jobs._executor, 'submit', side_effect=submit), \
         patch.object(mailbox_jobs.config, 'POLL_INTERVAL_SECONDS', 300), \
         patch('time.monotonic', return_value=0) as clock:
        mailbox_jobs.poll_all(force=False)
        assert [key for key, _ in jobs] == ['a', 'b']
        mailbox_jobs.poll_all(force=False)
        assert len(jobs) == 2, 'Never overlap the same account'
        jobs[0][1].set_result({'ok': False, 'notifications_delivered': True})
        jobs[1][1].set_result({'ok': True, 'notifications_delivered': True})
        clock.return_value = 30
        mailbox_jobs.poll_all(force=False)
        assert [key for key, _ in jobs] == ['a', 'b', 'a'], 'Retry busy/failed account at the next heartbeat'
        mailbox_jobs.poll_all(force=True, account_id='a')
        assert len(jobs) == 3
        jobs[2][1].set_result({'ok': True, 'notifications_delivered': True})
        clock.return_value = 60
        mailbox_jobs.poll_all(force=False)
        assert [key for key, _ in jobs] == ['a', 'b', 'a', 'a'], 'Keep a manual request made while busy'
        jobs[3][1].set_result({'ok': True, 'notifications_delivered': True})
        clock.return_value = 300
        mailbox_jobs.poll_all(force=False)
        assert jobs[-1][0] == 'b', 'Healthy accounts retain their configured interval'

    paused_registry = {'accounts': {'a': {'visible': True, 'auto_sync_paused': True}}}
    with patch.object(mailbox_jobs.system_settings, '_load_registry', return_value=paused_registry), \
         patch.object(mailbox_jobs, 'snapshot', return_value={'ACCOUNT_ID': 'a'}), \
         patch.object(mailbox_jobs, '_pending', {}), patch.object(mailbox_jobs, '_next_poll_at', {}), \
         patch.object(mailbox_jobs._executor, 'submit', side_effect=submit):
        previous = len(jobs)
        mailbox_jobs.poll_all(force=False)
        assert len(jobs) == previous, 'Paused account must not poll in the background'
        mailbox_jobs.poll_all(force=True, account_id='a')
        assert len(jobs) == previous + 1, 'Manual sync must remain available while paused'

    with tempfile.TemporaryDirectory() as folder, use(dict(ACCOUNT_ID='arrival-test',
            DB_PATH=str(Path(folder) / 'mail.db'), IMAP_USER='test@example.test')):
        db.init_db()
        db.set_last_uid('INBOX', 9)
        mail = Mock()
        mail.client = client
        with patch.object(pipeline, '_account_cancellations', {}), \
             patch.object(pipeline.time, 'monotonic', return_value=0) as clock, \
             patch.object(pipeline, 'process_message', side_effect=[{'status':'inbox'}, RuntimeError('retry'), {'status':'inbox'}]) as process:
            priority = pipeline._InboxPriority(10)
            client.search.return_value = [11, 12]
            clock.return_value = 31
            priority.check(mail)
            assert priority.ceiling == 11
            client.search.return_value = [12]
            clock.return_value = 62
            priority.check(mail)
            assert priority.ceiling == 12 and db.get_last_uid('INBOX') == 9
            assert [call.args[1] for call in process.call_args_list] == [11, 12, 12]
            assert all(call.kwargs['arrival_kind'] == 'new' for call in process.call_args_list)

        mail_assistant.alerts()  # Quiet baseline before arrivals.
        email_id = db.upsert_email(dict(uid=20, subject='new', arrival_kind='new', score=80,
                                       verdict='phishing', processing_complete=1))
        with patch.object(sys, 'frozen', True, create=True), patch.object(sys, 'platform', 'darwin'), \
             patch('app.desktop.notify_poll_result') as notify:
            mailbox_jobs.notify_new_message(email_id)
            mailbox_jobs.notify_new_message(email_id)
            assert notify.call_count == 1
            result = notify.call_args.args[0]
            assert result['received'] == 1 and result['fetched'] == 1 and result['quarantined'] == 1
            assert result['account_id'] == 'arrival-test'
            history = db.upsert_email(dict(uid=21, arrival_kind='history', score=80))
            mailbox_jobs.notify_new_message(history)
            assert notify.call_count == 1
            normal = db.upsert_email(dict(uid=22, arrival_kind='new', score=0, verdict='clean'))
            with patch.object(mail_assistant, 'preferences', return_value={'notifications':'off','muted_threads':[]}):
                mailbox_jobs.notify_new_message(normal)
            assert notify.call_args.args[0]['received'] == 1 and notify.call_args.args[0]['fetched'] == 0
            assert notification_text(notify.call_args.args[0]) is None
        assert notification_text({'ok':True,'fetched':1,'notifications_delivered':True}) is None
        mac = DesktopRuntime()
        windows = WindowsDesktopRuntime()
        mac._signal_mailbox_changed = Mock()
        mac._deliver_notification = Mock()
        mac._set_dock_badge = Mock()
        windows.window = Mock()
        windows.tray = Mock()
        for hidden in (False, True):
            mac.hidden = windows.hidden = hidden
            mac.notify_poll_result(result)
            windows.notify_poll_result(result)
        assert mac._deliver_notification.call_count == windows.tray.notify.call_count == 2
        mac.notify_poll_result({'ok':True,'received':1,'fetched':0})
        windows.notify_poll_result({'ok':True,'received':1,'fetched':0})
        assert mac._deliver_notification.call_count == windows.tray.notify.call_count == 2
        assert mac._signal_mailbox_changed.call_count == windows.window.evaluate_js.call_count == 3
        assert mail_assistant.notification_allowed({'from_addr':'friend@example.test'},
               {'notifications':'important','muted_threads':[]}, {'friend@example.test'})
        assert not mail_assistant.notification_allowed({'score':90,'thread_id':'muted'},
               {'notifications':'all','muted_threads':['muted']})

        assert email_id in mail_assistant.alerts()['pending_risk_ids']
        conversation = db.create_assistant_conversation('risk analysis')
        db.set_assistant_alert_context(conversation, [email_id])
        db.add_assistant_message(conversation, 'assistant', 'risk details', [{'id':email_id}])
        db.set_reviewed(email_id)
        assert email_id not in mail_assistant.alerts()['pending_risk_ids']
        assert mail_assistant.alerts()['new_risk_count'] == 0
        context = db.assistant_alert_context(conversation, db.get_assistant_messages(conversation))
        assert context == {'alert_email_ids':[email_id], 'pending_alert_ids':[]}
        assert db.get_assistant_messages(conversation)[0]['content'] == 'risk details'
        assert not mail_assistant.needs_risk_attention({'score':90,'status':'trash'})
        assert not mail_assistant.needs_risk_attention({'score':90,'pending_action':'trash_copying'})
    print('Arrival retries, history priority, per-account scheduling, notification deduplication and handled alerts passed')


if __name__ == '__main__':
    main()
