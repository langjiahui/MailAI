"""Attachment search must reach older indexed mail, past the former 2000-mail cap."""
import json
import tempfile
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import db
from app.db import emails


def test_old_attachment_is_searchable_and_pages_are_stable():
    with tempfile.TemporaryDirectory() as directory, patch('app.config.DB_PATH', str(Path(directory) / 'mail.db')):
        db.init_db()
        with db.conn() as connection:
            connection.executemany(
                "INSERT INTO emails(uid,folder,subject,from_addr,date,attachments,created_at) VALUES(?,'INBOX',?,?,?,?,?)",
                [(uid, 'Old contract' if uid == 1 else f'Mail {uid}', 'sender@example.test',
                  f'2026-01-{(uid % 28) + 1:02d}',
                  json.dumps([{'name': 'contract.pdf' if uid == 1 else f'file-{uid}.txt'}]),
                  '2026-01-01') for uid in range(1, 2003)],
            )
        found = emails.list_attachments(limit=10, query='contract.pdf')
        assert len(found) == 1 and found[0]['name'] == 'contract.pdf'
        assert emails.list_attachments(limit=10, query='contract.pdf', kind='pdf') == found
        assert emails.list_attachments(limit=10, query='contract.pdf', kind='document') == []
        first = emails.list_attachments(limit=2)
        second = emails.list_attachments(limit=2, offset=2)
        assert len(first) == len(second) == 2
        assert {item['email_id'] for item in first}.isdisjoint(item['email_id'] for item in second)


if __name__ == '__main__':
    test_old_attachment_is_searchable_and_pages_are_stable()
