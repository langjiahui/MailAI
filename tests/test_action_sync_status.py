"""Retry schedules the stored delete phase, never repeats confirmed COPY work."""
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from fastapi import HTTPException
from app import config, db
from app.web.routes.mail_actions import api_action_sync, api_retry_action_sync
with tempfile.TemporaryDirectory() as root, patch.object(config,'DB_PATH',str(Path(root)/'mail.db')):
    db.init_db()
    email_id=db.upsert_email({'uid':1,'folder':'INBOX','status':'inbox','subject':'test','from_addr':'test@example.test'})
    db.queue_trash([email_id])
    assert api_action_sync()['total']==1
    try: api_retry_action_sync(email_id)
    except HTTPException as error: assert error.status_code==409
    else: raise AssertionError('premature retry bypasses undo window')
    db.advance_trash_action([email_id],action='trash_copied',target='Trash',target_uids={email_id:17})
    db.retry_trash_action([email_id],'offline')
    assert api_retry_action_sync(email_id)['scheduled']
    row=db.get_email(email_id)
    assert row['pending_action']=='trash_copied' and row['pending_target_uid']==17
    assert row['pending_due_at']=='' and row['pending_error']=='offline'
    db.finish_trash_action(email_id,'Trash',17)
    assert api_action_sync()['total']==0
print('Action synchronization status and phase-preserving retry passed')
