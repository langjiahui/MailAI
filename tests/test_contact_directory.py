"""Directory updates preserve personal edits, identities, account scopes and pending rows."""
import csv,io,json,sys,tempfile,zipfile
from fastapi import HTTPException
from pathlib import Path
from xml.sax.saxutils import escape
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app import db,contact_directory as d
from app.account_context import use
from app.web.routes.contacts import api_save_contact,api_directory_export
from app.web.schemas import ContactRequest

HEAD=['姓名','邮箱','员工部门','工号※','手机号码','性别','工作电话','行政组','备注1','办公地点','个人备注','个人分组']
def csv_file(rows):
    out=io.StringIO();writer=csv.writer(out);writer.writerow(HEAD);writer.writerows(rows)
    return out.getvalue().encode('utf-8-sig')

def plan(raw,policy='sync'):
    info=d.inspect_file(raw,'department.csv')
    return d.preview(info['token'],[s['name'] for s in info['sheets'] if s['selected']],policy)

def xlsx(sheets):
    out=io.BytesIO();main='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    with zipfile.ZipFile(out,'w') as z:
        workbook='<workbook xmlns="'+main+'" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
        relationships='<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        for i,(name,rows) in enumerate(sheets,1):
            workbook+=f'<sheet name="{escape(name)}" sheetId="{i}" r:id="r{i}"/>'
            relationships+=f'<Relationship Id="r{i}" Target="worksheets/sheet{i}.xml" Type="worksheet"/>'
            sheet='<worksheet xmlns="'+main+'"><sheetData>'
            for n,row in enumerate(rows,1):
                sheet+=f'<row r="{n}">'
                for col,value in enumerate(row,1):
                    sheet+=f'<c r="{d.column_name(col)}{n}" t="inlineStr"><is><t>{escape(str(value))}</t></is></c>'
                sheet+='</row>'
            sheet+='</sheetData><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells></worksheet>'
            z.writestr(f'xl/worksheets/sheet{i}.xml',sheet)
        z.writestr('xl/workbook.xml',workbook+'</sheets></workbook>')
        z.writestr('xl/_rels/workbook.xml.rels',relationships+'</Relationships>')
    return out.getvalue()


def expect_error(fn,contains=None):
    try:fn()
    except (ValueError,HTTPException) as e:
        if contains:assert contains in str(e),str(e)
    else:raise AssertionError('Operation should be rejected')


def main():
    with tempfile.TemporaryDirectory() as folder:
        cfg={'ACCOUNT_ID':'a','DB_PATH':str(Path(folder)/'a.db'),'IMAP_USER':'me@example.test'}
        with use(cfg):
            db.init_db();db.init_db()
            base=[['张示例','alice@example.test','研发部','B001','13800000000','女','010-12345678','软件组','初版资料','A楼','个人备注','项目伙伴'],['李示例','bob@example.test','运维部','B002','13900000000','男','','运维组','','B楼','',''],['待补示例','','运维部','B003','13700000000','女','','运维组','','','','']]
            p=plan(csv_file(base));assert p['counts']['new']==2 and p['counts']['pending']==1
            assert p['items'][0]['employee_id']=='B001'
            assert not db.search_contacts(), 'Preview is read-only'
            result=d.apply(p['token'],[r['email'] for r in p['items']]);assert result['new']==2 and result['pending']==1
            assert d.apply(p['token'],[])==result,'Accepted requests are idempotent'
            alice=db.search_contacts('alice@example.test')[0]
            assert alice['profile']['gender']=='女' and alice['profile']['mobile']=='13800000000'
            assert alice['note']=='个人备注' and alice['group_name']=='项目伙伴'
            assert db.search_contacts('B001')[0]['email']=='alice@example.test'
            assert db.search_contacts('13800000000')[0]['email']=='alice@example.test'
            assert db.search_contacts(department='运维部')[0]['email']=='bob@example.test'
            assert plan(csv_file(base))['counts']['unchanged']==2
            # An imported mobile updates; manual department edits are protected.
            altered=dict(alice['profile'],department='手工部门')
            edited=api_save_contact(ContactRequest(email=alice['email'],name=alice['name'],company=alice['company'],note='手工备注',favorite=True,group_name='私人分组',profile=altered,directory_revision=alice['directory_revision']))
            base[0][2]='新版部门';base[0][4]='13800000001';base[0][10]='文件备注';base[0][11]='文件分组'
            updated=plan(csv_file(base));entry=next(r for r in updated['items'] if r['email']==alice['email'])
            assert any(c['field']=='mobile' for c in entry['changes'])
            assert any(c['field']=='department' for c in entry['protected'])
            d.apply(updated['token'],[r['email'] for r in updated['items']])
            alice2=db.search_contacts(alice['email'])[0]
            assert alice2['profile']['department']=='手工部门' and alice2['profile']['mobile']=='13800000001'
            assert alice2['favorite'] and alice2['group_name']=='私人分组' and alice2['note']=='手工备注'
            expect_error(lambda:api_save_contact(ContactRequest(email=alice['email'],name='stale',profile=altered,directory_revision=edited['directory_revision'])),'重新打开')
            # Explicitly cleared imported fields are manual edits, not refill targets.
            alice3=db.search_contacts(alice['email'])[0]
            cleared=dict(alice3['profile'],mobile='')
            api_save_contact(ContactRequest(email=alice['email'],name=alice3['name'],company=alice3['company'],note=alice3['note'],favorite=True,group_name=alice3['group_name'],profile=cleared,directory_revision=alice3['directory_revision']))
            blocked=plan(csv_file(base));record=next(r for r in blocked['items'] if r['email']==alice['email'])
            assert any(c['field']=='mobile' for c in record['protected'])
            d.apply(blocked['token'],[r['email'] for r in blocked['items']]);assert db.search_contacts(alice['email'])[0]['profile']['mobile']==''
            refill=plan(csv_file(base),'fill');d.apply(refill['token'],[r['email'] for r in refill['items']]);assert db.search_contacts(alice['email'])[0]['profile']['mobile']=='13800000001'
            # Later blank file cells never erase existing phone or department.
            base[0][4]='';filled=plan(csv_file(base));d.apply(filled['token'],[r['email'] for r in filled['items']]);assert db.search_contacts(alice['email'])[0]['profile']['mobile']=='13800000001'
            # A contact edit after preview rejects the whole import, avoiding partial writes.
            stale=plan(csv_file([['新同事','new@example.test','研发部','B004'],base[1]]))
            db.save_contact('bob@example.test','后来编辑')
            expect_error(lambda:d.apply(stale['token'],[r['email'] for r in stale['items']]),'重新预览')
            assert not db.search_contacts('new@example.test')
            # Pending profiles are editable, and resolved addresses are reused next time.
            pending=d.pending_records()[0]
            d.resolve_pending(pending['record_key'],{'email':'pending@example.test','name':pending['data']['name'],'profile':pending['data']})
            assert d.summary()['pending']==0
            assert plan(csv_file(base))['counts']['pending']==0
            base[2][4]='13700000001'
            changed=plan(csv_file(base));resolved=next(r for r in changed['items'] if r['email']=='pending@example.test');assert any(c['field']=='mobile' for c in resolved['changes'])
            d.apply(changed['token'],[r['email'] for r in changed['items']]);assert db.search_contacts('pending@example.test')[0]['profile']['mobile']=='13700000001'
            # Hidden contacts aren't revived by a directory update.
            db.hide_contact('bob@example.test');hidden=plan(csv_file(base));d.apply(hidden['token'],[r['email'] for r in hidden['items']]);assert not db.search_contacts('bob@example.test')
            # English/custom headings, parallel blocks, sheet context, duplicate email conflicts.
            book=xlsx([('部门人员邮箱',[HEAD,['张示例','alice2@example.test','研发部','B011','13800000000','女']]),('干部邮箱',[['姓名','邮箱','员工部门','工号','备注'],['张示例','alice2@example.test','事业本部','B011','管理岗']]),('电话分表',[['序号','工号','姓名','工作电话','手机号码','','序号','工号','姓名','工作电话','手机号码'],['1','B011','张示例','010-22222222','13800000000','','2','B012','另一同事','010-33333333','13900000000']])])
            info=d.inspect_file(book,'department.xlsx');preview=d.preview(info['token'],[s['name'] for s in info['sheets']])
            record=preview['items'][0];assert preview['counts']['conflict']==0 and preview['counts']['pending']==1
            assert any(c['after']=='010-22222222' for c in record['changes'])
            d.apply(preview['token'],[record['email']]);person=db.search_contacts('alice2@example.test')[0]
            assert person['profile']['directory_tags']=='干部' and person['profile']['custom_fields']['干部邮箱 · 部门备注1']=='管理岗'
            assert len(d._extract(d.read_workbook(book)[2]))==2, 'Parallel lists must all be read'
            bad=plan(csv_file([['张示例','conflict@example.test','研发部','B100'],['不同姓名','conflict@example.test','研发部','B100']]))
            assert bad['counts']['conflict']==1;d.apply(bad['token'],[]);assert any('冲突' in r['reason'] for r in d.pending_records())
            mapped=d.inspect_file(xlsx([('自定义',[['人员名称','联系邮箱','单位名称'],['映射示例','map@example.test','映射部门']])]),'custom.xlsx')
            manual=d.preview(mapped['token'],['自定义'],overrides={'自定义':{'header_row':1,'fields':{'name':1,'email':2,'department':3}}})
            assert manual['counts']['new']==1
            expect_error(lambda:d.preview(mapped['token'],['自定义'],overrides={'自定义':{'header_row':1,'fields':{'name':1,'email':1}}}),'多个字段')
            expect_error(lambda:d.inspect_file(b'not-zip','bad.xlsx'))
            expect_error(lambda:d.preview([],['sheet']))
            exported=api_directory_export().body.decode('utf-8-sig');assert '性别' in exported and '手机号' in exported and '13800000001' in exported
            imported_export=plan(api_directory_export().body);export_record=next(r for r in imported_export['items'] if r['email']=='alice2@example.test')
            assert not export_record['changes'], 'Complete CSV must preserve supplemental cadre fields'
            token=manual['token']
        with use({'ACCOUNT_ID':'b','DB_PATH':str(Path(folder)/'b.db'),'IMAP_USER':'other@example.test'}):
            db.init_db();expect_error(lambda:d.apply(token,['map@example.test']),'当前邮箱');assert not db.search_contacts()
    print('PASS directory parsing, safe updates, manual protection, conflicts, pending records, snapshots, complete exports and account isolation')

if __name__=='__main__':main()
