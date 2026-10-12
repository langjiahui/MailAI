"""Digest completion, fallback and atomic replacement without live model/mail access."""
import asyncio
import io
import json
import logging
from pathlib import Path
import sqlite3
import sys
import tempfile
from datetime import date, datetime
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app import config,db,pipeline
from app.account_context import use
from app.llm import analyze,client
from app.web.routes import reports

async def events():
    response=reports.api_digest_stream()
    return [json.loads(line) async for line in response.body_iterator]

def main():
    items=[dict(email_id=1,date=datetime.now().isoformat(),subject='fixture',summary='fixture summary',todos=[])]
    def interrupted(*args,**kwargs):
        assert kwargs['require_completion'] is True
        yield 'incomplete'
        raise RuntimeError('fixture disconnect')
    with patch.object(client,'available',return_value=True),patch.object(client,'chat_completion_stream',side_effect=interrupted),patch.object(logging.Logger,'exception'):
        stream=analyze.daily_digest_stream(items)
        assert next(stream)=='incomplete'
        try:next(stream)
        except RuntimeError:pass
        else:raise AssertionError('Partial model output was accepted as complete')
    with patch.object(client,'available',return_value=False):
        assert '本地兜底' in ''.join(analyze.daily_digest_stream(items))
    # The actual SSE client must reject a token stream lacking a completion marker.
    body=io.BytesIO(b'data: {"choices":[{"delta":{"content":"partial"}}]}\n')
    with patch.object(client,'available',return_value=True),patch.object(client.urllib.request,'urlopen',return_value=body),patch.object(client.usage,'record'),patch.object(logging.Logger,'exception'):
        stream=analyze.daily_digest_stream(items);assert next(stream)=='partial'
        try:next(stream)
        except RuntimeError:pass
        else:raise AssertionError('Disconnected model stream accepted')
    with tempfile.TemporaryDirectory() as temp,patch.object(config,'DATA_DIR',temp),use(dict(ACCOUNT_ID='digest-fixture',DB_PATH=str(Path(temp)/'mailai.db'),IMAP_USER='fixture@example.test')):
        db.init_db();today=date.today().isoformat();old=db.save_digest('saved report',today)
        def partial():
            yield 'partial report'
            raise RuntimeError('fixture interruption')
        with patch.object(pipeline,'today_digest_stream',side_effect=partial),patch.object(logging.Logger,'exception'):
            output=asyncio.run(events())
            assert [entry['type'] for entry in output]==['delta','error']
            assert db.get_digest(old)['content']=='saved report'
        # Fail the insert after the same-date delete; transaction restores the old report.
        with db.conn() as connection:
            connection.execute("CREATE TRIGGER reject_digest BEFORE INSERT ON digest_history BEGIN SELECT RAISE(ABORT,'fixture insert failure'); END")
        with patch.object(pipeline,'today_digest_stream',return_value=iter(['new report'])),patch.object(logging.Logger,'exception'):
            output=asyncio.run(events());assert output[-1]['type']=='error'
            assert db.get_digest(old)['content']=='saved report'
        with patch.object(pipeline,'today_digest',return_value='new report'):
            try:reports.api_digest()
            except sqlite3.DatabaseError:pass
            else:raise AssertionError('Failed replacement accepted')
            assert db.get_digest(old)['content']=='saved report'
        with db.conn() as connection:connection.execute('DROP TRIGGER reject_digest')
        with patch.object(pipeline,'today_digest_stream',return_value=iter(['complete ','report'])):
            output=asyncio.run(events());assert output[-1]==dict(type='done',digest='complete report')
            rows=db.list_digests();assert len(rows)==1
            assert db.get_digest(rows[0]['id'])['content']=='complete report'
    print('Digest recovery: model completion required, local fallback, partial output preserves old report, failed inserts roll back, complete reports replace atomically passed')

if __name__=='__main__':main()
