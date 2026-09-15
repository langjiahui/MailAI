"""Draft previews and native clipboard-file payloads, without reading the real clipboard."""
import sys,tempfile,base64,types
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app import config,db,desktop
from app.web import server

def main():
 with tempfile.TemporaryDirectory() as root,patch.object(config,'DB_PATH',str(Path(root)/'mail.db')):
  db.init_db();p=Path(root)/'复制.txt';p.write_bytes(b'clipboard bytes')
  clipboard=types.SimpleNamespace(propertyListForType_=lambda kind:[str(p)])
  fake=types.SimpleNamespace(NSPasteboard=types.SimpleNamespace(generalPasteboard=lambda:clipboard))
  with patch.dict(sys.modules,{'AppKit':fake}),patch.object(desktop.sys,'platform','darwin'):
   items=desktop.DesktopApi(None).clipboard_attachments()
  assert base64.b64decode(items[0]['data_base64'])==p.read_bytes()
  draft=db.save_draft({'attachments':items})
  assert server.api_download_draft_attachment(draft,0).body==p.read_bytes()
  assert server.api_preview_draft_attachment(draft,0)['text']=='clipboard bytes'
  with patch.object(desktop.sys,'platform','darwin'),patch.dict(sys.modules,{'AppKit':fake}):
   clipboard.propertyListForType_=lambda kind:[root]
   try:desktop.DesktopApi(None).clipboard_attachments()
   except ValueError:pass
   else:raise AssertionError('Directory clipboard must be rejected')
 print('PASS native copied-file bytes, directory rejection, draft preview/download')
if __name__=='__main__':main()
