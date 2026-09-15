"""Live sync vs restart checkpoints and unseen-alert lifecycle, without network."""
import sys
import tempfile
from pathlib import Path
from datetime import datetime
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import db, pipeline, system_settings, mail_assistant
from app.account_context import use


def main():
    with tempfile.TemporaryDirectory() as root:
        accounts = {key: dict(user=f'{key}@example.test', host='imap.example.test',
                            db_path=str(Path(root) / f'{key}.db')) for key in ('a', 'b')}
        with patch.object(system_settings, '_load_registry', return_value={'accounts': accounts}), \
             patch.object(system_settings.credential_store, 'load', return_value='fixture'), \
             patch.object(pipeline, '_account_fetch_states', {}), \
             patch.object(pipeline, '_account_cancellations', {}):
            for key, account in accounts.items():
                with use(dict(ACCOUNT_ID=key, DB_PATH=account['db_path'], IMAP_USER=account['user'])):
                    db.init_db()
                    db.save_sync_job('poll', status='running', message='old progress')
            with use(dict(ACCOUNT_ID='a', DB_PATH=accounts['a']['db_path'], IMAP_USER=accounts['a']['user'])):
                rows = system_settings.public_config()['accounts']
                assert all(a['sync_status'] == 'interrupted' for a in rows)
                assert not pipeline.get_fetch_state()['running']
                assert '中断' in pipeline.get_fetch_state()['message']
                pipeline.cancel_fetch()
                assert not pipeline.is_fetch_running(), 'Idle cancellation must not manufacture a worker'
                with patch.object(pipeline.time, 'monotonic', return_value=100):
                    pipeline._set_fetch_state(True, operation='poll', total=8, processed=3, message='分析第3封')
                with patch.object(pipeline.time, 'monotonic', return_value=200):
                    rows = system_settings.public_config()['accounts']
                    assert rows[0]['sync_status'] == 'running' and rows[0]['sync_total'] == 8
                    assert rows[0]['sync_quiet_seconds'] == 100
                    assert rows[1]['sync_status'] == 'interrupted', 'Other account cannot inherit running state'
                with use(dict(ACCOUNT_ID='b', DB_PATH=accounts['b']['db_path'], IMAP_USER=accounts['b']['user'])):
                    pipeline._set_fetch_state(True, operation='fetch_all', total=78, processed=0, message='初始化')
                with use(dict(ACCOUNT_ID='a', DB_PATH=accounts['a']['db_path'], IMAP_USER=accounts['a']['user'])):
                    rows = system_settings.public_config()['accounts']
                    assert sum(row['sync_status'] == 'running' for row in rows) == 2
                    assert rows[0]['sync_operation'] == 'poll' and rows[1]['sync_operation'] == 'fetch_all'
                with use(dict(ACCOUNT_ID='b', DB_PATH=accounts['b']['db_path'], IMAP_USER=accounts['b']['user'])):
                    pipeline._set_fetch_state(False, operation='fetch_all', total=78, processed=78, message='初始化完成')
                pipeline.cancel_fetch()
                assert pipeline.get_fetch_state()['canceled']
                pipeline._set_fetch_state(False, operation='poll', message='完成，共处理0封')
                assert system_settings.public_config()['accounts'][0]['sync_status'] == 'completed'
                pipeline.cancel_fetch()
                assert not pipeline.is_fetch_running()

                folder_rows = [dict(name=f'Folder {index}', role='folder', total=2,
                                    processed=0, status='pending', error='') for index in range(130)]
                with patch.object(pipeline.db, 'save_sync_job') as save_job:
                    pipeline._set_fetch_state(True, operation='sync_folders', total=260,
                                              folder_progress=folder_rows, folder_omitted=30)
                    pipeline._set_fetch_state(True, operation='sync_folders', total=260,
                                              processed=1, folder_progress=folder_rows,
                                              folder_omitted=30, persist=False)
                    assert save_job.call_count == 1, 'In-memory progress must not write a DB checkpoint per message'
                state = pipeline.get_live_fetch_state()
                assert len(state['folder_progress']) == 100 and state['folder_omitted'] == 30
                state['folder_progress'][0]['status'] = 'corrupted-by-caller'
                assert pipeline.get_live_fetch_state()['folder_progress'][0]['status'] == 'pending'

                class FolderMail:
                    def __enter__(self): return self
                    def __exit__(self, *_): return False
                    def list_mailboxes(self):
                        return [dict(name='INBOX', flags=['\\Inbox'], messages=9, selectable=True),
                                dict(name='Sent', flags=['\\Sent'], messages=3, selectable=True),
                                dict(name='Drafts', flags=['\\Drafts'], messages=2, selectable=True)]

                def fake_folder_sync(_mail, mailbox, _limit=0, progress_callback=None):
                    for count in range(1, mailbox['messages'] + 1):
                        progress_callback(count)
                    return mailbox['messages']

                with patch.object(pipeline, 'MailClient', FolderMail), \
                     patch.object(pipeline, '_sync_one_folder', side_effect=fake_folder_sync), \
                     patch.object(pipeline.db, 'save_sync_job') as save_job:
                    result = pipeline.sync_auxiliary_folders()
                assert result['ok'] and result['folders'] == 2 and result['imported'] == 5
                state = pipeline.get_live_fetch_state()
                assert not state['running'] and state['processed'] == 5
                assert [row['status'] for row in state['folder_progress']] == ['completed', 'completed']
                assert save_job.call_count < 10, 'Folder progress checkpoints must stay bounded'

                today = datetime.now().isoformat()
                db.upsert_email(dict(uid=1, subject='old', date=today, score=80, verdict='phishing'))
                assert mail_assistant.alerts()['alert_level'] == 'calm'
                fresh = db.upsert_email(dict(uid=2, subject='new', date=today, score=80, verdict='phishing', arrival_kind='new'))
                assert mail_assistant.alerts()['alert_level'] == 'danger'
                mail_assistant.mark_risk_alerts_seen([fresh])
                alert = mail_assistant.alerts()
                assert alert['risk_count'] == 2 and alert['alert_level'] == 'calm'
                db.upsert_email(dict(uid=3, subject='muted', date=today, score=80, verdict='phishing', arrival_kind='new'))
                with patch.object(mail_assistant, 'preferences', return_value={'notifications':'off', 'muted_threads':[]}):
                    alert = mail_assistant.alerts()
                    assert alert['alert_level'] == 'calm' and not alert['new_risk_count']
    print('Sync restart, account isolation, completion, cancellation and alert lifecycle passed')


if __name__ == '__main__':
    main()
