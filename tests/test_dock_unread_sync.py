"""The macOS Dock badge follows persisted unread inbox state across accounts."""
import sys
import tempfile
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import db, desktop, system_settings
from app.account_context import use
from app.web.routes.mail_actions import api_set_email_read, api_bulk_email_action
from app.web.schemas import BulkMailRequest


def main():
    with tempfile.TemporaryDirectory() as folder:
        paths = {name: str(Path(folder) / f'{name}.db') for name in ('a', 'b')}
        ids = {}
        for name, path in paths.items():
            with use({'ACCOUNT_ID': name, 'DB_PATH': path}):
                db.init_db()
                ids[name] = db.upsert_email({'uid': 1, 'status': 'inbox'})
                db.upsert_email({'uid': 2, 'status': 'trash'})
        registry = {'accounts': {name: {'db_path': path, 'visible': True}
                                 for name, path in paths.items()}}
        runtime = desktop.DesktopRuntime()
        runtime._set_dock_badge = Mock()
        with patch.object(system_settings, '_load_registry', return_value=registry), \
             patch.object(desktop, '_runtime', runtime):
            runtime.refresh_dock_badge()
            runtime._set_dock_badge.assert_called_with('2')
            with use({'ACCOUNT_ID': 'a', 'DB_PATH': paths['a']}):
                api_set_email_read(ids['a'], True)
                runtime._set_dock_badge.assert_called_with('1')
                api_set_email_read(ids['a'], False)
                runtime._set_dock_badge.assert_called_with('2')
                api_bulk_email_action(BulkMailRequest(ids=[ids['a']], action='read', value=True))
                runtime._set_dock_badge.assert_called_with('1')
            with use({'ACCOUNT_ID': 'b', 'DB_PATH': paths['b']}):
                api_set_email_read(ids['b'], True)
                runtime._set_dock_badge.assert_called_with('')
            runtime.notify_poll_result({'ok': True, 'fetched': 3})
            runtime._set_dock_badge.assert_called_with('')
    print('Dock unread sync passed')


if __name__ == '__main__':
    main()
