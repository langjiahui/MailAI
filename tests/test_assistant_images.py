"""Offline image validation, explicit mail scope and failure/privacy checks."""
import asyncio
import base64
import io
import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch
from PIL import Image, PngImagePlugin
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import assistant_vision as vision, mail_assistant, db, config
from app.account_context import use
from app.web import server
from fastapi import HTTPException


def picture():
    output=io.BytesIO(); meta=PngImagePlugin.PngInfo();meta.add_text('Private','should disappear')
    Image.new('RGB',(32,24),'white').save(output,format='PNG',pnginfo=meta)
    return {'data_url':'data:image/png;base64,'+base64.b64encode(output.getvalue()).decode()}


def main():
    raw=picture();images=vision.prepare([raw])
    assert len(images)==1 and images[0]['data_url'].startswith('data:image/jpeg;')
    normalized=base64.b64decode(images[0]['data_url'].split(',')[1])
    assert b'should disappear' not in normalized
    # A real 21 MP screenshot, not only a mocked lower limit: shrink before
    # creating RGBA/EXIF copies and strip metadata from the outgoing payload.
    long_output = io.BytesIO()
    with Image.new('RGB', (1500, 14000), 'white') as source:
        source.save(long_output, format='PNG')
    long_image = vision.prepare([{'data_url':'data:image/png;base64,' + base64.b64encode(long_output.getvalue()).decode()}])[0]
    with Image.open(io.BytesIO(base64.b64decode(long_image['data_url'].split(',')[1]))) as image:
        assert max(image.size) == vision.NORMALIZED_EDGE and image.width > 0
    with patch.object(vision,'NORMALIZED_EDGE',16):
        resized=vision.prepare([raw])[0]
        with Image.open(io.BytesIO(base64.b64decode(resized['data_url'].split(',')[1]))) as image:
            assert image.size==(16,12)
    with patch.object(vision,'MAX_PIXELS',100):
        try:vision.prepare([raw])
        except ValueError as exc:assert '安全处理范围' in str(exc)
        else:raise AssertionError('Oversized source image accepted')
    with patch.object(vision,'MAX_TOTAL_PIXELS',1000):
        try:vision.prepare([raw,raw])
        except ValueError as exc:assert '总尺寸过大' in str(exc)
        else:raise AssertionError('Oversized image batch accepted')
    for invalid in ([raw]*4,[{'data_url':'https://example.test/private.png'}],
                    [{'data_url':'data:image/svg+xml;base64,PHN2Zz4='}],
                    [{'data_url':'data:image/png;base64,YWJj'}],
                    [{'data_url':'data:image/png;base64,'+'A'*(vision.MAX_BYTES*4//3+101)}]):
        try:vision.prepare(invalid)
        except ValueError:pass
        else:raise AssertionError('Unsafe image input accepted')
    captured=[]
    def stream(messages,**kwargs):
        captured.append((messages,kwargs));yield '截图显示项目待确认【图片1】，请核对时间。'
    with tempfile.TemporaryDirectory() as root, use(dict(ACCOUNT_ID='a',DB_PATH=str(Path(root)/'a.db'),IMAP_USER='a@example.test')):
        db.init_db()
        eid=db.upsert_email(dict(uid=1,subject='项目排期',body_text='请周五确认'))
        with patch.object(vision.client,'available',return_value=True),patch.object(vision.client,'chat_completion_stream',side_effect=stream),patch.object(mail_assistant,'retrieve') as retrieve:
            result=mail_assistant.ask('看图',images=images)
            assert not result['sources'] and '【图片1】' in result['answer']
            retrieve.assert_not_called()
            content=captured[-1][0][-1]['content']
            assert any(p['type']=='image_url' for p in content)
            assert captured[-1][1]['model']==config.MULTIMODAL_MODEL
            assert '不可信' in captured[-1][0][0]['content']
            result=mail_assistant.ask('请对照',email_ids=[eid],images=images)
            assert result['sources'][0]['id']==eid
            payload=server.AssistantRequest(question='看图',images=[raw])
            response=server.api_assistant_ask_stream(payload)
            async def consume():
                return ''.join([chunk async for chunk in response.body_iterator])
            output=asyncio.run(consume());assert '"type": "done"' in output
            history=json.dumps(db.get_assistant_messages(db.list_assistant_conversations(1)[0]['id']),ensure_ascii=False)
            assert '本次附图' not in history and 'data:image' not in history and raw['data_url'] not in history
            saved = db.get_assistant_messages(db.list_assistant_conversations(1)[0]['id'])[0]
            assert saved['content']=='看图' and len(saved['images'])==1
            image_id=int(saved['images'][0]['url'].rsplit('/',1)[1])
            preview=server.api_assistant_image(image_id)
            assert preview.body==base64.b64decode(raw['data_url'].split(',')[1])
            assert preview.headers['cache-control']=='no-store'
            with Image.open(io.BytesIO(server.api_assistant_image(image_id,True).body)) as thumb:
                assert max(thumb.size)<=320
            # Reads survive fresh SQLite connections and cannot escape account scope.
            with use(dict(ACCOUNT_ID='b',DB_PATH=str(Path(root)/'b.db'),IMAP_USER='b@example.test')):
                db.init_db()
                try:server.api_assistant_image(image_id)
                except HTTPException as exc:assert exc.status_code==404
                else:raise AssertionError('Cross-account image leaked')
            assert db.get_assistant_image(image_id)
            sync=server.api_assistant_ask(server.AssistantRequest(question='再次看图',images=[raw,raw]))
            assert len(db.get_assistant_messages(sync['conversation_id'])[0]['images'])==2
            with db.conn() as c:c.execute('DELETE FROM assistant_messages WHERE id=?',(saved['id'],))
            assert db.get_assistant_image(image_id) is None
            count=len(db.list_assistant_conversations(50))
            try:server.api_assistant_ask_stream(server.AssistantRequest(question='坏图',images=[{'data_url':'data:image/png;base64,YWJj'}]))
            except HTTPException as exc:assert exc.status_code==400
            else:raise AssertionError('Invalid image created a conversation')
            assert len(db.list_assistant_conversations(50))==count
        with patch.object(vision.client,'available',return_value=False):
            try:server.api_assistant_ask_stream(server.AssistantRequest(question='看图',images=[raw]))
            except HTTPException as exc:assert '图片未发送' in exc.detail
            else:raise AssertionError('Unconfigured model must fail before history writes')
        with patch.object(vision.client,'available',return_value=True),patch.object(vision.client,'chat_completion_stream',return_value=iter([])),patch.object(vision.client,'chat_completion',return_value=None):
            try:mail_assistant.ask('看图',images=images)
            except vision.ImageAnalysisError:pass
            else:raise AssertionError('Model failure must not pretend image was analyzed')
    client_source=(Path(__file__).parent.parent/'app/web/static/assistant-images.js').read_text()
    assert 'function imageSize' in client_source and '64000000' in client_source and '将在发送时自动优化尺寸' in client_source
    print('Assistant images: validation, bounded thumbnails, persistent original previews, account isolation, cleanup, both APIs and failure checks passed')


if __name__=='__main__':main()
