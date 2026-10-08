"""Real isolated text extraction and comparison, without models or remote services."""
import sys,tempfile
from email.message import EmailMessage
from pathlib import Path
from datetime import datetime
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
        assert not search_file_contents(ids[0],0,{'query':'不存在'})['excerpts']
        assert attachment_text.search_excerpts('.* ' * 20,'.*')['more']
        assert attachment_text.search_excerpts('İ TEST test','test')['excerpts'][0]=='İ TEST test'
        assert index_attachment(ids[0],0)['ok']
        results=search_attachments('100元')['items'];assert results[0]['email_id']==ids[0]
        diff=compare_attachments({'items':[{'email_id':ids[0],'index':0},{'email_id':ids[1],'index':0}]})
        assert not diff['identical'] and '-合同总金额100元' in diff['diff'] and '+合同总金额120元' in diff['diff']
        with db.conn() as c:c.execute("UPDATE emails SET status='quarantine' WHERE id=?",(ids[0],))
        assert search_attachments('100元')['items']==[]
        try:attachment_text.extract_local(ids[0],0);assert False
        except ValueError:pass
    print('PASS isolated attachment extraction, indexed content, version comparison and quarantined-source rejection')


if __name__=='__main__':main()
