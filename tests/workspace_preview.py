"""Isolated interactive fixture. No live mailbox, model or SMTP connections."""
def main():
    import os
    import sys
    import tempfile
    from pathlib import Path
    from datetime import datetime, timedelta
    fixture = tempfile.TemporaryDirectory(prefix='mailai-workspace-ui-')
    os.environ.update(MAILAI_HOME=fixture.name, IMAP_USER='work@example.test', IMAP_PASSWORD='fixture',
                      IMAP_HOST='imap.example.test', SMTP_HOST='smtp.example.test', SMTP_USE_IMAP_CREDENTIALS='true',
                      LLM_API_KEY='fixture', LLM_BASE_URL='http://127.0.0.1:9', LLM_MODEL='fixture-model',
                      AUTO_OPEN_BROWSER='false')
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from app import config, db, system_settings, credential_store, pipeline, smtp_client
    from app.account_context import use
    from app.web import server
    import uvicorn

    credential_store.load = lambda key: 'fixture'
    credential_store.available = lambda: True
    registry = {'accounts': {}}
    for label in ('work','personal'):
        user = label + '@example.test'
        key = system_settings._account_key('imap.example.test',user)
        account = dict(user=user, host='imap.example.test',db_path=os.path.join(fixture.name,label+'.db'),
                       raw_dir=os.path.join(fixture.name,label+'-raw'), smtp_host='smtp.example.test', smtp_port=465)
        registry['accounts'][key] = account
        Path(account['raw_dir']).mkdir()
        with use(dict(ACCOUNT_ID=key, DB_PATH=account['db_path'], RAW_DIR=account['raw_dir'], IMAP_USER=user)):
            db.init_db()
            for n in range(12):
                db.upsert_email(dict(uid=n+1,subject=['采购合同交期确认','项目周报与下周安排','部门培训通知'][n%3],
                    from_addr='colleague@example.test',from_name='项目同事',to_addr=user,
                    date=(datetime.now()-timedelta(days=n//3)).isoformat(),status='inbox',category=['项目工作','系统通知'][n%2],
                    priority='高' if n%3==0 else '中',score=40 if n==1 else 0,verdict='suspicious' if n==1 else 'clean',
                    summary='请确认采购合同交期，并在周五前反馈项目排期。附件资料将由项目组另行提供。',
                    body_text='您好：\n\n请协助确认本次采购合同的交付时间。项目组计划本周完成评审，请反馈您的意见。\n\n谢谢！'))
            db.save_contact('colleague@example.test','项目同事','示例公司','采购负责人',True)
            db.add_todos(1,[{'title':'确认合同交期','deadline':datetime.now().date().isoformat()}])
            from email.message import EmailMessage
            message=EmailMessage();message['From']='colleague@example.test';message['To']=user;message['Subject']='采购合同交期确认';message.set_content('请结合附件确认交付安排。')
            csv='事项,负责人,交付日\n确认排期,项目组,周五\n'.encode('utf-8')
            message.add_attachment(csv,maintype='text',subtype='csv',filename='交付安排.csv')
            message.add_attachment(b'fixture-only',maintype='application',subtype='octet-stream',filename='旧版资料.xls')
            message.add_attachment(b'fixture-only',maintype='application',subtype='octet-stream',filename='旧版文档.doc')
            raw_path=Path(account['raw_dir'])/(label+'-attachments.eml');raw_path.write_bytes(message.as_bytes())
            with db.conn() as connection:
                connection.execute('UPDATE emails SET raw_path=?,attachments=? WHERE id=1',(str(raw_path),'[{"name":"交付安排.csv","size":80},{"name":"旧版资料.xls","size":12},{"name":"旧版文档.doc","size":12}]'))
            sent_id = db.create_sent_message(dict(from_addr=user, to_addr='customer@example.test',
                subject='项目交付时间确认', body_html='<p>您好，项目交付时间已经确认，请查收。</p>', attachments=[]))
            db.finish_sent_message(sent_id, ok=True, sent_folder='Sent', message_id=f'fixture-{label}@example.test')
    registry['last_account'] = next(iter(registry['accounts']))
    system_settings._save_registry(registry)
    config.DB_PATH = registry['accounts'][registry['last_account']]['db_path']
    config.RAW_DIR = registry['accounts'][registry['last_account']]['raw_dir']
    class FakeMail:
        def __enter__(self): return self
        def __exit__(self,*args): pass
        def list_mailboxes(self): return [dict(name=name,flags=[flag],messages=12 if name=='INBOX' else 0,selectable=True) for name,flag in [('INBOX','\\Inbox'),('Sent','\\Sent'),('Drafts','\\Drafts'),('Trash','\\Trash')]]
        def set_seen(self,*args): pass
        def set_flagged(self,*args): pass
        def move(self,uid,folder,target): return uid+1000
        def fetch_new(self,**kwargs): return []
        def ensure_quarantine_folder(self): pass
        def ensure_spam_folder(self): pass
    if os.environ.get('MAILAI_CLEANUP_FIXTURE') == '1':
        for key, account in registry['accounts'].items():
            with use(dict(ACCOUNT_ID=key, DB_PATH=account['db_path'], RAW_DIR=account['raw_dir'], IMAP_USER=account['user'])):
                with db.conn() as c:
                    c.execute('UPDATE emails SET date=? WHERE id=1', ((datetime.now()-timedelta(days=60)).isoformat(),))
        from app import server_cleanup
        removed = set()
        server_raw = {}
        class CleanupMail(FakeMail):
            def __init__(self): self.client=self; self.folder='INBOX'
            def has_capability(self, name): return True
            def select_folder(self, folder, readonly=True): self.folder=folder; return {b'UIDVALIDITY':123}
            def fetch(self, uids, fields):
                result={}
                for uid in uids:
                    key=(config.IMAP_USER,self.folder,uid)
                    if key in removed: continue
                    if key not in server_raw:
                        row=db.get_email_by_folder_uid(self.folder,uid)
                        if not row or not row.get('raw_path'): continue
                        server_raw[key]=Path(row['raw_path']).read_bytes()
                    raw=server_raw[key]
                    result[uid]={b'RFC822.SIZE':len(raw),b'FLAGS':[],b'BODY[]':raw}
                return result
            def add_flags(self, uids, flags, silent=True): pass
            def expunge(self, uids):
                assert uids
                for uid in uids: removed.add((config.IMAP_USER,self.folder,uid))
            def search(self, criteria):
                uid=int(criteria[1]);return [] if (config.IMAP_USER,self.folder,uid) in removed else [uid]
        server_cleanup.MailClient=CleanupMail
    server.MailClient = FakeMail
    pipeline.MailClient = FakeMail
    from app import mail_undo
    mail_undo.MailClient = FakeMail
    smtp_client.send = lambda payload: {'message_id':'fixture@example.test','recipients':1,'sent_folder':'Sent','warning':''}
    server.app.router.on_startup.clear()
    from app.mailbox_jobs import start_outbox
    start_outbox()
    print('ISOLATED_FIXTURE http://127.0.0.1:18795',flush=True)
    uvicorn.run(server.app,host='127.0.0.1',port=18795,log_level='warning')


if __name__ == '__main__':
    main()
