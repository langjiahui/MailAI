"""Saved outgoing attachments remain downloadable and account scoped."""
import sys, tempfile, base64
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import config, db
from app.web import server
from fastapi import HTTPException

def main():
    with tempfile.TemporaryDirectory() as root:
        for account, content in [('a',b'first account attachment'),('b',b'second account attachment')]:
            with patch.object(config,'DB_PATH',str(Path(root)/f'{account}.db')):
                db.init_db()
                record=db.create_sent_message({'attachments':[{'filename':'测试附件.txt','data_base64':base64.b64encode(content).decode(),'content_type':'text/plain'}]})
                assert record == 1
                assert server.api_download_sent_attachment(record,0).body == content
                preview=server.api_preview_sent_attachment(record,0)
                assert preview['kind']=='text' and content.decode() in preview['text']
                for index in [-1,1]:
                    try: server.api_download_sent_attachment(record,index)
                    except HTTPException as e: assert e.status_code==404
                    else: raise AssertionError('Invalid index must fail')
                missing=db.create_sent_message({'attachments':[{'filename':'missing.txt'}]})
                assert db.get_sent_attachment(missing,0) is None
        with patch.object(config,'DB_PATH',str(Path(root)/'a.db')):
            assert db.get_sent_attachment(1,0)['payload']==b'first account attachment'
    print('PASS saved sent attachment download, preview, missing data and account isolation')
if __name__=='__main__': main()
