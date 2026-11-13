"""Upgrade real v4.1.1 schema/rows without changing existing user data."""
import gzip
import hashlib
import json
import sqlite3
import sys
import tempfile
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import config, db, work_assistant as work, companion_growth as growth
from app.account_context import use
from app.llm import client

FIXTURES = Path(__file__).parent/'fixtures'
# Compatible additive columns introduced after v4.1.1; legacy rows must receive safe defaults only.
ADDITIVE_MIGRATION_DEFAULTS = {
    'todos': {'completed_at': None, 'recurrence': '', 'recurrence_source_id': None},
    'emails': {'list_unsubscribe': '', 'is_automated': 0},
}


def snapshot(path, names=None):
    # A sqlite3 connection context commits/rolls back but does not close the
    # handle. Close snapshots explicitly so Windows can remove the old store.
    with closing(sqlite3.connect(path)) as c:
        if names is None:
            # Shadow/virtual tables are search indexes, not user records.
            names = [row[1] for row in c.execute('PRAGMA table_list')
                     if row[2] == 'table' and not row[1].startswith('sqlite_')]
            return {name: (c.execute(f'SELECT * FROM "{name}" LIMIT 0').description,
                           sorted(c.execute(f'SELECT * FROM "{name}"').fetchall(), key=repr)) for name in names}
        result = {}
        allowed = ADDITIVE_MIGRATION_DEFAULTS if path.name == 'mailai.db' else {}
        for name, (desc, _) in names.items():
            base_cols = [col[0] for col in desc]
            current_cols = [col[0] for col in c.execute(f'SELECT * FROM "{name}" LIMIT 0').description]
            extra_cols = [col for col in current_cols if col not in base_cols]
            expected_defaults = allowed.get(name, {})
            assert set(extra_cols).issubset(expected_defaults), f'{name}: unexpected columns {extra_cols}'
            if extra_cols:
                extra_expr = ', '.join(f'"{col}"' for col in extra_cols)
                for row in c.execute(f'SELECT {extra_expr} FROM "{name}"').fetchall():
                    assert row == tuple(expected_defaults[col] for col in extra_cols), (
                        f'{name}: additive column default changed on legacy row: {row}'
                    )
            select_expr = ', '.join(f'"{col}"' for col in base_cols)
            result[name] = (
                c.execute(f'SELECT {select_expr} FROM "{name}" LIMIT 0').description,
                sorted(c.execute(f'SELECT {select_expr} FROM "{name}"').fetchall(), key=repr),
            )
        return result


def main():
    metadata = json.loads((FIXTURES/'work-upgrade-4.1.1.json').read_text())
    assert metadata['version'] == '4.1.1' and metadata['synthetic']
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        for name in ('mailai.db', 'companion.sqlite3'):
            fixture = 'work-upgrade-4.1.1-' + name + '.gz'
            payload = gzip.decompress((FIXTURES/fixture).read_bytes())
            assert hashlib.sha256(payload).hexdigest() == metadata['uncompressed_sha256'][fixture]
            (root/name).write_bytes(payload)
        account = dict(ACCOUNT_ID='upgrade', DB_PATH=str(root/'mailai.db'),
                       RAW_DIR=str(root/'raw'), IMAP_USER='me@example.test')
        # Preserve raw files at the same relative paths stored by the old app.
        raw = root/'raw'
        raw.mkdir()
        for index in range(1, 4):
            (raw/f'legacy-{index}.eml').write_bytes(b'Subject: synthetic\r\n\r\noriginal MIME\x00\xff')
        raw_before = {file.name: file.read_bytes() for file in raw.iterdir()}
        mail_before = snapshot(root/'mailai.db')
        pet_before = snapshot(root/'companion.sqlite3')
        assert 'work_context' not in mail_before and 'work_preferences' not in mail_before
        now = datetime(2026, 11, 5, 10, tzinfo=timezone(timedelta(hours=8)))
        with patch.object(config, 'DATA_DIR', temporary), use(account), patch.object(growth, '_now', return_value=now), \
             patch.object(client, 'chat_completion', side_effect=AssertionError('Upgrade/read called a model')):
            for _ in range(2):
                db.init_db()
                work.overview(1)
                assert snapshot(root/'mailai.db', mail_before) == mail_before
                assert snapshot(root/'companion.sqlite3', pet_before) == pet_before
            assert work.preferences() == {'style': '结论在前', 'revision': 0}
            work.save_context(1, project='新事项背景', note='升级后保存', revision=0,
                              style='简洁自然', style_revision=0)
            assert snapshot(root/'mailai.db', mail_before) == mail_before
            assert snapshot(root/'companion.sqlite3', pet_before) == pet_before
            assert '升级后保存' in work.writing_context(1)
            # Existing completed tasks do not receive retroactive rewards.
            before = growth.snapshot()
            db.set_todo_status(2, 'done')
            assert growth.snapshot() == before
            assert (before['xp'], before['stamps'], before['earned']) == (1200, 321, 801)
            assert before['equipped']['head'] == 'cap' and before['equipped']['neck'] == 'scarf'
            db.set_todo_status(1, 'done')
            after = growth.snapshot()
            assert after['xp'] == before['xp'] + 27 and after['stamps'] == before['stamps'] + 14
            db.set_todo_status(1, 'open')
            db.set_todo_status(1, 'done')
            assert growth.snapshot() == after
            assert db.get_draft(1)['subject'] == '未发送草稿'
            assert db.get_sent_message(1)['status'] == 'sent'
            for draft in (False, True):
                assert db.get_sent_attachment(1, 0, draft=draft)['payload'] == b'synthetic attachment\x00\xff'
            with db.conn() as c:
                assert c.execute('SELECT status FROM outbox WHERE token=?', ('legacy-pending',)).fetchone()[0] == 'queued'
                assert c.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        assert {file.name: file.read_bytes() for file in raw.iterdir()} == raw_before
    print('PASS v4.1.1 upgrade: all existing table rows, raw files, attachments, drafts, outbox, contacts, tasks and companion receipts preserved')


if __name__ == '__main__':
    main()
