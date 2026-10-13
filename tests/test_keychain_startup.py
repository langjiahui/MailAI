"""Multi-account startup and HTTP prompt scopes; all credentials are fixtures."""
import asyncio
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import config, credential_store as store, macos_keychain, macos_credential_vault, system_settings
from app.account_guard import AccountGuardMiddleware


class StartupTests(unittest.TestCase):
    def setUp(self):
        for cache in (store._session_cache, store._quiet_unavailable, store._authorization_required, store._master_blocked):
            cache.clear()
            self.addCleanup(cache.clear)
        for name,value in [('get',(macos_keychain.NOT_FOUND,'')),('put',True),('unlocked',False)]:
            mocker=patch.object(macos_credential_vault,name,return_value=value)
            mocker.start();self.addCleanup(mocker.stop)
        self.platform = patch.object(store.platform, 'system', return_value='Darwin')
        self.platform.start()
        self.addCleanup(self.platform.stop)

    def test_first_startup_authorizes_only_preferred_mailbox(self):
        calls = []
        def read(service, key, *, interactive=False):
            calls.append((key, interactive))
            return (0, 'fixture-' + key) if interactive else (-25308, '')
        with tempfile.TemporaryDirectory() as folder:
            accounts = {key: dict(host='imap.example.test', user=key+'@example.test',
                                 db_path=str(Path(folder)/f'{key}.db'), raw_dir=str(Path(folder)/key))
                        for key in ('first', 'preferred', 'third')}
            registry = {'accounts':accounts, 'last_account':'preferred'}
            # Restore every mutated config attribute afterward.
            changes = {key:getattr(config, key) for key in dir(config) if key.isupper()}
            with patch.multiple(config, **changes), \
                 patch.object(system_settings, '_load_registry', return_value=registry), \
                 patch.object(system_settings, '_save_registry'), \
                 patch.object(system_settings, '_activate_storage'), \
                 patch.object(system_settings, '_persist'), \
                 patch.object(macos_keychain, 'read_for_app', side_effect=read):
                config.IMAP_USER = config.IMAP_PASSWORD = ''
                system_settings.initialize_current_account()
                # FastAPI's startup hook also restores the active account.
                system_settings.initialize_current_account()
                self.assertEqual(config.IMAP_USER, 'preferred@example.test')
                for _ in range(4):
                    public = system_settings.public_config()
                    # Other services' status reads must not ask at startup.
                    store.load('cos-share:first')
                    store.load('remote-dingtalk:fixture')
                    store.load('model-profile:fixture')
                self.assertEqual([key for key, interactive in calls if interactive], ['preferred'])
                by_id = {row['id']:row for row in public['accounts']}
                self.assertTrue(by_id['preferred']['credential_available'])
                self.assertFalse(by_id['preferred']['credential_authorization_required'])
                self.assertTrue(by_id['first']['credential_authorization_required'])
                self.assertTrue(by_id['third']['credential_authorization_required'])
                self.assertNotIn('fixture-preferred', str(public))
                # Selecting one mailbox unlocks only it, even though the
                # response status lists every saved account.
                with store.prompt_policy(True):
                    system_settings.remember_mail_account('third')
                    public = system_settings.public_config()
                self.assertEqual([key for key, interactive in calls if interactive], ['preferred','third'])
                by_id = {row['id']:row for row in public['accounts']}
                self.assertTrue(by_id['third']['credential_available'])
                self.assertTrue(by_id['first']['credential_authorization_required'])

    def test_canceled_preferred_account_does_not_prompt_other_accounts(self):
        calls = []
        def read(service, key, *, interactive=False):
            calls.append((key, interactive))
            return (-128 if interactive else -25308), ''
        registry = {'last_account':'a', 'accounts':{key:dict(user=key+'@example.test',host='imap.example.test') for key in ('a','b','c')}}
        with patch.object(config, 'IMAP_PASSWORD', ''), patch.object(config, 'IMAP_USER', ''), \
             patch.object(system_settings, '_load_registry', return_value=registry), \
             patch.object(macos_keychain, 'read_for_app', side_effect=read):
            system_settings.initialize_current_account()
            system_settings.initialize_current_account()
            self.assertEqual([key for key, interactive in calls if interactive], ['a'])
            self.assertEqual(config.IMAP_PASSWORD, '')

    def test_post_request_allows_explicit_access_but_get_and_response_status_do_not(self):
        async def exercise(method, path='/api/system/remote-control'):
            seen = []
            async def app(scope, receive, send):
                seen.append(store._interactive.get())
                await asyncio.to_thread(lambda: seen.append(store._interactive.get()))
                @store.quiet
                def public_status():
                    seen.append(store._interactive.get())
                public_status()
            async def noop(*args):
                pass
            await AccountGuardMiddleware(app)({'type':'http','path':path, 'method':method}, noop, noop)
            self.assertFalse(store._interactive.get())
            return seen
        self.assertEqual(asyncio.run(exercise('GET')), [False,False,False])
        self.assertEqual(asyncio.run(exercise('POST')), [True,True,False])
        self.assertEqual(asyncio.run(exercise('POST','/api/ui-preferences')), [False,False,False])


if __name__ == '__main__':
    unittest.main()
