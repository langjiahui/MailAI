"""Synthetic IMAP recovery: bounded writes, exact identity and no server mutations."""
import sys
from pathlib import Path
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import config, db, mail_recovery as recovery
from app.imap_client import BODY_CHUNK_BYTES
from test_mail_import import fixture, message, raises


def main():
    with fixture() as (root, account), account('work'):
        db.observe_uid_validity('INBOX', 7)
        raw=message('recovered', attachment=True)
        db.defer_mail_fetch('INBOX', 91, 'oversized', size=51*1024**2)
        mail=Mock();mail._uid_validity.return_value=7
        mail.client.select_folder.return_value={b'UIDVALIDITY':7}
        def fetch(uids, fields):
            assert uids == [91]
            if fields == ['RFC822.SIZE','FLAGS']:
                return {91:{b'RFC822.SIZE':len(raw), b'FLAGS':()}}
            if fields == ['RFC822.SIZE','BODY.PEEK[HEADER]<0.32768>']:
                return {91:{b'RFC822.SIZE':len(raw),b'BODY[HEADER]<0>':raw.split(b'\r\n\r\n')[0]}}
            assert fields[0].startswith('BODY.PEEK[]<')
            offset,length=map(int, fields[0].split('<')[1].rstrip('>').split('.'))
            assert length <= BODY_CHUNK_BYTES
            return {91:{f'BODY[]<{offset}>'.encode():raw[offset:offset+length]}}
        mail.client.fetch.side_effect=fetch
        mail.list_mailboxes.return_value=[{'name':'INBOX','flags':[]}]
        manager=Mock();manager.__enter__=Mock(return_value=mail);manager.__exit__=Mock(return_value=False)
        with patch.object(recovery,'MailClient',return_value=manager):
            detail=recovery.inspect('INBOX',91)
            assert detail['subject']=='历史项目资料' and detail['size']==len(raw)
            with patch.object(recovery,'start_account_thread',side_effect=lambda work,**kwargs:work()):
                assert recovery.start('INBOX',91)['ok']
            overview=recovery.overview()
            assert not overview['task']['running'] and not overview['task']['error'],overview
            assert overview['total']==0
            row=db.get_email(overview['task']['email_id'])
            assert Path(row['raw_path']).read_bytes()==raw
            assert row['uid']==91 and row['folder']=='INBOX' and row['arrival_kind']=='history'
            assert row['is_read']==0 and row['notification_sent']==1
            assert row['verdict']=='unreviewed' and row['review_source']=='manual_download'
            assert db.get_last_uid('INBOX')==0, 'Recovery must not advance or rewind the automatic cursor'
            for method in ('move','copy','delete_messages','add_flags','set_flags','expunge'):
                getattr(mail.client,method).assert_not_called()
            with account('personal'):
                raises(recovery.inspect,'INBOX',91)
            # Multi-chunk bodies stream to disk with exact bytes and visible progress.
            body=b'x'*(BODY_CHUNK_BYTES*2+123)
            progress=[]
            def large_fetch(uids,fields):
                if fields==['RFC822.SIZE','FLAGS']:return {91:{b'RFC822.SIZE':len(body)}}
                offset,length=map(int,fields[0].split('<')[1].rstrip('>').split('.'))
                assert length<=BODY_CHUNK_BYTES
                return {91:{f'BODY[]<{offset}>'.encode():body[offset:offset+length]}}
            with patch.object(mail.client,'fetch',side_effect=large_fetch):
                recovery.download(mail, {'folder':'INBOX','uid':91,'uid_validity':7},root/'chunks.eml',lambda n,size:progress.append((n,size)))
            assert (root/'chunks.eml').read_bytes()==body and len(progress)==3
            assert progress[-1]==(len(body),len(body))
            # Failed downloads retain the issue and delete their incomplete raw file.
            db.defer_mail_fetch('INBOX',91,'timeout')
            mail.client.fetch.side_effect=TimeoutError('synthetic failure')
            with patch.object(recovery,'start_account_thread',side_effect=lambda work,**kwargs:work()):
                recovery.start('INBOX',91)
            assert recovery.overview()['total']==1 and recovery.overview()['task']['error']
            assert len(list(Path(config.RAW_DIR).glob('recovered-*.eml')))==1
            # A reused UID cannot be downloaded from a different generation.
            mail._uid_validity.return_value=8
            raises(recovery.inspect,'INBOX',91)
            # Unknown sizes and over-limit sizes fail before body allocation.
            mail._uid_validity.return_value=7
            for size in (0,257*1024**2):
                mail.client.fetch.side_effect=lambda *args, **kwargs:{91:{b'RFC822.SIZE':size}}
                raises(recovery.download,mail,recovery._entry('INBOX',91),root/'never.eml',lambda *_:None)
                assert not (root/'never.eml').exists()
            # A server ignoring the partial request cannot force an oversized write.
            mail.client.fetch.side_effect=lambda uids, fields:{91:{b'RFC822.SIZE':1}} if fields[0]=='RFC822.SIZE' else {91:{b'BODY[]<0>':b'too long'}}
            raises(recovery.download,mail,recovery._entry('INBOX',91),root/'partial.eml',lambda *_:None)
            assert (root/'partial.eml').stat().st_size==0
        # Cancellation interrupts before writing the next chunk and keeps retry identity.
        with patch.object(recovery.pipeline, '_is_canceled', return_value=True):
            mail.client.fetch.side_effect=lambda *args, **kwargs:{91:{b'RFC822.SIZE':10}}
            raises(recovery.download,mail,recovery._entry('INBOX',91),root/'cancel.eml',lambda *_:None)
        assert db.mail_fetch_retry_summary('INBOX')['count']==1
        raises(recovery.start,'INBOX',999)
    print('Single-message recovery: PEEK headers, streaming, UIDVALIDITY, account isolation, no server writes, failure retention and original bytes passed')

if __name__=='__main__':main()
