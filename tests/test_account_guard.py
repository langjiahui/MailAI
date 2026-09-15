"""Concurrent requests and streaming responses pin the active account."""
import asyncio
import sys
import threading
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.account_guard import AccountGuard, AccountGuardMiddleware, guard, start_account_thread
from app import config


async def check_stream():
    started, finish = asyncio.Event(), asyncio.Event()
    async def app(scope, receive, send):
        await send({'type': 'http.response.start', 'status': 200, 'headers': []})
        started.set()
        await finish.wait()
        await send({'type': 'http.response.body', 'body': b'done'})
    messages = []
    async def send(message):
        messages.append(message)
    async def receive():
        return {'type': 'http.request'}
    task = asyncio.create_task(AccountGuardMiddleware(app)(
        {'type': 'http', 'path': '/api/assistant/chat'}, receive, send))
    await started.wait()
    assert not guard.acquire(True), 'Stream headers must not release the lease'
    rejected = []
    async def rejection(message):
        rejected.append(message)
    await AccountGuardMiddleware(app)({'type': 'http', 'path': '/api/system/mail/switch'}, receive, rejection)
    assert rejected[0]['status'] == 409
    finish.set()
    await task
    assert guard.acquire(True)
    guard.release(True)


async def check_logged_out_privacy():
    calls = []
    async def app(scope, receive, send):
        calls.append(scope['path'])
        await send({'type': 'http.response.start', 'status': 200, 'headers': []})
        await send({'type': 'http.response.body', 'body': b'ok'})
    async def receive(): return {'type': 'http.request'}
    async def invoke(path):
        messages = []
        async def send(message): messages.append(message)
        await AccountGuardMiddleware(app)({'type':'http', 'path':path}, receive, send)
        return messages[0]['status']
    with patch.object(config, 'IMAP_USER', ''), patch.object(config, 'IMAP_PASSWORD', ''):
        assert await invoke('/api/emails') == 401
        assert await invoke('/api/todos') == 401
        assert await invoke('/api/assistant/conversations') == 401
        assert await invoke('/api/system/backups') == 401
        assert await invoke('/api/system/config') == 200
        assert await invoke('/api/system/mail/login') == 200
        assert await invoke('/api/system/mail/switch') == 200
        assert calls == ['/api/system/config', '/api/system/mail/login', '/api/system/mail/switch']


def main():
    local = AccountGuard()
    assert local.acquire() and local.acquire()
    assert not local.acquire(True)
    local.release()
    local.release()
    assert local.acquire(True)
    assert not local.acquire()
    local.release(True)
    # Streaming lease behavior must not depend on the developer's current .env login state.
    with patch.object(config, 'IMAP_USER', 'test@example.test'), \
         patch.object(config, 'IMAP_PASSWORD', 'secret'):
        asyncio.run(check_stream())
    asyncio.run(check_logged_out_privacy())
    async def check_scoped_resources():
        from app.account_context import current
        async def app(scope, receive, send):
            await asyncio.sleep(0)
            assert config.IMAP_USER == 'second@example.test'
            assert config.DB_PATH == 'second.db'
            await send({'type':'http.response.start','status':200,'headers':[]})
            await send({'type':'http.response.body','body':b'ok'})
        async def receive(): return {'type':'http.request'}
        for path, headers, query in [('/api/emails/1', [(b'x-mailai-account',b'second')], b''),
                                    ('/api/emails/1/attachments/0', [], b'mailai_account=second'),
                                    ('/api/system/backups', [(b'x-mailai-account',b'second')], b'')]:
            messages = []
            async def send(message): messages.append(message)
            with patch('app.account_context.snapshot', return_value={'ACCOUNT_ID':'second','DB_PATH':'second.db','IMAP_USER':'second@example.test'}):
                await AccountGuardMiddleware(app)({'type':'http','method':'GET','path':path,'headers':headers,'query_string':query},receive,send)
            assert messages[0]['status'] == 200
            assert current.get() is None
    asyncio.run(check_scoped_resources())
    # Login holds exclusive configuration access. A scheduled worker must wait
    # for its completion but already prevent the following account switch.
    assert guard.acquire(True)
    entered, finish = threading.Event(), threading.Event()
    def work():
        entered.set()
        assert finish.wait(3)
    worker = start_account_thread(work)
    assert not entered.is_set()
    guard.release(True)
    assert entered.wait(3)
    assert not guard.acquire(True), 'Queued/running work must pin its scheduling account'
    finish.set()
    worker.join(3)
    assert not worker.is_alive()
    assert guard.acquire(True)
    guard.release(True)
    with patch('app.account_guard.threading.Thread.start', side_effect=RuntimeError('start failed')):
        try:
            start_account_thread(lambda: None)
        except RuntimeError:
            pass
        else:
            raise AssertionError('Expected startup failure')
    assert guard.acquire(True), 'Failed thread startup must release its reservation'
    guard.release(True)
    print('Account parallel operations, switch rejection and full stream lifetime passed')


if __name__ == '__main__':
    main()
