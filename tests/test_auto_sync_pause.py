"""Pausing automatic polling is persistent and leaves manual sync available."""
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.web.routes.sync import api_auto_sync


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


if __name__ == '__main__':
    test_pause_setting()
