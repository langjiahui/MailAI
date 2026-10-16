"""Mail label arrival rules, transactions, paging, lifecycle and account isolation."""
import sys
import tempfile
from pathlib import Path
from datetime import datetime
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import db
from app.db import mail_tags as tags
from app.account_context import use
from app.web.routes import mail_tags as routes


def main():
    with tempfile.TemporaryDirectory() as folder:
        account = {'ACCOUNT_ID':'labels-a', 'DB_PATH':str(Path(folder)/'a.db'), 'IMAP_USER':'a@example.test'}
        with use(account):
            db.init_db()
            project = tags.save_tag('项目 A', '#548879')['id']
            contract = tags.save_tag('合同', '#b1784a')['id']
            old = db.upsert_email(dict(uid=1, subject='旧合同', body_text='付款说明', from_addr='CLIENT@EXAMPLE.TEST', status='inbox', date=datetime.now().isoformat()))
            rule = tags.save_rule('客户合同', [dict(field='sender',operator='contains',value='client@example.test'),dict(field='subject',operator='contains',value='合同'),dict(field='body',operator='contains',value='付款')], [project,contract])['id']
            assert not db.get_email(old)['tags'], 'Existing mail is not silently relabeled'
            matching = dict(uid=2, subject='项目合同', body_text='付款说明', from_addr='Client@Example.Test', from_name='客户', status='inbox', date=datetime.now().isoformat())
            first = db.upsert_email(matching)
            assert {t['id'] for t in db.get_email(first)['tags']} == {project,contract}
            assert tags.apply_existing()['count']==1
            assert tags.apply_existing()['count']==0, 'Rules are idempotent'
            not_matching = db.upsert_email({**matching,'uid':3,'body_text':'无需处理'})
            assert not db.get_email(not_matching)['tags']
            revision = db.mailbox_revision()['revision']
            tags.update_members([first],[contract], 'remove')
            assert db.mailbox_revision()['revision'] != revision
            db.upsert_email(matching)
            assert [t['id'] for t in db.get_email(first)['tags']]==[project], 'Sync retries preserve manual removals'
            tags.update_members([first],[contract])
            tags.update_members([first],[contract])
            assert len(db.get_email(first)['tags'])==2
            tags.update_members([not_matching],[project])
            assert len(db.list_emails(days=9999,tags=['项目 A','合同']))==3
            assert len(db.list_emails(days=9999,tags=['项目 A','合同'],tag_mode='all'))==2
            assert len(db.list_emails(days=9999,tags=['合同'],limit=1,offset=1))==1
            assert len(db.search_emails(['合同'],tags=['合同'],tag_mode='all'))==2
            assert not db.list_emails(days=9999,tags=["' OR 1=1 --"])
            assert 'tags' in db.list_emails(days=9999,list_view=True)[0]
            # Picker changes are deltas: concurrent automatic additions/removals survive.
            concurrent = tags.save_tag('并发标签')['id']
            tags.update_members([first],[concurrent])
            tags.update_members([first],[project], 'replace', original_tag_ids=[project,contract])
            assert {t['id'] for t in db.get_email(first)['tags']}=={project,concurrent}
            tags.update_members([first],[project],'remove')
            tags.update_members([first],[project,contract], 'replace', original_tag_ids=[project])
            assert {t['id'] for t in db.get_email(first)['tags']}=={contract,concurrent}, 'A stale picker must not resurrect another window removal'
            tags.update_members([first],[project,contract],'replace')
            assert tags.snapshot([first,999999])[0]['tags']==db.get_email(first)['tags']
            # Visible HTML, inline styling and unavailable body have deterministic semantics.
            positive={'match_mode':'all','conditions':[dict(field='body',operator='contains',value='付款 交付')]}
            assert tags.matches(positive,{'body_text':'  ','body_html':'<style>.x {color:red}</style><p>付款&nbsp; <b>交付</b></p><script>secret</script>'})
            assert not tags.matches({'match_mode':'all','conditions':[dict(field='body',operator='contains',value='secret')]},{'body_html':'<script>secret</script><p>hello</p>'})
            assert not tags.matches({'match_mode':'all','conditions':[dict(field='body',operator='not_contains',value='广告')]},{})
            assert tags.preview([dict(field='subject',operator='contains',value='合同')])['count']==3
            assert len(tags.preview([dict(field='subject',operator='contains',value='合同')])['examples'])<=3
            # Invalid stored JSON / malformed optional rules cannot break incoming mail.
            with db.conn() as c:
                c.execute("INSERT INTO mail_tag_rules(name,enabled,match_mode,conditions,tag_ids) VALUES('corrupt',1,'all','not json','broken')")
            with patch.object(tags.log,'warning'):
                assert tags.rules()
                invalid_safe=db.upsert_email({**matching,'uid':90,'body_text':'不匹配'})
                assert not db.get_email(invalid_safe)['tags']
            with db.conn() as c:c.execute("DELETE FROM mail_tag_rules WHERE name='corrupt'")
            tags.delete_tag(concurrent)
            before = db.get_email(first)['tags']
            for ids,targets in (([first,999999],[contract]),([first],[999999])):
                try: tags.update_members(ids,targets,'replace')
                except ValueError: pass
                else: raise AssertionError('Stale targets must fail atomically')
                assert db.get_email(first)['tags']==before
            tags.save_rule('客户合同', [dict(field='sender',operator='equals',value='Client@Example.Test')], [contract], enabled=False, rule_id=rule)
            assert not db.get_email(db.upsert_email({**matching,'uid':4}))['tags']
            any_rule = tags.save_rule('任意条件', [dict(field='sender',value='never',operator='contains'),dict(field='body',operator='contains',value='付款')], [contract], match_mode='any')['id']
            assert db.get_email(db.upsert_email({**matching,'uid':5,'body_text':'','body_html':'<p>付款 &amp; 交付</p>'}))['tags']
            assert tags.matches({'match_mode':'all','conditions':[dict(field='subject',operator='not_contains',value='广告')]},matching)
            for conditions in ([],[dict(field='unknown',operator='contains',value='x')],[dict(field='body',operator='contains',value=' ')]):
                try: tags.save_rule('坏规则',conditions,[contract])
                except ValueError: pass
                else: raise AssertionError('Invalid rules accepted')
            try: tags.save_tag('项目 A')
            except ValueError: pass
            else: raise AssertionError('Duplicate labels accepted')
            tags.save_tag('项目 B','#123456',project)
            assert any(t['name']=='项目 B' for t in db.get_email(first)['tags'])
            tags.delete_tag(contract)
            assert not tags.rules(), 'Rules without target tags must be removed'
            assert [t['id'] for t in db.get_email(first)['tags']]==[project]
            tags.update_members([first],[],'replace')
            assert not db.get_email(first)['tags']
            with db.conn() as c:
                c.execute('DELETE FROM emails WHERE id=?',(not_matching,))
                assert not c.execute('SELECT 1 FROM email_tags WHERE email_id=?',(not_matching,)).fetchone()
            db.init_db()  # Existing installations can initialize repeatedly without losing tags.
            assert tags.catalog()[0]['name']=='项目 B'
            result = routes.api_save_mail_tag(routes.TagRequest(name='API 标签'))
            routes.api_mail_tag_members(routes.MembersRequest(ids=[old],tag_ids=[result['id']]))
            assert any(t['name']=='API 标签' for t in db.get_email(old)['tags'])
            tags.save_rule('历史批次', [dict(field='body',operator='equals',value='批次标签测试')], [project])
            with db.conn() as c:
                c.executemany('INSERT INTO emails(uid,subject,body_text,date,status) VALUES(?,?,?,?,?)',
                    [(100+n,'历史批次','批次标签测试',datetime.now().isoformat(),'inbox') for n in range(215)])
            assert tags.apply_existing()['count']==215, 'Historical application crosses batch boundaries'
            assert tags.apply_existing()['count']==0
            assert len(db.list_emails(days=9999,tags=['项目 B']))>=215
            # Recheck enabled rules between write batches, rather than continuing a stale snapshot.
            tags.update_members([old],[project],'remove')
            original_rules=tags.rules
            reads=[0]
            def changed_rules(c=None,enabled_only=False):
                reads[0]+=1
                return original_rules(c,enabled_only) if reads[0]<2 else []
            with patch.object(tags,'rules',side_effect=changed_rules):
                assert tags.apply_existing()['count']==0
            assert reads[0]>=2
        with use({'ACCOUNT_ID':'labels-b','DB_PATH':str(Path(folder)/'b.db'),'IMAP_USER':'b@example.test'}):
            db.init_db()
            assert tags.catalog()==[] and tags.rules()==[]
            second = db.upsert_email(dict(uid=1,subject='项目合同',body_text='付款说明',from_addr='client@example.test',status='inbox',date=datetime.now().isoformat()))
            assert not db.get_email(second)['tags']
            other_tag = tags.save_tag('另一个账号的标签')['id']
            tags.update_members([second],[other_tag])
        from app import system_settings
        registry = {'accounts':{'labels-a':{'db_path':account['DB_PATH'],'user':'a@example.test'},
                                'labels-b':{'db_path':str(Path(folder)/'b.db'),'user':'b@example.test'}}}
        with use(account), patch.object(system_settings,'_load_registry',return_value=registry):
            unified = system_settings.list_unified_inbox()
            first_row = next(row for row in unified if row['_account_id']=='labels-a' and row['uid']==1)
            second_row = next(row for row in unified if row['_account_id']=='labels-b' and row['uid']==1)
            assert 'API 标签' in {tag['name'] for tag in first_row['tags']} and '另一个账号的标签' not in {tag['name'] for tag in first_row['tags']}
            assert [tag['name'] for tag in second_row['tags']]==['另一个账号的标签'], 'Identical row IDs must not mix labels across accounts'
    print('PASS mail labels: arrival rules, multi-label facets, paging, retry preservation, transactions, deletion and account isolation')

if __name__ == '__main__': main()
