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

if __name__=='__main__': main()
