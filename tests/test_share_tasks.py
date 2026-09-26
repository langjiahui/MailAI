"""Durable local uploads: restart, account isolation, idempotence, cleanup."""
import asyncio
from pathlib import Path
import sys
import tempfile
import threading
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import config, db, share_tasks, share_storage

class Request:
    headers = {'content-length':'7', 'x-mailai-filename':'report.zip'}
    async def stream(self):
        yield b'payload'

async def scenario(root):
    with patch.object(config, 'DB_PATH', str(Path(root)/'a.db')):
        db.init_db()
        draft = db.save_draft({'subject':'draft', 'body_html':'<p>test</p>'})
        task = await share_tasks.stage(Request(), draft, 7)
        token = task['id']
        assert (share_tasks._path(token)/'file').read_bytes() == b'payload'
        with patch.object(share_storage, '_upload_file', side_effect=RuntimeError('offline')):
            try: await share_tasks.upload(token)
            except RuntimeError: pass
            else: raise AssertionError('failure was hidden')
        assert share_tasks.list_tasks(draft)[0]['state'] == 'failed'
        path = share_tasks._path(token)
        row = share_tasks._read(path);row['state']='uploading';share_tasks._write(path,row)
        assert share_tasks.list_tasks(draft)[0]['state'] == 'failed', 'restart should expose retry'
        with patch.object(config, 'DB_PATH', str(Path(root)/'b.db')):
            db.init_db(); other = db.save_draft({'subject':'other'})
            assert share_tasks.list_tasks(other) == []
            try: await share_tasks.upload(token)
            except ValueError: pass
            else: raise AssertionError('cross-account task read')
        result={'url':'https://example.test/file','name':'report.zip','expires_at':'2099-01-01T00:00:00Z'}
        with patch.object(share_storage, '_upload_file', return_value=result) as upload:
            assert await share_tasks.upload(token) == result
            assert await share_tasks.upload(token) == result
            assert upload.call_count == 1, 'retry must reuse completed result'
            assert upload.call_args.kwargs['object_id'] == token
        interrupted = await share_tasks.stage(Request(), draft, 7)
        entered, release = threading.Event(), threading.Event()
        def slow_upload(*args, **kwargs):
            entered.set(); release.wait(3); return result
        with patch.object(share_storage, '_upload_file', side_effect=slow_upload):
            job = asyncio.create_task(share_tasks.upload(interrupted['id']))
            while not entered.is_set(): await asyncio.sleep(.01)
            try: share_tasks.remove(interrupted['id'])
            except share_storage.UploadBusyError: pass
            else: raise AssertionError('removed an in-flight upload')
            job.cancel()
            try: await job
            except asyncio.CancelledError: pass
            release.set()
            while share_tasks._workers: await asyncio.sleep(.01)
        assert next(row for row in share_tasks.list_tasks(draft) if row['id'] == interrupted['id'])['state'] == 'done'
        share_tasks.remove_draft(draft)
        assert not path.exists()
        class Broken(Request):
            async def stream(self): yield b'bad'
        try: await share_tasks.stage(Broken(), draft, 7)
        except ValueError: pass
        else: raise AssertionError('accepted truncated file')
        assert list(share_tasks._root().iterdir()) == []
        try: share_tasks.remove('../outside')
        except ValueError: pass
        else: raise AssertionError('accepted path traversal')

with tempfile.TemporaryDirectory() as root:
    asyncio.run(scenario(root))
print('Durable share tasks: local persistence, restart, account isolation, retry and cleanup passed')
