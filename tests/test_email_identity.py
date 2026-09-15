"""Updating an email must preserve its id, user state and dependent source links."""
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import config, db


def main():
    with tempfile.TemporaryDirectory() as root, patch.object(config, 'DB_PATH', os.path.join(root, 'mail.db')):
        db.init_db()
        original = {'uid': 9, 'folder': 'INBOX', 'subject': 'Original', 'summary': 'Keep summary',
                    'attachments': [{'filename': 'keep.txt'}], 'created_at': '2026-01-01T00:00:00'}
        email_id = db.upsert_email(original)
        db.set_mail_state(email_id, is_read=True, is_starred=True)
        db.add_todos(email_id, [{'title': 'Keep linked task'}])
        draft = db.save_draft({'reply_to_email_id': email_id, 'subject': 'Reply'})
        assert db.upsert_email({'uid': 9, 'subject': 'Updated'}) == email_id
        row = db.get_email(email_id)
        assert row['subject'] == 'Updated' and row['summary'] == 'Keep summary'
        assert row['attachments'] == original['attachments']
        assert row['is_read'] and row['is_starred']
        assert row['created_at'] == original['created_at']
        assert db.list_todos()[0]['email_id'] == email_id
        assert db.get_draft(draft)['reply_to_email_id'] == email_id
        assert db.upsert_email({'uid': 9}) == email_id
        assert db.upsert_email({'uid': 9, 'attachments': []}) == email_id
        assert db.get_email(email_id)['attachments'] == []
        assert db.upsert_email({'uid': 9, 'folder': 'Archive'}) != email_id
    print('Stable email id, partial updates, user state and source relationships passed')


if __name__ == '__main__':
    main()
