"""Pinyin aliases work locally for mail, contacts, unified inbox and upgrades."""
import sqlite3
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import config, db, system_settings


def main():
    with tempfile.TemporaryDirectory() as directory, patch.multiple(
        config, DATA_DIR=directory, DB_PATH=str(Path(directory) / 'mail.db'),
        RAW_DIR=str(Path(directory) / 'raw'), IMAP_USER='me@example.test'
    ):
        Path(config.RAW_DIR).mkdir()
        db.init_db()
        db.upsert_email({
            'uid': 1, 'folder': 'INBOX', 'status': 'inbox', 'date': '2026-09-10T09:00:00',
            'subject': '项目周报', 'from_name': '张展生', 'from_addr': 'sender@example.test',
            'body_text': '正文仍按原文检索',
        })
        for query in ('张展', 'zzs', 'zhangzhansheng', 'xmzb', 'xiangmuzhoubao'):
            assert [row['uid'] for row in db.search_emails([query])] == [1], query

        db.save_contact('person@example.test', '张展生', '宝信软件')
        for query in ('zzs', 'zhangzhansheng', 'bxrj', 'baoxinruanjian'):
            assert any(row['email'] == 'person@example.test' for row in db.search_contacts(query)), query

        registry = {'accounts': {'test': {
            'db_path': config.DB_PATH, 'user': config.IMAP_USER, 'visible': True,
        }}}
        with patch.object(system_settings, '_load_registry', return_value=registry):
            assert system_settings.list_unified_inbox(q='zzs')[0]['uid'] == 1

        # An existing literal-only index is rebuilt in place on upgrade.
        with db.conn() as connection:
            connection.execute('DROP TRIGGER IF EXISTS email_search_insert')
            connection.execute('DROP TRIGGER IF EXISTS email_search_delete')
            connection.execute('DROP TRIGGER IF EXISTS email_search_update')
            connection.execute('DROP TABLE IF EXISTS email_search')
            connection.execute('DROP VIEW IF EXISTS email_search_content')
            connection.execute("CREATE VIEW email_search_content AS SELECT id,lower(coalesce(subject,'')) AS text FROM emails")
            try:
                connection.execute("CREATE VIRTUAL TABLE email_search USING fts5(text, content='email_search_content', content_rowid='id', tokenize='trigram')")
                connection.execute("INSERT INTO email_search(email_search) VALUES('rebuild')")
            except sqlite3.OperationalError:
                pass
        db.init_db()
        with db.conn() as connection:
            view = connection.execute("SELECT sql FROM sqlite_master WHERE name='email_search_content'").fetchone()
            assert view and 'mailai_pinyin' in view[0]
        assert db.search_emails(['zzs'])[0]['uid'] == 1

    print('PASS local full-pinyin/initial search and existing-index migration')


if __name__ == '__main__':
    main()
