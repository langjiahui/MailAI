"""Large local mailboxes: bounded I/O, complete filters, stable paging and recovery."""
from contextlib import contextmanager
from datetime import datetime,timedelta
import json
from pathlib import Path
import sys
import tempfile
import time
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app import db,mail_identities,mail_list,parser,system_settings
from app.account_context import use
from app.db import contacts


@contextmanager
def fixture():
    with tempfile.TemporaryDirectory(prefix='mailai-list-') as root:
        values=dict(ACCOUNT_ID='list-fixture',DB_PATH=str(Path(root)/'mail.db'),RAW_DIR=root,IMAP_USER='me@example.test')
        with use(values),patch.object(mail_identities,'schedule'):
            db.init_db();yield Path(root),values


def seed(count,start=0):
    with db.conn() as c:
        c.executemany('''INSERT INTO emails(uid,from_addr,from_name,to_addr,subject,date,status,category,priority,raw_path,recipient_names,is_read,score)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)''',[
            (n+1,'sender@example.test','Known Sender','me@example.test',f'Message {n:06d}',
             (datetime(2025,1,1)+timedelta(seconds=n)).isoformat(),'inbox','Old project' if n==0 else 'Bulk','高' if n==0 else '中',
             '/synthetic-only/missing.eml','{}',int(n%2==0),n%100) for n in range(start,start+count)])


def test_large_mailbox():
    with fixture() as (root,values):
        timings=[];count=0
        with patch.object(parser,'recipient_names_from_raw_path',side_effect=AssertionError('List read an original')),patch.object(parser,'sender_name_from_raw_path',side_effect=AssertionError('List read an original')):
            for size in (6698,10000,50000,100000):
                seed(size-count,count);count=size
                started=time.monotonic();result=mail_list.page({'status':'inbox'})
                timings.append({'messages':size,'first_page_seconds':round(time.monotonic()-started,4),'rows':len(result['items'])})
                assert result['total']==size and len(result['items'])==200 and result['next']
                assert result['items'][0]['uid']==size
                assert not any('body_text' in row or 'body_html' in row for row in result['items'])
                assert '/synthetic-only/' not in json.dumps(result), 'List exposed original storage paths'
                # Changing read state must not invalidate the expensive address map.
                before=len(contacts._recipient_header_name_cache)
                db.set_mail_state(result['items'][0]['id'],is_read=True)
                again=mail_list.page({'status':'inbox'})
                assert len(contacts._recipient_header_name_cache)==before
                assert again['total']==size
            with db.conn() as c:
                c.execute("INSERT INTO mail_tags(name) VALUES('Old label')")
                c.execute("INSERT INTO email_tags(email_id,tag_id) SELECT id,1 FROM emails WHERE uid=1")
            old=mail_list.page({'status':'inbox','tags':['Old label']})
            assert old['total']==1 and old['items'][0]['uid']==1, 'Server filtering missed mail outside the first page'
            assert mail_list.page({'category':'Old project'})['total']==1
            unread=mail_list.page({'unread':True});assert unread['total']==49996
            assert all(not row['is_read'] for row in unread['items'])
            assert result['facets']['categories']=={'Bulk':99999,'Old project':1}
            assert old['facets']['tags']['Old label']==1
            assert mail_list.page({'status':'inbox'},around_id=1)['items'][0]['uid']==1
            first=mail_list.page({'status':'inbox'},limit=200)
            second=mail_list.page({'status':'inbox'},limit=200,cursor=first['next'])
            assert not ({r['id'] for r in first['items']} & {r['id'] for r in second['items']})
            db.upsert_email({'uid':200000,'from_addr':'new@example.test','date':'2030-01-01','subject':'New','status':'inbox'})
            try:mail_list.page({'status':'inbox'},cursor=first['next'])
            except mail_list.StalePage:pass
            else:raise AssertionError('Mixed stale page versions')
            refreshed=mail_list.page({'status':'inbox'},cursor=first['next'],refresh=True)
            assert refreshed['items'][0]['id']==second['items'][0]['id'], 'Refreshing older pages jumped to the newest mail'
            assert refreshed['total']==100001
            try:mail_list.page({'status':'trash'},cursor=first['next'])
            except ValueError:pass
            else:raise AssertionError('Cursor reused across a different filter')
        print(json.dumps(timings))


def test_complete_pagination_and_conversations():
    with fixture():
        seed(6698)
        for order in ('date-desc','date-asc','score-desc'):
            cursor='';seen=[]
            while True:
                result=mail_list.page({'sort':order},cursor=cursor)
                seen.extend(row['id'] for row in result['items']);cursor=result['next']
                if not cursor:break
            assert len(seen)==len(set(seen))==6698
        with db.conn() as c:c.execute("UPDATE emails SET thread_id='shared' WHERE uid<=500")
        groups=mail_list.page({'conversations':True,'sort':'date-asc'})
        assert groups['items'][0]['_conversationCount']==500 and groups['total']==6698
        # Frozen ordering uses actual instants, including legacy local dates.
        db.upsert_email({'uid':9000,'date':'2030-01-01T12:00:00+08:00','subject':'timezone'})
        db.upsert_email({'uid':9001,'date':'2030-01-01T04:00:00Z','subject':'timezone'})
        dates=mail_list.page({})['items'][:2];assert [r['uid'] for r in dates]==[9001,9000]
        with db.conn() as c:
            plan=' '.join(str(tuple(row)) for row in c.execute('EXPLAIN QUERY PLAN SELECT id FROM emails WHERE status=? AND remote_missing=0 ORDER BY list_date DESC,id DESC LIMIT 201',('inbox',)))
        assert 'idx_mail_list_status_date' in plan


def test_legacy_identity_recovery():
    with fixture() as (root,values):
        original=root/'legacy.eml'
        raw='From: 发送人 <sender@example.test>\r\nTo: 收件人 <recipient@example.test>\r\n\r\nbody'.encode()
        original.write_bytes(raw)
        email_id=db.upsert_email({'uid':1,'from_addr':'sender@example.test','from_name':'损坏�','to_addr':'recipient@example.test','raw_path':str(original)})
        contacts._recipient_header_name_cache.clear()
        with patch.object(parser,'recipient_names_from_raw_path',side_effect=AssertionError('Foreground raw I/O')):
            assert mail_list.page({})['total']==1
        mail_identities.repair()
        with patch.object(parser,'recipient_names_from_raw_path',side_effect=AssertionError('Reparsed recovered names')),patch.object(parser,'sender_name_from_raw_path',side_effect=AssertionError('Reparsed sender')):
            assert db.contact_display_names(['sender@example.test'],allow_raw=False)['sender@example.test']['name']=='发送人'
            assert db.contact_display_names(['recipient@example.test'],allow_raw=False)['recipient@example.test']['name']=='收件人'
            with db.conn() as c:revision=c.execute('SELECT value FROM mail_identity_revision').fetchone()[0]
            db.set_mail_state(email_id,is_read=True)
            with db.conn() as c:assert c.execute('SELECT value FROM mail_identity_revision').fetchone()[0]==revision
        assert db.get_email(email_id)['from_name']=='损坏�' and original.read_bytes()==raw
        # Restoring another snapshot at the same location must not reuse names
        # cached under the previous snapshot's coincidentally equal revision.
        db.init_db()
        assert not any(key[0]==values['DB_PATH'] for key in contacts._recipient_header_name_cache)
        db.upsert_email({'uid':1,'from_name':'人工更新'})
        with db.conn() as c:assert not c.execute('SELECT 1 FROM mail_identity_cache WHERE email_id=?',(email_id,)).fetchone()
        mail_identities.repair();assert db.get_email(email_id)['from_name']=='人工更新'


def test_special_and_unified():
    with fixture() as (root,values):
        seed(3)
        sent=db.create_sent_message({'from_addr':'me@example.test','to_addr':'recipient@example.test','subject':'Local receipt','body_html':'<p>hello</p>','attachments':[{'filename':'large.bin','data_base64':'A'*100000,'size':75000}]})
        db.finish_sent_message(sent,ok=True,message_id='same@example.test')
        db.upsert_email({'uid':20,'status':'sent','message_id':'same@example.test','subject':'Server duplicate','date':'2026-11-03','raw_path':'/do-not-read','body_html':'HUGE BODY'})
        db.upsert_email({'uid':21,'status':'sent','subject':'Server only','date':'2026-11-03','raw_path':'/do-not-read','body_html':'HUGE BODY'})
        db.save_draft({'subject':'Draft','body_html':'<p>draft</p>'})
        with patch('app.web.routes.compose.extract_rich_body',side_effect=AssertionError('List reconstructed body')):
            result=mail_list.page({'special':'sent'})
            assert result['total']==2 and len(result['items'])==2
            assert result['counts']['totals']['sent']==2
            assert 'data_base64' not in json.dumps(result) and 'HUGE BODY' not in json.dumps(result)
            assert mail_list.page({'special':'drafts'})['total']==1
            receipt=db.create_sent_message({'from_addr':'me@example.test','to_addr':'recipient@example.test','subject':'Receipt without server copy','body_html':'<p>local</p>'})
            db.finish_sent_message(receipt,ok=True,message_id='local-only@example.test')
            for scope in ({'status':'inbox'},{'special':'sent'},{'special':'drafts'}):
                assert mail_list.page(scope)['counts']['totals']['sent']==3
        other=dict(values,ACCOUNT_ID='other',DB_PATH=str(root/'other.db'),IMAP_USER='other@example.test')
        with use(other):db.init_db();seed(3)
        registry={'accounts':{key:{'db_path':v['DB_PATH'],'user':v['IMAP_USER']} for key,v in [('a',values),('b',other)]}}
        with patch.object(system_settings,'_load_registry',return_value=registry):
            cursor='';seen=[]
            while True:
                result=mail_list.page({'unified':True},limit=2,cursor=cursor)
                assert result['total']==6
                seen.extend((r['_account_id'],r['id']) for r in result['items']);cursor=result['next']
                if not cursor:break
            assert len(seen)==len(set(seen))==6
            registry['accounts']['b']['visible']=False
            assert mail_list.page({'unified':True})['total']==3


if __name__=='__main__':
    test_large_mailbox();test_complete_pagination_and_conversations();test_legacy_identity_recovery();test_special_and_unified()
    print('PASS bounded mailbox reads, 100k metadata, complete facets, stable cursors, identities, special and unified mailboxes')
