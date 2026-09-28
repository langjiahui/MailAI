"""Automatic snapshots stay bounded and do not remove manual backups."""
import os
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import automatic_backup, config, db, system_settings
from app.account_context import use


class AutomaticBackupTests(unittest.TestCase):
    def test_weekly_snapshot_retention_and_disk_guard(self):
        with tempfile.TemporaryDirectory(prefix='mailai-auto-backup-') as folder:
            root = Path(folder)
            raw = root / 'raw'
            raw.mkdir()
            (raw / 'mail.eml').write_text('fixture', encoding='utf-8')
            account = dict(user='fixture@example.test', host='imap.example.test',
                           db_path=str(root / 'mailai.db'), raw_dir=str(raw), visible=True)
            account_id = system_settings._account_key(account['host'], account['user'])
            values = dict(ACCOUNT_ID=account_id, DB_PATH=account['db_path'], RAW_DIR=account['raw_dir'],
                          IMAP_HOST=account['host'], IMAP_USER=account['user'])
            with use(values):
                db.init_db()
            registry = {'accounts': {account_id: account}}
            with patch.object(config, 'DATA_DIR', str(root)), \
                    patch.object(system_settings, '_load_registry', return_value=registry), \
                    patch.object(automatic_backup.shutil, 'disk_usage',
                                 return_value=SimpleNamespace(free=10 ** 12)):
                with use(values):
                    manual = system_settings.create_backup(include_raw=True)['filename']
                for number in range(4):
                    automatic_backup.run_due()
                    if number < 3:
                        newest = automatic_backup._automatic_files(account_id)[0]
                        old = newest.stat().st_mtime - automatic_backup.INTERVAL_SECONDS - 1
                        os.utime(newest, (old, old))
                files = automatic_backup._automatic_files(account_id)
                self.assertEqual(len(files), automatic_backup.KEEP_AUTOMATIC)
                self.assertTrue((root / 'backups' / manual).exists())
                with zipfile.ZipFile(files[0]) as archive:
                    self.assertIn('mailai.db', archive.namelist())
                    self.assertIn('raw/mail.eml', archive.namelist())
                before = len(files)
                with patch.object(automatic_backup, 'MAX_SOURCE_BYTES', 0):
                    for path in files:
                        os.utime(path, (0, 0))
                    automatic_backup.run_due()
                self.assertEqual(len(automatic_backup._automatic_files(account_id)), before)


if __name__ == '__main__':
    unittest.main()
