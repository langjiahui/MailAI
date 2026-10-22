"""Server-cleanup safety tests. No real mailbox connections or deletions."""
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, date
from email.message import EmailMessage
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import config, db, parser, server_cleanup, pipeline, system_settings, automatic_server_cleanup as automatic
from app.web import server


class FakeMail:
    def __init__(self, raw):
        self.raw = dict(raw)
        self.flags = {uid: [] for uid in raw}
        self.client = self
        self.uidvalidity = 12
        self.supported = True
        self.mutations = []
        self.raise_expunge = False
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def list_mailboxes(self): return [{'name':'INBOX','selectable':True}]
    def has_capability(self, name): return self.supported
    def select_folder(self, folder, readonly=True): return {b'UIDVALIDITY':self.uidvalidity}
    def fetch(self, uids, fields):
        return {uid:{b'RFC822.SIZE':len(self.raw[uid]), b'FLAGS':self.flags[uid],b'BODY[]':self.raw[uid]} for uid in uids if uid in self.raw}
    def add_flags(self,uids,flags,silent=True):
        self.mutations.append(('flags',list(uids)))
        for uid in uids: self.flags[uid]=[b'\\Deleted']
    def expunge(self,uids=None):
        assert uids, 'Mailbox-wide EXPUNGE is forbidden'
        self.mutations.append(('expunge',list(uids)))
        if self.raise_expunge: raise OSError('connection dropped')
        for uid in uids: self.raw.pop(uid,None)
    def search(self, criteria): return [int(criteria[1])] if int(criteria[1]) in self.raw else []


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        home=self.temp.name
        self.patch=patch.multiple(config,DATA_DIR=home,DB_PATH=home+'/mail.db',RAW_DIR=home+'/raw',IMAP_HOST='imap.example.test',IMAP_USER='me@example.test')
        self.patch.start(); self.addCleanup(self.patch.stop)
        Path(config.RAW_DIR).mkdir(); db.init_db()
        self.raw={}
        self.old=(datetime.now()-timedelta(days=60)).isoformat()
        for uid in range(1,6):
            msg=EmailMessage(); msg['Subject']=f'old {uid}';msg['Message-ID']=f'<{uid}@example.test>';msg['From']='person@example.test';msg['To']=config.IMAP_USER;msg.set_content('body preserved')
            msg.add_attachment(b'complete attachment',maintype='application',subtype='octet-stream',filename='report.txt')
            raw=msg.as_bytes(); self.raw[uid]=raw
            parsed=parser.parse_message(uid,raw,folder='INBOX')
            db.upsert_email({**parsed,'folder':'INBOX','date':self.old,'status':'inbox'})
        with db.conn() as c:
            c.execute('UPDATE emails SET is_favorite=1 WHERE id=2')
            c.execute('UPDATE emails SET date=? WHERE id=3',(date.today().isoformat(),))
        Path(db.get_email(4)['raw_path']).unlink()
        self.mail=FakeMail(self.raw)
        self.mail.flags[5]=[b'\\Flagged']
        self.remote_patch=patch.object(server_cleanup,'MailClient',return_value=self.mail)
        self.remote_patch.start(); self.addCleanup(self.remote_patch.stop)
        self.cutoff=(date.today()-timedelta(days=30)).isoformat()
    def preview(self,include=False): return server_cleanup.preview('INBOX',self.cutoff,include)
    def execute(self,token): return server.api_cleanup_execute(server.CleanupExecuteRequest(token=token,confirmation=config.IMAP_USER,acknowledge=True))
    def test_confirmed_cleanup_preserves_archive_and_other_server_mail(self):
        preview=self.preview(); self.assertEqual([r['id'] for r in preview['items']],[1]); self.assertFalse(self.mail.mutations)
        with self.assertRaises(ValueError): server_cleanup.execute(preview['token'],'wrong',True)
        with self.assertRaises(ValueError): server_cleanup.execute(preview['token'],config.IMAP_USER,False)
        self.assertFalse(self.mail.mutations)
        result=self.execute(preview['token']); self.assertEqual(result['status'],'completed'); self.assertEqual(result['completed'],1)
        self.assertEqual(set(self.mail.raw),{2,3,4,5})
        archive=db.get_email(result['items'][0]['local_id'])
        self.assertEqual(Path(archive['raw_path']).read_bytes(),self.raw[1])
        self.assertEqual(parser.extract_attachment(archive['raw_path'],0)['payload'],b'complete attachment')
        self.assertTrue(Path(system_settings.backup_path(result['backup'])).is_file())
        db.reconcile_folder('INBOX',[2,3,4,5]); self.assertEqual(db.get_email(archive['id'])['remote_missing'],0)
        self.assertEqual(len(db.list_emails(status='local_archive',days=9999)),0)
        self.assertEqual(archive['id'],1);self.assertEqual(archive['folder'],'INBOX');self.assertEqual(archive['status'],'inbox')
        self.assertIn(1,[item['id'] for item in db.list_emails(status='inbox',days=9999)])
        self.assertEqual(len(db.list_emails(days=9999)),5)
        db.set_remote_missing(1);self.assertEqual(db.get_email(1)['remote_missing'],0)
        db.queue_seen_sync([archive['id']],True); self.assertFalse(db.due_seen_sync_jobs())
        with self.assertRaises(Exception): server.api_move_email(archive['id'],'Trash')
        with self.assertRaises(ValueError): pipeline.record_feedback(archive['id'],'fn')
        count=len(self.mail.mutations); self.assertTrue(self.execute(preview['token'])['already_used']); self.assertEqual(len(self.mail.mutations),count)
    def test_allows_explicit_favorites_but_rejects_changed_identity(self):
        preview=self.preview(True); self.assertEqual({item['id'] for item in preview['items']},{1,2,5})
        self.mail.raw[1]=b'other message'
        result=self.execute(preview['token']); self.assertEqual(result['status'],'failed'); self.assertFalse(self.mail.mutations)
    def test_uidvalidity_and_expired_or_cross_account_preview(self):
        preview=self.preview(); self.mail.uidvalidity+=1
        self.assertEqual(self.execute(preview['token'])['status'],'failed'); self.assertFalse(self.mail.mutations)
        preview=self.preview()
        with db.conn() as c: c.execute("UPDATE server_cleanup_jobs SET expires_at='2000-01-01' WHERE token=?",(preview['token'],))
        with self.assertRaises(ValueError): server_cleanup.execute(preview['token'],config.IMAP_USER,True)
        preview=self.preview()
        with patch.object(config,'IMAP_USER','another@example.test'):
            with self.assertRaises(ValueError): server_cleanup.execute(preview['token'],config.IMAP_USER,True)
        self.assertFalse(self.mail.mutations)
    def test_no_uidplus_no_cleanup(self):
        self.mail.supported=False
        with self.assertRaises(ValueError): self.preview()
        self.assertFalse(self.mail.mutations)
    def test_backup_failure_prevents_any_remote_mutation(self):
        preview=self.preview()
        with patch.object(system_settings,'create_backup',side_effect=OSError('disk full')):
            result=self.execute(preview['token'])
        self.assertEqual(result['status'],'failed');self.assertFalse(self.mail.mutations)
    def test_disconnect_keeps_local_archive_and_never_replays(self):
        preview=self.preview();self.mail.raise_expunge=True
        result=self.execute(preview['token']); self.assertEqual(result['status'],'attention');self.assertEqual(result['preserved'],1)
        self.assertTrue(db.get_email(1)['cleanup_hold']); self.assertTrue(db.get_email(result['items'][0]['local_id'])['is_local_archive'])
        previous=len(self.mail.mutations); self.execute(preview['token']); self.assertEqual(len(self.mail.mutations),previous)
        self.assertNotIn(1,[item['id'] for item in self.preview()['items']])
    def test_reused_server_uid_does_not_overwrite_retained_mail(self):
        result=self.execute(self.preview()['token'])
        self.assertEqual(result['status'],'completed')
        before=db.get_email(1)
        self.assertGreater(db.get_first_uid('INBOX'),0)
        self.assertTrue(all(uid>0 for uid in db.folder_uids('INBOX')))
        new_id=db.upsert_email(dict(uid=1,folder='INBOX',message_id='<new>',subject='New mail',date=self.old,status='inbox'))
        self.assertNotEqual(new_id,1)
        self.assertEqual(db.get_email(1)['subject'],before['subject'])
        self.assertEqual(db.get_email(1)['raw_path'],before['raw_path'])
        db.reconcile_folder('INBOX',[1,2,3,4,5])
        self.assertFalse(db.get_email(1)['remote_missing'])
    def test_legacy_archive_merges_once_into_original_record(self):
        import json
        preview=self.preview()
        original=db.get_email(1)
        copied=dict(original);copied.pop('id');copied.update(uid=1,folder='__MAILAI_LOCAL__/old',status='local_archive')
        archive_id=db.upsert_email(copied)
        with db.conn() as c:
            c.execute('UPDATE emails SET is_local_archive=1,is_favorite=1 WHERE id=?',(archive_id,))
            c.execute("UPDATE emails SET remote_missing=1,cleanup_hold='legacy' WHERE id=1")
            c.execute("UPDATE server_cleanup_jobs SET status='completed',result=? WHERE token=?",(json.dumps({'items':[{'id':1,'archive_id':archive_id,'status':'deleted'}]}),preview['token']))
        db.init_db();db.init_db()
        restored=db.get_email(1)
        self.assertEqual(restored['folder'],'INBOX');self.assertEqual(restored['status'],'inbox')
        self.assertTrue(restored['is_favorite']);self.assertFalse(restored['remote_missing'])
        self.assertTrue(db.get_email(archive_id)['remote_missing'])
        self.assertEqual(len(db.list_emails(days=9999)),5)
        db.reconcile_folder('INBOX',[2,3,4,5]);self.assertFalse(db.get_email(1)['remote_missing'])
    def test_pagination_can_skip_ineligible_oldest_messages(self):
        with patch.object(server_cleanup, 'MAX_ITEMS', 1):
            first=self.preview(); self.assertTrue(first['more'])
            second=server_cleanup.preview('INBOX',self.cutoff,True,offset=1)
            self.assertEqual([item['id'] for item in second['items']],[2])
            self.assertEqual(second['offset'],1)
        self.assertFalse(self.mail.mutations)
    def test_new_local_content_cannot_be_deleted_with_old_preview(self):
        preview=self.preview()
        Path(db.get_email(1)['raw_path']).write_bytes(b'replaced local original')
        result=self.execute(preview['token'])
        self.assertEqual(result['status'],'failed'); self.assertFalse(self.mail.mutations)
    def test_unrelated_already_deleted_uid_is_not_expunged(self):
        self.mail.flags[3]=[b'\\Deleted']
        result=self.execute(self.preview()['token'])
        self.assertEqual(result['status'],'completed'); self.assertIn(3,self.mail.raw)
        self.assertEqual(self.mail.mutations,[('flags',[1]),('expunge',[1])])
    def test_no_cutoff_today_and_favorite_change_after_preview(self):
        with self.assertRaises(ValueError): server_cleanup.preview('INBOX',date.today().isoformat())
        preview=self.preview();server.api_set_email_favorite(1,True)
        self.assertEqual(self.execute(preview['token'])['status'],'failed'); self.assertFalse(self.mail.mutations)

    def enable_automatic(self, **values):
        return automatic.save_settings(True, days=30, confirmation=config.IMAP_USER,
                                       acknowledge=True, **values)

    def make_automatic_due(self):
        policy=automatic.get_settings()
        policy['next_run']=(datetime.now()-timedelta(days=1)).isoformat()
        automatic._save(policy)

    def test_automatic_default_off_and_validated_opt_in(self):
        self.assertFalse(automatic.get_settings()['enabled'])
        with patch.object(server_cleanup,'MailClient') as client:
            automatic._run_account();client.assert_not_called()
        for values in ({'confirmation':config.IMAP_USER}, {'acknowledge':True,'confirmation':'wrong'},
                       {'acknowledge':True,'confirmation':config.IMAP_USER,'days':0},
                       {'acknowledge':True,'confirmation':config.IMAP_USER,'interval_days':2},
                       {'acknowledge':True,'confirmation':config.IMAP_USER,'folder':'missing'}):
            with self.assertRaises(ValueError): automatic.save_settings(True,**values)
        self.mail.supported=False
        with self.assertRaises(ValueError): self.enable_automatic()
        self.assertFalse(automatic.get_settings()['enabled']);self.assertFalse(self.mail.mutations)

    def test_automatic_due_runs_once_and_preserves_complete_local_mail(self):
        self.enable_automatic()
        automatic._run_account();self.assertFalse(self.mail.mutations)
        self.make_automatic_due();automatic._run_account()
        policy=automatic.get_settings()
        self.assertEqual(policy['status'],'scheduled')
        self.assertGreater(datetime.fromisoformat(policy['next_run']),datetime.now())
        self.assertEqual(self.mail.mutations,[('flags',[1]),('expunge',[1])])
        row=db.get_email(1)
        self.assertEqual(row['folder'],'INBOX');self.assertEqual(row['status'],'inbox')
        self.assertEqual(Path(row['raw_path']).read_bytes(),self.raw[1])
        self.assertTrue(parser.extract_attachment(row['raw_path'],0)['payload'])
        record=server_cleanup.history()[0]
        self.assertEqual(record['source'],'automatic');self.assertEqual(record['status'],'completed')
        self.assertTrue(Path(system_settings.backup_path(record['backup'])).is_file())
        automatic._run_account();self.assertEqual(len(self.mail.mutations),2)
        self.assertEqual(set(self.mail.raw),{2,3,4,5})

    def test_automatic_weekly_disable_does_not_contact_server(self):
        policy=self.enable_automatic(interval_days=7)
        self.assertGreater(datetime.fromisoformat(policy['next_run']),datetime.now()+timedelta(days=6))
        self.make_automatic_due()
        with patch.object(server_cleanup,'MailClient') as client:
            automatic.save_settings(False)
            automatic._run_account();client.assert_not_called()
        self.assertEqual(automatic.get_settings()['status'],'disabled')

    def test_automatic_backup_failure_pauses_without_deletion_or_retry(self):
        self.enable_automatic();self.make_automatic_due()
        with patch.object(system_settings,'create_backup',side_effect=OSError('disk full')):
            automatic._run_account()
        self.assertEqual(automatic.get_settings()['status'],'paused')
        self.assertIn('disk full',automatic.get_settings()['last_error']);self.assertFalse(self.mail.mutations)
        with patch.object(server_cleanup,'MailClient') as client:
            automatic._run_account();client.assert_not_called()

    def test_automatic_preview_disconnect_pauses_instead_of_skipping_every_message(self):
        self.enable_automatic();self.make_automatic_due()
        with patch.object(self.mail,'fetch',side_effect=OSError('preview connection dropped')):
            automatic._run_account()
        self.assertEqual(automatic.get_settings()['status'],'paused')
        self.assertIn('preview connection dropped',automatic.get_settings()['last_error'])
        self.assertFalse(self.mail.mutations)

    def test_automatic_disconnect_and_restart_do_not_replay(self):
        self.enable_automatic();self.make_automatic_due();self.mail.raise_expunge=True
        automatic._run_account()
        self.assertEqual(automatic.get_settings()['status'],'paused')
        self.assertEqual(server_cleanup.history()[0]['status'],'attention')
        count=len(self.mail.mutations)
        automatic._run_account();self.assertEqual(len(self.mail.mutations),count)
        self.mail.raise_expunge=False
        self.enable_automatic();self.make_automatic_due();automatic._run_account()
        self.assertEqual(len(self.mail.mutations),count)  # Uncertain UID remains held.
        policy=automatic.get_settings();policy['status']='running';automatic._save(policy)
        with patch.object(server_cleanup,'MailClient') as client:
            automatic._run_account();client.assert_not_called()
        self.assertEqual(automatic.get_settings()['status'],'paused')

    def test_automatic_preview_requires_current_rule_and_cannot_execute_manually(self):
        policy=self.enable_automatic();policy['status']='running';automatic._save(policy)
        plan=server_cleanup.preview('INBOX',self.cutoff,automation_id=policy['revision'])
        with self.assertRaises(ValueError): server_cleanup.execute(plan['token'],config.IMAP_USER,True)
        automatic.save_settings(False)
        with self.assertRaises(ValueError): server_cleanup._execute(plan['token'],automatic=True)
        with self.assertRaises(ValueError): server_cleanup._execute(self.preview()['token'],automatic=True)
        self.assertFalse(self.mail.mutations)

    def test_automatic_scan_passes_protected_or_missing_mail(self):
        with db.conn() as c:
            c.execute('UPDATE emails SET is_favorite=1 WHERE id=1')
        msg=EmailMessage();msg['Subject']='eligible after protected mail';msg.set_content('retained')
        raw=msg.as_bytes();self.mail.raw[6]=raw;self.mail.flags[6]=[]
        db.upsert_email({**parser.parse_message(6,raw,folder='INBOX'),'date':self.old,'folder':'INBOX','status':'inbox'})
        self.enable_automatic();self.make_automatic_due()
        with patch.object(server_cleanup,'MAX_ITEMS',1): automatic._run_account()
        self.assertEqual(self.mail.mutations,[('flags',[6]),('expunge',[6])])
        self.assertEqual(automatic.get_settings()['status'],'scheduled')

    def test_automatic_scheduler_account_isolation_and_busy_guard(self):
        from app.account_context import use
        from app.account_guard import guard
        self.enable_automatic();self.make_automatic_due()
        other_path=self.temp.name+'/other.db'
        with use(dict(ACCOUNT_ID='other',DB_PATH=other_path)):
            db.init_db();self.assertFalse(automatic.get_settings()['enabled'])
        accounts={'first':dict(db_path=config.DB_PATH),'other':dict(db_path=other_path)}
        values=dict(ACCOUNT_ID='first',DB_PATH=config.DB_PATH,RAW_DIR=config.RAW_DIR,
                    IMAP_HOST=config.IMAP_HOST,IMAP_USER=config.IMAP_USER)
        with patch.object(system_settings,'_load_registry',return_value={'accounts':accounts}), patch.object(automatic,'snapshot',return_value=values) as snap:
            self.assertTrue(guard.acquire())
            try: automatic.run_due()
            finally: guard.release()
            snap.assert_not_called();self.assertFalse(self.mail.mutations)
            automatic.run_due();snap.assert_called_once_with('first')
        self.assertEqual(self.mail.mutations,[('flags',[1]),('expunge',[1])])
        with use(dict(ACCOUNT_ID='other',DB_PATH=other_path)):
            self.assertFalse(automatic.get_settings()['enabled']);self.assertEqual(server_cleanup.history(),[])

if __name__=='__main__': unittest.main()
