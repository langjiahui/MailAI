"""Advanced search matches visible identities, mailbox scopes and literal conditions."""
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import db, productivity, config
from app.account_context import use


def main():
    with tempfile.TemporaryDirectory() as folder, use({'ACCOUNT_ID':'test', 'DB_PATH':str(Path(folder)/'mail.db'), 'IMAP_USER':'me@example.test'}):
        db.init_db()
        def mail(uid, **extra):
            return db.upsert_email(dict(uid=uid, message_id=f'<search-{uid}@example.test>',
                subject='季度合同', body_text='请确认合同交付安排', from_addr='fang@example.test',
                from_name='方君', to_addr='li@example.test', cc_addr='chen@example.test',
                recipient_names={'li@example.test':'李明','chen@example.test':'陈月'},
                date='2026-10-15T23:59:59', **extra))
        first = mail(1)
        second = mail(2, status='sent', folder='Sent')
        remote_draft = mail(3, status='draft', folder='Drafts')
        db.save_contact('fang@example.test','采购方老师')
        for criteria in ({'sender':'方君'},{'sender':'方'},{'sender':' fang@example.test '},{'sender':'fangjun'},
                         {'query':'from:方君'},{'query':'方君'}, {'recipient':'李明'}, {'recipient':'陈月'}, {'sender':'采购方老师'}):
            assert first in [x['id'] for x in productivity.search(criteria)['items'] if x['kind']=='email'], criteria
        assert productivity.search({'sender':'方君','subject':'不存在'})['items']==[]
        assert productivity.search({'sender':'方%君'})['items']==[]
        assert first in [x['id'] for x in productivity.search({'after':'2026-10-15','before':'2026-10-15'})['items']]
        assert productivity.search({'after':'2026-10-16'})['items']==[]
        assert second in [x['id'] for x in productivity.search({'mailbox':'sent'})['items'] if x['kind']=='email']
        assert remote_draft in [x['id'] for x in productivity.search({'mailbox':'drafts'})['items'] if x['kind']=='email']
        local_draft = db.save_draft({'subject':'本地草稿','body_html':'<p>项目 &amp; 费用</p>'})
        assert local_draft in [x['id'] for x in productivity.search({'mailbox':'drafts','sender':'me@example.test'})['items'] if x['kind']=='draft']
        assert productivity.search({'query':'"项目 & 费用"','mailbox':'drafts'})['items'][0]['id']==local_draft
        receipt=db.create_sent_message({'from_addr':'me@example.test','to_addr':'li@example.test', 'subject':'回执','message_id':'<search-2@example.test>','body_html':'<p>回执</p>'})
        db.finish_sent_message(receipt,ok=True)
        sent=productivity.search({'mailbox':'sent'})['items']
        assert len(sent)==1 and sent[0]['kind']=='sent' and sent[0]['id']==receipt
        for bad in ({'query':'from:甲','sender':'乙'},{'query':'from:甲 from:乙'},{'query':'from:'}, {'query':'"未闭合'}):
            try: productivity.search(bad)
            except ValueError: pass
            else: raise AssertionError(bad)
        assert productivity.criteria_from_query('in:sent',{'mailbox':'all'})['mailbox']=='sent'
        saved=productivity.save_named('searches',{'name':'跨账号发件人','criteria':{'sender':'方君','all_accounts':True}})
        criteria=productivity.named_items('searches')[0]['criteria']
        assert criteria['all_accounts'] is True and criteria['sender']=='方君'
        late = db.upsert_email({'uid':5,'subject':'正文深处','from_name':'其他人','from_addr':'other@example.test','body_text':'背景。'*3000+'稀有项目代号。最后说明。','date':'2026-10-15T12:00:00'})
        assert '稀有项目代号' in productivity.search({'query':'稀有项目代号'})['items'][0]['preview']
        from app.web.routes import productivity as routes
        from fastapi import HTTPException
        for bad in ({'after':'bad-date'},{'query':'from:甲','sender':'乙'}):
            with patch('app.system_settings._load_registry') as registry:
                try: routes.search({'criteria':bad,'all_accounts':True})
                except HTTPException as error: assert error.status_code==400
                else: raise AssertionError(bad)
                registry.assert_not_called()
        with patch('app.system_settings._load_registry',return_value={'accounts':{'test':{'db_path':str(Path(folder)/'mail.db'),'raw_dir':folder,'user':'me@example.test'}}}):
            response=routes.search({'criteria':{'sender':'方君'},'all_accounts':True})
            assert response['items'] and response['criteria']['sender']=='方君' and not response['failed_accounts']
        print('PASS names/address/pinyin/contact aliases, recipients, AND/literal matching, inclusive dates, server/local scopes, HTML text, syntax conflicts and saved account scope')


def test_visible_sender_aliases_and_history():
    from app import mail_assistant, system_settings
    from app.web.routes.mail_read import api_search_emails, api_emails
    from app.search_query import interpret_query
    with tempfile.TemporaryDirectory() as folder:
        account = {'ACCOUNT_ID':'sender-repro', 'DB_PATH':str(Path(folder)/'mail.db'), 'IMAP_USER':'me@example.test'}
        with use(account):
            db.init_db()
            incoming = db.upsert_email(dict(uid=1,folder='INBOX',status='inbox',from_addr='lookup@example.test',
                from_name='lookup',subject='姓名来自往来记录',date='1993-01-01T09:00:00'))
            db.upsert_email(dict(uid=2,folder='Sent',status='sent',from_addr='me@example.test',
                to_addr='lookup@example.test',recipient_names={'lookup@example.test':'顾清禾'},
                subject='先前的往来',date='2026-10-26T10:00:00'))
            other = db.upsert_email(dict(uid=3,folder='INBOX',status='inbox',from_addr='other@example.test',
                from_name='另一位同事',subject='顾清禾的项目',date='2026-10-26T09:00:00'))
            raw = Path(folder) / 'recovered-name.eml'
            raw.write_bytes('From: 王修远 <recovered@example.test>\r\nTo: me@example.test\r\nSubject: recovered\r\n\r\nbody'.encode('utf-8'))
            repaired = db.upsert_email(dict(uid=4,folder='INBOX',status='inbox',from_addr='recovered@example.test',
                from_name='\ufffd',raw_path=str(raw),subject='姓名从旧原文恢复',date='2026-10-26T09:00:00'))
            assert next(row for row in api_emails(status='inbox',days=9999,tag=[]) if row['id']==incoming)['from_name']=='顾清禾'
            def ids(query, **kwargs):
                return {row['id'] for row in api_search_emails(q=query,status='inbox',tag=[],**kwargs)}
            for query in ['发件人是顾清禾','发件人是：顾清禾。','查询发件人是顾清禾的所有邮件',
                          'from:guqinghe','from:gqh','发件人是“顾清禾 <lookup@example.test>”',
                          '发件人是顾清禾（lookup@example.test）']:
                assert ids(query)=={incoming}, query
                assert [row['id'] for row in productivity.search({'query':query,'mailbox':'inbox'})['items']]==[incoming]
                with patch.object(mail_assistant,'_ai_search_plan',side_effect=AssertionError('A sender filter needs no model')):
                    assert [row['id'] for row in mail_assistant._search_sources(query)]==[incoming]
            assert ids('顾清禾')=={incoming,other}, 'Alias hits must join existing subject/body hits'
            assert ids('发件人是王修远')=={repaired}, 'Recovered visible names must also be searchable'
            assert ids('发件人是顾清禾',folder='Projects')==set(), 'Keep the selected folder'
            assert ids('发件人是顾清禾 开始日期是2026-10-01')==set(), 'Keep explicit dates'
            assert ids('发件人是“顾清禾。”')==set(), 'Quoted punctuation stays literal'
            db.save_contact('lookup@example.test','采购顾老师')
            for query in ['采购顾老师','from:caigougulaoshi','from:cggls']:
                assert ids(query)=={incoming}, query
            db.save_contact('lookup@example.test','新姓名')
            assert not ids('采购顾老师'), 'Renaming a manual contact must invalidate its old alias immediately'
            assert ids('新姓名')=={incoming}
            registry={'accounts':{'sender-repro':{'db_path':account['DB_PATH'],'user':'me@example.test'}}}
            with patch.object(system_settings,'_load_registry',return_value=registry):
                assert {row['id'] for row in system_settings.list_unified_inbox(q='发件人是顾清禾')}=={incoming}
                assert system_settings.list_unified_inbox(q='发件人是顾清禾',days=7)==[]
            assert incoming not in {row['id'] for row in db.list_emails(status='inbox',days=7)}
            assert incoming in {row['id'] for row in db.list_emails(status='inbox',days=9999)}
            # No search operation rewrites sender headers to a learned/manual alias.
            assert db.get_email(incoming)['from_name']=='lookup'
        with use({**account,'ACCOUNT_ID':'other','DB_PATH':str(Path(folder)/'other.db')}):
            db.init_db()
            db.upsert_email(dict(uid=1,from_addr='lookup@example.test',from_name='lookup',subject='another account'))
            assert not api_search_emails(q='发件人是顾清禾',status='inbox',tag=[])
    print('PASS displayed/historical/manual aliases, pinyin, literal fields, hard scopes, 1993 mail, all-time sentinel and account isolation')


if __name__=='__main__':
    main()
    test_visible_sender_aliases_and_history()
