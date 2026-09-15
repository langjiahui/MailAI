"""A saved reply must retain headers and attachment payloads after reopening."""
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import config, db
from app.web.server import DraftRequest


def main():
    with tempfile.TemporaryDirectory() as root, patch.object(config, 'DB_PATH', os.path.join(root, 'mail.db')):
        db.init_db()
        payload = DraftRequest(to_addr='person@example.com', mode='reply_all',
                               in_reply_to='<parent@example.com>', references='<root@example.com> <parent@example.com>',
                               attachments=[{'filename': 'example.txt', 'data_base64': 'SGVsbG8='}])
        draft_id = db.save_draft(payload.model_dump())
        for row in (db.get_draft(draft_id),):
            assert row['in_reply_to'] == payload.in_reply_to
            assert row['references'] == payload.references
            assert row['attachments'] == payload.attachments
        listed = db.list_drafts()[0]
        assert listed['in_reply_to'] == payload.in_reply_to
        assert listed['references'] == payload.references
        assert listed['attachments'] == [{'filename': 'example.txt'}]
        assert 'attachments_json' not in listed
        payload.subject = 'Updated subject'
        assert db.save_draft(payload.model_dump(), draft_id) == draft_id
        assert len(db.list_drafts()) == 1
        assert db.get_draft(draft_id)['references'] == payload.references
        db.init_db()  # Migration remains idempotent.
    print('Reply draft thread headers, update identity and attachment persistence passed')


if __name__ == '__main__':
    main()
