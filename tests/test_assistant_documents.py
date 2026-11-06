"""Real synthetic PDFs: tail coverage, scan rendering, native bytes and saved scope."""
import base64
import io
import json
import tempfile
from email.message import EmailMessage
from pathlib import Path
from unittest.mock import patch
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from app import config, db, assistant_documents as documents, assistant_vision, system_settings
from app.account_context import use
from app.web.routes import assistant
from app.web.schemas import AssistantRequest


def pdf(pages, text=True):
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>',
        f'<< /Type /Pages /Count {pages} /Kids [{" ".join(f"{4+i*2} 0 R" for i in range(pages))}] >>'.encode(),
        b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
    for index in range(pages):
        objects.append(f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 180] /Resources << /Font << /F1 3 0 R >> >> /Contents {5+index*2} 0 R >>'.encode())
        stream=f'BT /F1 18 Tf 20 100 Td (PAGE_{index+1}_END) Tj ET'.encode() if text else b''
        objects.append(f'<< /Length {len(stream)} >>\nstream\n'.encode()+stream+b'\nendstream')
    raw=b'%PDF-1.4\n';offsets=[0]
    for i,obj in enumerate(objects,1):
        offsets.append(len(raw));raw+=f'{i} 0 obj\n'.encode()+obj+b'\nendobj\n'
    xref=len(raw);raw+=f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode()
    raw+=b''.join(f'{o:010} 00000 n \n'.encode() for o in offsets[1:])
    return raw+f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF'.encode()


def main():
    with tempfile.TemporaryDirectory() as root, use({'ACCOUNT_ID':'files','DB_PATH':str(Path(root)/'mail.db'),'IMAP_USER':'work@example.test'}), patch.multiple(config,LLM_API_KEY='fixture',LLM_BASE_URL='https://old.example.test/v1',LLM_PROVIDER='custom',LLM_MODEL='text-fixture',MULTIMODAL_MODEL='vision-fixture',MULTIMODAL_ENABLED=False,DOCUMENT_INPUT_MODE='text'):
        db.init_db();raw=pdf(25);scan=pdf(3,False)
        message=EmailMessage();message.set_content('请核对项目文件')
        for name,data in [('report.pdf',raw),('scan.pdf',scan)]:message.add_attachment(data,maintype='application',subtype='pdf',filename=name)
        path=Path(root)/'mail.eml';path.write_bytes(message.as_bytes())
        email_id=db.upsert_email({'uid':1,'subject':'项目资料','body_text':'请核对项目文件','raw_path':str(path),'attachments':[{'name':'report.pdf','size':len(raw)},{'name':'scan.pdf','size':len(scan)}]})
        ref=documents.reference(email_id,0);assert ref['page_count']==25 and ref['reading']=='text'
        refs=[{k:ref[k] for k in ('email_id','index','digest')}]
        materials=documents.prepare(refs)
        assert 'PAGE_25_END' in materials[0]['text'] and not materials[0]['truncated']
        assert '全部 25 页' in materials[0]['note']
        try:documents.prepare([{**refs[0],'digest':'0'*64}])
        except ValueError:pass
        else:raise AssertionError('Stale file accepted')
        try:documents.prepare([{**refs[0],'index':1,'digest':documents.reference(email_id,1)['digest']}])
        except ValueError as e:assert '没有可提取文字' in str(e)
        else:raise AssertionError('Blank scan certified as readable text')
        with patch.object(config,'DOCUMENT_INPUT_MODE','native_pdf'):
            native=documents.prepare(refs)
            config.LLM_BASE_URL='https://new.example.test/v1'
            with patch.object(assistant_vision.client,'chat_completion_stream',return_value=iter(['文件已核对【附件1】'])) as model:
                list(assistant_vision.ask_stream('核对文件',[],[email_id],[],native))
            parts=model.call_args.args[0][-1]['content'];file=next(p['file'] for p in parts if p['type']=='file')
            assert base64.b64decode(file['file_data'].split(',',1)[1])==raw
            assert model.call_args.kwargs['model']=='vision-fixture'
            assert model.call_args.kwargs['base_url']=='https://old.example.test/v1'
            config.LLM_BASE_URL='https://old.example.test/v1'
        with patch.multiple(config,DOCUMENT_INPUT_MODE='auto',MULTIMODAL_ENABLED=True):
            scan_ref=documents.reference(email_id,1);assert scan_ref['reading']=='pages'
            scan_material=documents.prepare([{k:scan_ref[k] for k in ('email_id','index','digest')}])
            calls=[]
            def read(messages,**kwargs):
                calls.append((messages,kwargs));config.LLM_BASE_URL='https://new.example.test/v1'
                return {'choices':[{'message':{'content':'文件中可见的信息和页码。'},'finish_reason':'stop'}]}
            with patch.object(documents.client if hasattr(documents,'client') else assistant_vision.client,'chat_completion',side_effect=read):
                events=list(documents.read_for_question('分析扫描件',scan_material,scan_material[0]['_connection']))
            assert len(calls)==2 and len(events)==2
            assert sum(p['type']=='image_url' for messages,_ in calls for p in messages[-1]['content'])==3
            assert all(kwargs['base_url']=='https://old.example.test/v1' for _,kwargs in calls)
            assert '第 3–3 页' in scan_material[0]['text']
        config.LLM_BASE_URL='https://old.example.test/v1'
        # Sending saves only valid references; reopening lets the client re-read on follow-up.
        with patch.object(assistant_vision.client,'chat_completion_stream',return_value=iter(['文件内容已核对【附件1】'])):
            first=assistant.api_assistant_ask(AssistantRequest(question='总结文件',attachments=refs))
        conversation=first['conversation_id'];saved=assistant.api_assistant_conversation(conversation)
        assert saved['attachments'][0]['digest']==ref['digest']
        assert 'PAGE_25_END' not in json.dumps(saved,ensure_ascii=False)
        assert 'file_data' not in json.dumps(saved) and 'fixture' not in json.dumps(db.get_assistant_attachment_refs(conversation))
        assistant.api_assistant_attachment_refs(conversation,{'attachments':[]})
        assert assistant.api_assistant_conversation(conversation)['attachments']==[]
        with use({'ACCOUNT_ID':'other','DB_PATH':str(Path(root)/'other.db')}):
            db.init_db();assert db.get_assistant_attachment_refs(conversation)==[]
        # A 200/OK response that ignores the PDF must not pass capability validation.
        connection={'base_url':'https://fixture.example.test/v1','api_key':'fixture','provider':'custom','verify_ssl':True,'extra_params':{}}
        from app.llm import client
        with patch.object(client,'chat_completion',return_value={'choices':[{'message':{'content':'OK'}}]}):
            try:documents.test_native_pdf(connection,'fixture')
            except ValueError:pass
            else:raise AssertionError('API ignored PDF but passed its capability probe')
        def echo_document(messages,**kwargs):
            from pypdf import PdfReader
            data=next(p['file']['file_data'] for p in messages[0]['content'] if p['type']=='file')
            text=PdfReader(io.BytesIO(base64.b64decode(data.split(',',1)[1]))).pages[0].extract_text()
            return {'choices':[{'message':{'content':text}}]}
        with patch.object(client,'chat_completion',side_effect=echo_document):documents.test_native_pdf(connection,'fixture')
        resolved=system_settings._model_values({**connection,'model':'fixture','document_input_mode':'native_pdf'})
        assert resolved['document_input_mode']=='native_pdf'
        assert system_settings._model_fingerprint(resolved)!=system_settings._model_fingerprint({**resolved,'document_input_mode':'auto'})
        credentials={}
        with patch.object(config,'DATA_DIR',str(Path(root)/'profiles')), patch.object(system_settings,'_persist'), \
             patch.object(system_settings.credential_store,'save',side_effect=lambda key,value:credentials.setdefault(key,value) is not None), \
             patch.object(system_settings.credential_store,'load',side_effect=lambda key:credentials.get(key,'')):
            system_settings.save_model({**connection,'provider':'custom','model':'internal','document_input_mode':'text'})
            system_settings.save_model({**connection,'provider':'other','base_url':'https://cloud.example.test/v1','model':'cloud','document_input_mode':'native_pdf'})
            system_settings.save_model({'provider':'custom'})
            assert config.DOCUMENT_INPUT_MODE=='text' and config.LLM_MODEL=='internal'
            system_settings.save_model({'provider':'other'})
            assert config.DOCUMENT_INPUT_MODE=='native_pdf' and config.LLM_MODEL=='cloud'

    print('PASS complete PDF tail, scanned pages, original PDF bytes, pinned provider, saved file context, stale/account guards and native capability proof')


if __name__=='__main__':main()
