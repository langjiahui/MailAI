"""Multi-label filtering preserves old groups, imported labels and mailbox isolation."""
import sys,tempfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app import db
from app.db import contact_tags as tags
from app.account_context import use

def main():
    with tempfile.TemporaryDirectory() as folder:
        with use({'ACCOUNT_ID':'tags-a','DB_PATH':str(Path(folder)/'a.db'),'IMAP_USER':'a@example.test'}):
            db.init_db()
            db.save_contact('one@example.test','一号','甲公司','保留备注',True,group_name='旧分组',profile={'department':'研发','directory_tags':' 干部、合作伙伴；干部 '})
            db.save_contact('two@example.test','二号','乙公司',profile={'department':'市场','directory_tags':'合作伙伴'})
            tags.save('项目A');tags.save('客户')
            tags.update_members('项目A',['one@example.test','two@example.test'])
            tags.update_members('客户',['one@example.test'])
            item=db.search_contacts('one@example.test')[0]
            assert item['group_name']=='旧分组' and item['note']=='保留备注' and item['favorite']
            assert {t['id'] for t in item['tags']}=={'personal:旧分组','personal:项目A','personal:客户','directory:干部','directory:合作伙伴'}
            assert len(db.search_contacts(tags=['personal:客户','personal:项目A']))==2
            assert [r['email'] for r in db.search_contacts(tags=['personal:客户','personal:项目A'],tag_mode='all')]==['one@example.test']
            assert len(db.search_contacts(tags=['directory:合作伙伴']))==2
            assert len(db.search_contacts('项目A'))==2
            assert len(db.search_contacts(tags=['personal:项目A'],department='研发',company='甲公司',favorites_only=True))==1
            assert not db.search_contacts(tags=['personal:项目A'],department='市场',favorites_only=True)
            tags.save('同事','旧分组')
            assert db.search_contacts(tags=['personal:同事'])[0]['group_name']=='同事'
            tags.update_members('同事',['one@example.test'],remove=True)
            assert not db.search_contacts(tags=['personal:同事'])
            assert len(db.search_contacts(tags=['personal:客户']))==1
            # A future directory update cannot remove personal tags.
            db.save_contact('one@example.test','一号','甲公司','保留备注',True,profile={'department':'研发','directory_tags':'新名单'})
            assert len(db.search_contacts(tags=['personal:客户']))==1
            assert not db.search_contacts(tags=['directory:干部'])
            tags.delete('客户');assert not db.search_contacts(tags=['personal:客户'])
            assert len(db.search_contacts())==2
            db.hide_contact('two@example.test')
            assert tags.facets()['total']==1
            assert next(t['count'] for t in tags.facets()['tags'] if t['name']=='项目A')==1
            # Filtering happens before pagination; facets count the full collection.
            for n in range(305):db.save_contact(f'bulk{n:03}@example.test',f'人员{n}')
            tags.update_members('项目A',[f'bulk{n:03}@example.test' for n in range(300)])
            tags.update_members('项目A',[f'bulk{n:03}@example.test' for n in range(300,305)])
            assert len(db.search_contacts(limit=300,tags=['personal:项目A']))==300
            assert len(db.search_contacts(limit=300,offset=300,tags=['personal:项目A']))==6
            assert tags.facets(tags=['personal:项目A'])['total']==306
            with db.conn() as c:
                assert c.execute('SELECT group_name FROM contacts WHERE email=?',('one@example.test',)).fetchone()[0]==''
        with use({'ACCOUNT_ID':'tags-b','DB_PATH':str(Path(folder)/'b.db'),'IMAP_USER':'b@example.test'}):
            db.init_db();assert tags.facets()=={'tags':[],'companies':[],'total':0}
    print('PASS tags: legacy groups, multiple labels, import separation, combined filters, full pagination/counts, preservation and account isolation')

if __name__=='__main__':main()
