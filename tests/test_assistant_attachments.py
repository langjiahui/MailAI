"""Synthetic MIME files only: attachment extraction, explicit scope, limits and privacy."""
import asyncio
import io
import json
import sys
import tempfile
import zipfile
from types import SimpleNamespace
from email.message import EmailMessage
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from app import db, assistant_attachments as attachments, assistant_vision, mail_assistant
from app.account_context import use
from app.web import server


def office(path, text):
    data=io.BytesIO()
    with zipfile.ZipFile(data,'w') as z:z.writestr(path,text)
    return data.getvalue()


def pdf(encrypted=False):
    from pypdf import PdfWriter
    from pypdf.generic import DictionaryObject,NameObject,DecodedStreamObject
    writer=PdfWriter();page=writer.add_blank_page(width=400,height=300)
    font=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})
    page[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):writer._add_object(font)})})
    stream=DecodedStreamObject();stream.set_data(b'BT /F1 18 Tf 30 240 Td (Project ALPHA due Friday) Tj ET')
    page[NameObject('/Contents')]=writer._add_object(stream)
    if encrypted:writer.encrypt('fixture-password')
    out=io.BytesIO();writer.write(out);return out.getvalue()


def main():
    files=[('plan.csv','事项,负责人\n交付,项目组'.encode()),
           ('report.docx',office('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>交付截止周五</w:t></w:r></w:p></w:body></w:document>')),
           ('sheet.xlsx',office('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c r="A1" t="inlineStr"><is><t>项目金额</t></is></c><c r="B1"><v>100</v></c></row><row><c r="D2" t="inlineStr"><is><t>方君</t></is></c><c r="E2"><v>18621723095</v></c></row><row><c r="D3" t="inlineStr"><is><t>分管总监：方君</t></is></c><c r="E3"><v>13900000000</v></c></row></sheetData></worksheet>')),
           ('slides.pptx',office('ppt/slides/slide1.xml','<p:sld xmlns:p="p" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>项目汇报</a:t></p:sld>')),
           ('plan.pdf',pdf()),('locked.pdf',pdf(True)),('legacy.xls',b'not executable'),('long.txt',b'x'*18000)]
    with tempfile.TemporaryDirectory() as root:
        values=dict(ACCOUNT_ID='a',DB_PATH=str(Path(root)/'a.db'),IMAP_USER='a@example.test')
        with use(values):
            db.init_db();message=EmailMessage();message['Subject']='Project';message.set_content('Please compare attached delivery plan')
            for name,raw in files:message.add_attachment(raw,maintype='application',subtype='octet-stream',filename=name)
            path=Path(root)/'fixture.eml';path.write_bytes(message.as_bytes())
            eid=db.upsert_email(dict(uid=1,subject='交付计划',body_text='请确认附件交期',raw_path=str(path),attachments=[{'name':n,'size':len(b)} for n,b in files]))
            assert attachments.catalog(eid)['items'][6]['supported']
            samples=[attachments.extract(eid,i) for i in range(5)]
            for item,word in zip(samples,['交付','周五','B1:100','项目汇报','ALPHA']):assert word in item['text'],item
            assert attachments.extract(eid,7)['truncated']
            for index,digest in ((5,None),(6,None),(0,'0'*64),(99,None)):
                try:attachments.extract(eid,index,digest)
                except ValueError:pass
                else:raise AssertionError((index,digest))
            ref={k:samples[0][k] for k in ('email_id','index','digest')}
            try:attachments.prepare([ref,ref])
            except ValueError:pass
            else:raise AssertionError('Duplicate attachments accepted')
            # 用户明确加入对话的附件可把完整字段送公司内部模型，不沿用自动邮件脱敏。
            sheet=attachments.extract(eid,2,include_lookup=True)
            with patch.object(assistant_vision.client,'available',return_value=True), \
                 patch.object(assistant_vision.client,'chat_completion_stream',return_value=iter(['号码已找到【附件1】。'])) as private_model:
                list(assistant_vision.ask_stream('方君电话是多少',[],[eid],[],[sheet]))
                sent=json.dumps(private_model.call_args.args[0][-1]['content'],ensure_ascii=False)
                assert '18621723095' in sent and '[手机号]' not in sent
            with patch.object(assistant_vision.client,'available',return_value=True),patch.object(assistant_vision.client,'chat_completion_stream',return_value=iter(['附件要求交付【附件1】。'])) as model,patch.object(mail_assistant,'retrieve') as retrieve:
                request=server.AssistantRequest(question='总结附件',attachments=[ref])
                response=server.api_assistant_ask_stream(request)
                async def collect():return ''.join([s async for s in response.body_iterator])
                events=asyncio.run(collect());assert '"type": "done"' in events
                parts=model.call_args.args[0][-1]['content']
                assert '交付,项目组' in json.dumps(parts,ensure_ascii=False)
                assert request.email_ids==[eid]
                retrieve.assert_not_called()
                history=json.dumps(db.get_assistant_messages(db.list_assistant_conversations(1)[0]['id']),ensure_ascii=False)
                assert 'plan.csv' in history and '交付,项目组' not in history
            with db.conn() as c:c.execute('UPDATE emails SET remote_missing=1 WHERE id=?',(eid,))
            try:attachments.extract(eid,0)
            except ValueError:pass
            else:raise AssertionError('Removed mail accepted')
        with use(dict(ACCOUNT_ID='b',DB_PATH=str(Path(root)/'b.db'),IMAP_USER='b@example.test')):
            db.init_db()
            try:attachments.extract(eid,0)
            except ValueError:pass
            else:raise AssertionError('Cross-account attachment access')
    bomb=office('word/document.xml','<!DOCTYPE x [<!ENTITY a "injected">]><x>&a;</x>')
    try:attachments._office(bomb,'docx')
    except ValueError:pass
    else:raise AssertionError('DTD accepted')
    data=io.BytesIO()
    with zipfile.ZipFile(data,'w',compression=zipfile.ZIP_DEFLATED) as z:z.writestr('word/document.xml','x'*100000)
    try:attachments._office(data.getvalue(),'docx')
    except ValueError:pass
    else:raise AssertionError('Excessive ZIP expansion accepted')
    # 普通模型上下文仍限前 6 个工作表；本地精确查询可安全覆盖后续工作表。
    data=io.BytesIO()
    with zipfile.ZipFile(data,'w') as z:
        for number in range(1,8):
            value='后部人员' if number==7 else f'普通工作表{number}'
            z.writestr(f'xl/worksheets/sheet{number}.xml',f'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row><c r="A1" t="inlineStr"><is><t>{value}</t></is></c><c r="B1"><v>13812345678</v></c></row></sheetData></worksheet>')
    normal=attachments._office(data.getvalue(),'xlsx')[0]
    expanded=attachments._office(data.getvalue(),'xlsx',expanded=True)[0]
    assert '后部人员' not in normal and '后部人员' in expanded
    focused=attachments.model_text('后部人员电话是多少',{'text':normal,'lookup_text':expanded})
    assert '后部人员' in focused and '13812345678' in focused
    # Legacy XLS is read through xlrd as bounded, saved cell values only.
    class Cell:
        def __init__(self, value, ctype=1):self.value=value;self.ctype=ctype
    class Sheet:
        name='项目奖清单';nrows=2;ncols=2
        def cell(self,row,column):return [[Cell('姓名'),Cell('奖金')],[Cell('陈乐媛'),Cell(100,2)]][row][column]
    class Book:
        nsheets=1;datemode=0
        def sheet_by_index(self,index):return Sheet()
        def release_resources(self):pass
    fake_xlrd=SimpleNamespace(
        open_workbook=lambda **kwargs:Book(), XL_CELL_DATE=3, XL_CELL_BOOLEAN=4,
        XL_CELL_EMPTY=0, XL_CELL_BLANK=6, xldate_as_datetime=lambda value,datemode:value,
    )
    with patch.dict(sys.modules,{'xlrd':fake_xlrd}):
        legacy_text,legacy_note=attachments._legacy_xls(b'legacy fixture')
    assert '陈乐媛' in legacy_text and '100' in legacy_text and '不执行宏' in legacy_note
    print('Attachment formats, encrypted/unsupported/stale inputs, scope, history privacy and account isolation passed')


if __name__=='__main__':main()
