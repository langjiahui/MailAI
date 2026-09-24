"""Pausing automatic polling is persistent and leaves manual sync available."""
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.web.routes.sync import api_auto_sync
from app.web.server import startup_init


def test_pause_setting():
    registry = {'accounts': {'a': {'visible': True}}}
    with patch('app.web.routes.sync.config.ACCOUNT_ID', 'a', create=True), \
         patch('app.system_settings._load_registry', return_value=registry), \
         patch('app.system_settings._save_registry') as save, \
         patch('app.web.routes.sync.pipeline.cancel_fetch') as cancel, \
         patch('app.mailbox_jobs.poll_all') as poll:
        assert api_auto_sync(True)['paused'] is True
        assert registry['accounts']['a']['auto_sync_paused'] is True
        cancel.assert_called_once()
        assert api_auto_sync(False)['paused'] is False
        assert registry['accounts']['a']['auto_sync_paused'] is False
        poll.assert_called_once_with(force=True, account_id='a')
        assert save.call_count == 2


def test_paused_account_does_not_resume_interrupted_sync_on_startup():
    job = {'status': 'running'}
    registry = {'accounts': {'a': {'auto_sync_paused': True}}}
    with patch('app.web.server.db.init_db'), \
         patch('app.web.server.system_settings.initialize_current_account'), \
         patch('app.web.server.db.get_sync_job', return_value=job), \
         patch('app.web.server.config.IMAP_HOST', 'imap.example.test'), \
         patch('app.web.server.config.IMAP_USER', 'user@example.test'), \
         patch('app.web.server.config.IMAP_PASSWORD', 'secret'), \
         patch('app.web.server.system_settings._account_key', return_value='a'), \
         patch('app.web.server.system_settings._load_registry', return_value=registry), \
         patch('app.web.server.start_account_thread') as start:
        startup_init()
        assert start.call_count == 1
        assert start.call_args.args[0].__name__ == 'repair_local_mail_data'


if __name__ == '__main__':
    test_pause_setting()
    test_paused_account_does_not_resume_interrupted_sync_on_startup()
