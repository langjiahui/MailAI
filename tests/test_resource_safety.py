"""Offline resource limits and background-worker recovery."""
import io
import json
import sys
import tempfile
import threading
from pathlib import Path
from datetime import datetime
from unittest.mock import patch, Mock
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import db, config, mailbox_jobs, outbox
from app.account_context import use
from app.llm import client
from app.imap_client import RawMessageBatch, MailClient


def main():
    imap=Mock()
    current=['INBOX']
    imap.select_folder.side_effect=lambda folder,**kwargs:current.__setitem__(0,folder)
    def fetch(uids, fields):
        assert current[0]=='INBOX'
        assert len(uids)==1, 'Body downloads must be bounded to one message'
        return {uids[0]:{b'BODY[]':b'fixture',b'FLAGS':[]}}
    imap.fetch.side_effect=fetch
    batch=RawMessageBatch(imap,'INBOX',range(1000))
    assert len(batch)==1000
    imap.fetch.assert_not_called()
    for uid,raw in batch:
        current[0]='Quarantine'  # Previous processing changed selected folder.
    assert imap.fetch.call_count==1000
    assert [uid for uid,raw in RawMessageBatch(imap,'INBOX',[1,2,3]).newest_first()]==[3,2,1]
    mail=MailClient.__new__(MailClient)
    mail.client=imap
    imap.search.return_value=list(range(101))
    for uid,raw,flags in mail.fetch_folder('INBOX'):
        current[0]='Quarantine'
    with tempfile.TemporaryDirectory() as root, use(dict(DB_PATH=str(Path(root)/'test.db'), ACCOUNT_ID='test')):
        db.init_db()
        old = db.upsert_email(dict(uid=1, date=datetime.now().isoformat(), body_text='x'*1000000))
        new = db.upsert_email(dict(uid=2, date=datetime.now().isoformat(), body_text='x'*1000000, verdict='phishing'))
        stale = db.upsert_email(dict(uid=3, date='2020-01-01', body_text='x'*1000000))
        rows = list(db.notification_candidates(old))
        assert [row['id'] for row in rows] == [new]
        assert 'body_text' not in rows[0]
        assert 'body_text' not in db.list_emails(days=9999, metadata_only=True)[0]
        lightweight = db.list_emails(days=9999, list_view=True)[0]
        assert 'body_text' not in lightweight and 'body_html' not in lightweight and 'raw_path' not in lightweight
        assert [row['id'] for row in db.iter_emails(batch_size=1)] == [old,new,stale]
        for n in range(25):
            outbox.enqueue(str(n), {'subject':'fixture'}, delay=-1)
        send=Mock(return_value={})
        outbox.process(send)
        assert send.call_count == 10
        outbox.process(send);outbox.process(send)
        assert send.call_count == 25

    initialized={'removed':'old'}
    retries={'removed':(1,99)}
    registry={'accounts':{'broken':{}, 'healthy':{}}}
    def snapshot(account):
        if account=='broken':raise ValueError('fixture disconnected')
        return dict(ACCOUNT_ID=account,DB_PATH='fixture.db')
    with patch.object(mailbox_jobs.system_settings,'_load_registry',return_value=registry), \
         patch.object(mailbox_jobs,'snapshot',side_effect=snapshot) as snapshots, \
         patch.object(db,'init_db'), patch.object(outbox,'process') as process, \
         patch('logging.Logger.exception'):
        for now in range(100):mailbox_jobs._check_outboxes(initialized,retries,now,lambda payload:None)
        assert process.call_count==100,'Broken account must not starve healthy account'
        assert sum(call.args[0]=='broken' for call in snapshots.call_args_list)==5
        assert 'removed' not in initialized and 'removed' not in retries

    ready=threading.Event()
    with patch.object(mailbox_jobs,'_check_outboxes',side_effect=lambda *args:ready.set()):
        starters=[threading.Thread(target=mailbox_jobs.start_outbox) for _ in range(20)]
        for thread in starters:thread.start()
        for thread in starters:thread.join(timeout=5)
        assert ready.wait(5)
        assert sum(thread.name=='outbox' for thread in threading.enumerate())==1
        assert mailbox_jobs.stop_outbox(timeout=5)
        assert not mailbox_jobs._outbox_started

    # Enforce bounds on newline-free data and perpetually streaming providers.
    try:
        list(client._response_lines(io.BytesIO(b'x'*(client.MAX_STREAM_LINE_BYTES+1)),float('inf')))
        raise AssertionError('Unbounded SSE line accepted')
    except RuntimeError:pass
    try:
        list(client._response_chunks(io.BytesIO(b'x'*(client.MAX_RESPONSE_BYTES+1)),float('inf')))
        raise AssertionError('Unbounded model response accepted')
    except RuntimeError:pass
    with patch.object(client.time,'monotonic',return_value=100):
        try:
            list(client._response_chunks(io.BytesIO(b'x'),99))
            raise AssertionError('Expired response accepted')
        except RuntimeError:pass
    response=io.BytesIO((b'data: '+json.dumps({'choices':[{'delta':{'content':'x'*1000}}]}).encode()+b'\n')*110)
    with patch.object(client,'available',return_value=True), patch.object(client.urllib.request,'urlopen',return_value=response):
        try:
            list(client.chat_completion_stream([],require_completion=True))
            raise AssertionError('Endless generated text accepted')
        except RuntimeError:pass
    assert response.closed
    print('Resource guards: metadata-only reads, bounded outbox batches, recovery/backoff, model byte/time limits passed')


if __name__=='__main__':main()
