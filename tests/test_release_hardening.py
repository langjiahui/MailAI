"""Offline release regressions: local browser trust, backup rollback, trial config."""
import asyncio
import io
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch
from dotenv import dotenv_values
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import config, db, system_settings
from app.account_context import use
from app.web.origin_guard import LocalOriginMiddleware
from scripts.prepare_bundle_config import bundle_values, write_config


async def origin_checks():
    async def target(scope, receive, send):
        await send({'type': 'http.response.start', 'status': 200, 'headers': []})
        await send({'type': 'http.response.body', 'body': b'ok'})
    middleware = LocalOriginMiddleware(target)
    async def check(extra, status, host='127.0.0.1:18795', path='/api/mail/send'):
        messages = []
        async def send(message): messages.append(message)
        async def receive(): return {'type': 'http.request', 'body': b''}
        await middleware({'type': 'http', 'scheme': 'http', 'path': path,
                          'headers': [(b'host', host.encode()), *[(k.encode(), v.encode()) for k, v in extra.items()]]}, receive, send)
        assert messages[0]['status'] == status, (extra, messages)
        if status == 200 and path.startswith('/api/'):
            assert (b'cache-control', b'no-store') in messages[0]['headers']
    await check({}, 200)  # Native/local clients without browser metadata.
    await check({'origin':'http://127.0.0.1:18795', 'sec-fetch-site':'same-origin'}, 200)
    await check({'referer':'http://127.0.0.1:18795/'}, 200)
    await check({'origin':'https://outside.example'}, 403)
    await check({'origin':'http://127.0.0.1:1234'}, 403)
    await check({'origin':'null'}, 403)
    await check({'origin':'http://user@127.0.0.1:18795'}, 403)
    await check({'origin':'http://127.0.0.1:bad'}, 403)
    await check({'sec-fetch-site':'cross-site'}, 403)
    await check({'sec-fetch-site':'same-site'}, 403)
    await check({}, 403, host='attacker.example:18795')
    await check({'sec-fetch-site':'cross-site'}, 200, path='/')
    await check({'origin':'http://[::1]:18795'}, 200, host='[::1]:18795')


def backup_checks():
    with tempfile.TemporaryDirectory() as root, use(dict(ACCOUNT_ID='release-fixture', DB_PATH=str(Path(root)/'mail.db'),
            DATA_DIR=root, RAW_DIR=str(Path(root)/'raw'), IMAP_USER='release@example.test', IMAP_HOST='imap.example.test')):
        db.init_db()
        raw = Path(config.RAW_DIR); raw.mkdir()
        backup = system_settings.create_backup(include_raw=True)  # Empty full backup.
        original = raw / 'keep.eml'; original.write_bytes(b'original raw message')
        eid = db.upsert_email(dict(uid=1, subject='preserve me', raw_path=str(original)))
        real_replace = system_settings.os.replace
        def fail_install(source, target):
            if str(source).endswith('staged-raw') and str(target) == config.RAW_DIR:
                raise OSError('simulated rename failure after original moved')
            return real_replace(source, target)
        with patch.object(system_settings.os, 'replace', side_effect=fail_install):
            try: system_settings.restore_backup(backup['filename'])
            except OSError: pass
            else: raise AssertionError('Expected restore failure')
        assert original.read_bytes() == b'original raw message'
        assert db.get_email(eid)['subject'] == 'preserve me'
        # A successful empty full restore intentionally restores the empty state;
        # the pre-restore safety snapshot must retain the previous content.
        result = system_settings.restore_backup(backup['filename'])
        assert raw.is_dir() and not list(raw.iterdir())
        assert db.get_email(eid) is None
        system_settings.restore_backup(result['safety_backup'])
        assert original.read_bytes() == b'original raw message'
        assert db.get_email(eid)['subject'] == 'preserve me'


def bundle_checks():
    source = {'LLM_API_KEY':'fixture-secret', 'IMAP_PASSWORD':'never-bundle',
              'LLM_MODEL':"model # one 'quoted' \\ path\nsecond line", 'LLM_EXTRA_PARAMS':'{"enable_thinking":false}', 'ACTION_MODE':'auto'}
    ordinary = bundle_values(source)
    assert 'LLM_API_KEY' not in ordinary and 'IMAP_PASSWORD' not in ordinary
    assert ordinary['ACTION_MODE'] == 'observe'
    trial = bundle_values(source)
    assert 'LLM_API_KEY' not in trial and 'IMAP_PASSWORD' not in trial
    with tempfile.TemporaryDirectory() as root:
        target = Path(root)/'defaults.env'; write_config(target, trial)
        assert dict(dotenv_values(target)) == trial


if __name__ == '__main__':
    asyncio.run(origin_checks()); backup_checks(); bundle_checks()
    print('Release hardening passed: local origins, backup rollback and no bundled credentials')
