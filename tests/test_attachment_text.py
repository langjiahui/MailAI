"""Real isolated text extraction and comparison, without models or remote services."""
import sys,tempfile
from email.message import EmailMessage
from pathlib import Path
from datetime import datetime
from unittest.mock import patch
from fastapi import HTTPException
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app import db,attachment_text
from app.account_context import use
from app.web.routes.productivity import index_attachment,search_attachments,compare_attachments,search_file_contents


def main():
    with tempfile.TemporaryDirectory() as root,use({'ACCOUNT_ID':'a','DB_PATH':str(Path(root)/'mail.db'),'IMAP_USER':'me@example.test'}):
        db.init_db();ids=[]
        for number,text in enumerate(('合同总金额100元','合同总金额120元'),1):
            message=EmailMessage();message.set_content('正文');message.add_attachment(text.encode(),maintype='text',subtype='plain',filename='合同.txt')
            raw=Path(root)/(str(number)+'.eml');raw.write_bytes(message.as_bytes())
            ident=db.upsert_email(dict(uid=number,subject='合同版本',status='inbox',date=datetime.now().isoformat(),raw_path=str(raw)))
            ids.append(ident)
        extracted=attachment_text.extract_local(ids[0],0);assert extracted['text']=='合同总金额100元' and len(extracted['digest'])==64
        assert search_file_contents(ids[0],0,{'query':'100元'})['excerpts']==['合同总金额100元']
        assert not search_file_contents(ids[0],0,{'query':'100元'})['limited']
        with patch('app.preview_worker.preview_isolated', side_effect=AssertionError('unchanged attachment should use its verified cache')):
            assert search_file_contents(ids[0],0,{'query':'合同'})['excerpts']
        assert not search_file_contents(ids[0],0,{'query':'不存在'})['excerpts']
        assert attachment_text.search_excerpts('.* ' * 20,'.*')['more']
        assert attachment_text.search_excerpts('İ TEST test','test')['excerpts'][0]=='İ TEST test'
        assert index_attachment(ids[0],0)['ok']
        results=search_attachments('100元')['items'];assert results[0]['email_id']==ids[0]
        diff=compare_attachments({'items':[{'email_id':ids[0],'index':0},{'email_id':ids[1],'index':0}]})
        assert not diff['identical'] and '-合同总金额100元' in diff['diff'] and '+合同总金额120元' in diff['diff']
        try:
            compare_attachments({'items':[{'email_id':ids[0],'index':0},{'email_id':ids[0],'index':0,'extra':'ignored'}]})
            assert False
        except HTTPException as exc:
            assert exc.status_code == 400
        assert attachment_text.limited_text({'name':'报销.xlsx','note':'提取前 1/1 个工作表'})
        assert attachment_text.limited_text({'name':'说明.pdf','note':'已提取前 20/40 页文字'})
        assert not attachment_text.limited_text({'name':'说明.pdf','note':'已提取前 2/2 页文字'})
        samples=[dict(name='材料.txt',digest=str(i),text='\n'.join(f'{i}-{n}' for n in range(150)),note='本地文字提取') for i in range(2)]
        with patch('app.attachment_text.extract_local',side_effect=samples):
            capped=compare_attachments({'items':[{'email_id':ids[0],'index':0},{'email_id':ids[1],'index':0}]})
        assert capped['diff_truncated'] and len(capped['diff'].splitlines())==200
        # Replacing the original MIME must invalidate the cache before matching.
        changed=EmailMessage();changed.set_content('正文');changed.add_attachment('合同总金额130元'.encode(),maintype='text',subtype='plain',filename='合同.txt')
        (Path(root)/'1.eml').write_bytes(changed.as_bytes())
        assert search_file_contents(ids[0],0,{'query':'130元'})['excerpts']==['合同总金额130元']
        assert not search_file_contents(ids[0],0,{'query':'100元'})['excerpts']
        with db.conn() as c:c.execute("UPDATE emails SET status='quarantine' WHERE id=?",(ids[0],))
        assert search_attachments('100元')['items']==[]
        try:attachment_text.extract_local(ids[0],0);assert False
        except ValueError:pass
        with use({'ACCOUNT_ID':'b','DB_PATH':str(Path(root)/'other.db'),'IMAP_USER':'other@example.test'}):
            db.init_db()
            try:
                search_file_contents(ids[0],0,{'query':'130元'});assert False
            except HTTPException as exc:
                assert exc.status_code==400
    print('PASS isolated attachment extraction/search, verified cache and invalidation, account isolation, comparison bounds and quarantined-source rejection')


if __name__=='__main__':main()
