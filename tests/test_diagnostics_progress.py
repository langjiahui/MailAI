"""Live completion is incremental, account scoped and bounded; no real probes."""
import asyncio,json,sys,tempfile,threading
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app import db,system_settings
from app.account_context import use,current
from app.web.routes import system
from fastapi import HTTPException

def collect(response):
    async def read():
        text=''
        async for chunk in response.body_iterator:
            text += chunk.decode() if isinstance(chunk,bytes) else chunk
        return [json.loads(line) for line in text.splitlines() if line.strip()]
    return asyncio.run(read())

def main():
    with tempfile.TemporaryDirectory() as root:
        values=dict(ACCOUNT_ID='test-a',DB_PATH=str(Path(root)/'a.db'),DATA_DIR=root,IMAP_HOST='imap.example.test',IMAP_USER='a@example.test',IMAP_PASSWORD='fake-secret',SMTP_HOST='smtp.example.test',SMTP_USE_IMAP_CREDENTIALS=True,LLM_API_KEY='fake-model',LLM_MODEL='mock-model')
        key=system_settings._account_key(values['IMAP_HOST'],values['IMAP_USER'])
        registry={'accounts':{key:{'db_path':values['DB_PATH'],'user':values['IMAP_USER'],'visible':True,'credential_storage':'vault'}}}
        events=[]; result=[]; errors=[]
        model_started=threading.Event(); release=threading.Event(); smtp_finished=threading.Event()
        def slow_model(_):
            assert current.get()['ACCOUNT_ID']=='test-a','Worker lost the selected account'
            model_started.set(); assert release.wait(5)
            return {'ok':True}
        def progress(event):
            events.append(event)
            if event.get('type')=='check' and event['check']['id']=='smtp' and event['check']['status']=='pass': smtp_finished.set()
        def run():
            try:
                with use(values):result.append(system_settings.diagnostics(progress=progress))
            except BaseException as exc: errors.append(exc)
        with use(values):db.init_db()
        with patch.object(system_settings,'_load_registry',return_value=registry),patch.object(system_settings,'account_password',return_value='fake-secret'),patch.object(system_settings,'test_mail_connection',return_value={'ok':True,'folders':3}),patch.object(system_settings.smtp_client,'test_connection',return_value={'ok':True}),patch.object(system_settings.llm_client,'available',return_value=True),patch.object(system_settings,'test_model',side_effect=slow_model):
            worker=threading.Thread(target=run);worker.start()
            try:
                assert model_started.wait(3) and smtp_finished.wait(3)
                assert not any(e.get('type')=='check' and e['check']['id']=='model' and e['check']['status']=='pass' for e in events),'A slow check falsely completed'
                assert events[0]['type']=='plan' and len(events[0]['checks'])==9
            finally:release.set();worker.join(6)
            assert not worker.is_alive() and not errors,errors
            assert result[0]['ok']
            finished=[e['check']['id'] for e in events if e['type']=='check' and e['check']['status'] in ('pass','fail','warning')]
            assert len(finished)==len(set(finished))==len(result[0]['checks'])
        # HTTP stream pins the context and blocks a third concurrent run.
        entered=[]; finish=threading.Event()
        def fake_diagnostics(lang,progress):
            entered.append(current.get()['ACCOUNT_ID']); progress({'type':'plan','checks':[]})
            assert finish.wait(5)
            return {'ok':True,'checks':[]}
        with patch.object(system.system_settings,'diagnostics',side_effect=fake_diagnostics),use(values):
            first=system.api_system_diagnostic_stream();second=system.api_system_diagnostic_stream()
            try:
                try:system.api_system_diagnostic_stream();assert False
                except HTTPException as exc:assert exc.status_code==409
            finally:finish.set()
            assert collect(first)[-1]['type']=='done' and collect(second)[-1]['type']=='done'
            assert entered==['test-a','test-a']
        # Exceptions become an interruption, never a fabricated final success.
        with patch.object(system.system_settings,'diagnostics',side_effect=RuntimeError('fake-secret')),use(values):
            failure=collect(system.api_system_diagnostic_stream())
            assert failure[-1]['type']=='error' and 'fake-secret' not in str(failure)
    print('PASS incremental diagnostic completions, account context, concurrency limit and interrupted streams')
if __name__=='__main__':main()
