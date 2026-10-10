"""Pending records can merge into an existing contact after a fresh review."""
import sys,tempfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app import db,contact_directory as d
from app.account_context import use
from app.web.routes.contacts import api_directory_pending_preview,api_directory_resolve
from app.web.schemas import ContactRequest,ContactPendingRequest
from test_contact_directory import csv_file,expect_error


def plan(rows):
    source=d.inspect_file(csv_file(rows),'pending.csv')
    return d.preview(source['token'],[s['name'] for s in source['sheets']])


def pending(name,uid):
    p=plan([[name,'person@example.test','新部门',uid,'13900000000'],['冲突姓名','person@example.test','新部门',uid,'13900000000']])
    d.apply(p['token'],[])
    return next(r for r in d.pending_records() if r['data']['employee_id']==uid)


def main():
    with tempfile.TemporaryDirectory() as folder:
        with use({'ACCOUNT_ID':'pending-a','DB_PATH':str(Path(folder)/'a.db'),'IMAP_USER':'a@example.test'}):
            db.init_db()
            db.save_contact('person@example.test','原姓名','原公司','个人备注',True,
                            group_name='同事',profile={'department':'原部门','address':'保留地址','custom_fields':{'旧字段':'保留'}})
            row=pending('新姓名','P001');key=row['record_key']
            data={'email':'PERSON@example.test','name':'新姓名','company':'','profile':{**row['data'],'custom_fields':{'新字段':'补充'}}}
            expect_error(lambda:d.resolve_pending(key,data),'核对差异')
            preview=api_directory_pending_preview(key,ContactRequest(**data))
            assert preview['existing'] and preview['email']=='person@example.test'
            assert any(r['field']=='department' and not r['fills_blank'] for r in preview['differences'])
            assert any(r['field']=='mobile' and r['fills_blank'] for r in preview['differences'])
            result=api_directory_resolve(key,ContactPendingRequest(**data,update_policy='fill',expected_revision=preview['expected_revision']))
            assert result['updated'] and not d.pending_records()
            saved=db.search_contacts('person@example.test')[0]
            assert (saved['name'],saved['company'],saved['note'],saved['favorite'],saved['group_name'])==('原姓名','原公司','个人备注',1,'同事')
            assert saved['profile']['department']=='原部门' and saved['profile']['mobile']=='13900000000'
            assert saved['profile']['address']=='保留地址' and saved['profile']['custom_fields']=={'旧字段':'保留','新字段':'补充'}
            expect_error(lambda:d.resolve_pending(key,data),'已处理')
            row=pending('覆盖姓名','P002');key=row['record_key']
            data={'email':'person@example.test','name':'覆盖姓名','company':'新公司','profile':row['data']}
            preview=d.preview_pending(key,data)
            changed={**data,'name':'预览之后更改'}
            expect_error(lambda:d.resolve_pending(key,{**changed,'update_policy':'replace','expected_revision':preview['expected_revision']}),'重新核对')
            # Concurrent edits invalidate the review and leave pending state intact.
            db.set_contact_favorite(data['email'],False)
            expect_error(lambda:d.resolve_pending(key,{**data,'update_policy':'replace','expected_revision':preview['expected_revision']}),'重新核对')
            assert d.pending_records()[0]['record_key']==key
            assert db.search_contacts(data['email'])[0]['name']=='原姓名'
            preview=d.preview_pending(key,data)
            d.resolve_pending(key,{**data,'update_policy':'replace','expected_revision':preview['expected_revision']})
            saved=db.search_contacts(data['email'])[0]
            assert saved['name']=='覆盖姓名' and saved['company']=='新公司' and saved['profile']['department']=='新部门'
            assert saved['profile']['address']=='保留地址' and saved['note']=='个人备注' and saved['group_name']=='同事' and not saved['favorite']
            assert saved['profile']['custom_fields']=={'旧字段':'保留','新字段':'补充'}
            row=pending('新增姓名','P003');new_key=row['record_key']
            data={'email':'new@example.test','name':'新增姓名','profile':row['data']}
            preview=d.preview_pending(new_key,data);assert not preview['existing']
            db.save_contact(data['email'],'同时新增')
            expect_error(lambda:d.resolve_pending(new_key,{**data,'expected_revision':preview['expected_revision']}),'核对差异')
            db.hide_contact(data['email']);preview=d.preview_pending(new_key,data);assert preview['hidden']
            d.resolve_pending(new_key,{**data,'update_policy':'replace','expected_revision':preview['expected_revision']})
            assert not db.search_contacts(data['email']) and not d.pending_records()
            row=pending('待新增','P004');new_key=row['record_key']
            data={'email':'other@example.test','name':'待新增','profile':row['data']}
            expect_error(lambda:d.preview_pending(new_key,{**data,'email':'invalid'}),'有效邮箱')
            expect_error(lambda:d.resolve_pending(new_key,{**data,'update_policy':'bad'}),'更新方式')
            preview=d.preview_pending(new_key,data)
            d.resolve_pending(new_key,{**data,'expected_revision':preview['expected_revision']})
            assert db.search_contacts(data['email']) and not d.pending_records()
            assert plan([['待新增','','新部门','P004','13900000000']])['counts']['pending']==0
            isolated=pending('账号隔离','P005')['record_key']
        with use({'ACCOUNT_ID':'pending-b','DB_PATH':str(Path(folder)/'b.db'),'IMAP_USER':'b@example.test'}):
            db.init_db();expect_error(lambda:d.preview_pending(isolated,data),'已处理')
            assert not db.search_contacts()
    print('PASS pending fill/overwrite, personal field preservation, stale reviews, atomic resolution, hidden contacts and account isolation')


if __name__=='__main__':main()
