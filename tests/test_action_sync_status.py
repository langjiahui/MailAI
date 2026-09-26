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

# Pausing is not completion: preserve uncertain COPY identity and local hiding,
# exclude from work and active list, and restore the exact phase on resume.
from app.web.routes.mail_actions import api_pause_action_sync
from app.account_context import use
from app.trash_queue import mutation_lock
import threading
with tempfile.TemporaryDirectory() as root, patch.object(config,'DB_PATH',str(Path(root)/'mail.db')):
    db.init_db()
    for n,phase in enumerate(('trash','trash_copying','trash_copied','trash_locating'),10):
        eid=db.upsert_email({'uid':n,'folder':'INBOX','status':'inbox','subject':'pause','from_addr':'test@example.test'})
        db.queue_trash([eid],0)
        db.advance_trash_action([eid],action=phase,target='Trash',target_uids={eid:99})
        db.retry_trash_action([eid],'uncertain')
        assert api_pause_action_sync(eid)['paused']
        row=db.get_email(eid)
        assert row['remote_missing']==1 and row['pending_action']==phase and row['pending_target_uid']==99
        assert all(r['id']!=eid for r in db.due_trash_actions())
        assert all(r['id']!=eid for r in api_action_sync()['rows'])
        assert any(r['id']==eid and r['paused'] for r in api_action_sync(True)['rows'])
        assert api_retry_action_sync(eid)['scheduled']
        assert any(r['id']==eid and r['pending_action']==phase for r in db.due_trash_actions())
        api_pause_action_sync(eid)
    assert api_action_sync()['paused_count']==4
    # Accounts have independent queues.
    with use({'ACCOUNT_ID':'other','DB_PATH':str(Path(root)/'other.db')}):
        db.init_db(); assert api_action_sync(True)['total']==0
        try: api_pause_action_sync(eid)
        except HTTPException as error: assert error.status_code==409
        else: raise AssertionError('cross-account operation')
    held=threading.Event();release=threading.Event();lock=mutation_lock()
    def hold():
        with lock: held.set();release.wait(3)
    t=threading.Thread(target=hold);t.start();held.wait(3)
    try:
        try: api_retry_action_sync(eid)
        except HTTPException as error: assert error.status_code==409
        else: raise AssertionError('must not change an in-flight remote operation')
    finally: release.set();t.join()
print('PASS phase-preserving pause/resume, inactive queue, account isolation and in-flight lock')
