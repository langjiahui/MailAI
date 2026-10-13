"""Encrypted credential vault and upgrade/migration tests; no real credentials."""
import base64
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import os
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app import credential_store as store, macos_keychain as native, macos_credential_vault as module


class VaultTests(unittest.TestCase):
    def setUp(self):
        folder=tempfile.TemporaryDirectory(prefix='mailai-encrypted-vault-test-')
        self.addCleanup(folder.cleanup)
        self.path=Path(folder.name)/'credentials.v1.enc'
        self.vault=module.Vault(self.path)
        self.master=None;self.locked=False;self.legacy={};self.calls=[]
        def read(service,key,*,interactive=False):
            self.calls.append(('read',key,interactive))
            if key==module.MASTER_ACCOUNT:
                if self.master is None:
                    return native.NOT_FOUND,''
                if self.locked and not interactive:
                    return -25308,''
                if interactive:
                    self.locked=False
                return 0,self.master
            if key in self.legacy:
                return (0,self.legacy[key]) if interactive else (-25308,'')
            return native.NOT_FOUND,''
        def add(service,key,secret,*,interactive=False):
            self.calls.append(('add',key,interactive))
            self.assertEqual(key,module.MASTER_ACCOUNT)
            if self.master is not None:
                return native.DUPLICATE
            self.master=secret
            return 0
        for obj,name,value in [(module,'_instance',self.vault),(store.platform,'system',lambda:'Darwin')]:
            mocked=patch.object(obj,name,value);mocked.start();self.addCleanup(mocked.stop)
        for name,fn in [('read_for_app',read),('add_new',add),('delete',lambda *a,**kw:0)]:
            mocked=patch.object(native,name,side_effect=fn);mocked.start();self.addCleanup(mocked.stop)
        self.reset_store()
        self.addCleanup(self.reset_store)

    def reset_store(self):
        for cache in (store._session_cache,store._quiet_unavailable,store._authorization_required,store._master_blocked):
            cache.clear()

    def upgrade(self):
        self.vault=module.Vault(self.path)
        module._instance=self.vault
        self.reset_store();self.locked=True;self.calls.clear()

    def test_multiple_credentials_and_token_updates_share_one_keychain_key(self):
        for key in ('mail-a','mail-b','oauth:mail-c','model-profile:fixture','remote-weixin:fixture'):
            self.assertTrue(self.vault.put(key,'fixture-secret-'+key))
        self.assertEqual(self.calls,[('read',module.MASTER_ACCOUNT,False),('add',module.MASTER_ACCOUNT,False)])
        self.assertEqual(len(base64.urlsafe_b64decode(self.master)),32)
        self.assertTrue(self.vault.put('oauth:mail-c','fixture-updated-token'))
        self.assertEqual(len(self.calls),2,'Token refresh must not write to Keychain')
        self.assertEqual(self.vault.get('oauth:mail-c'),(0,'fixture-updated-token'))

    def test_next_upgrade_authorizes_one_master_for_all_accounts(self):
        keys=('mail-a','mail-b','mail-c','oauth:fixture','model-profile:fixture')
        for key in keys:
            self.assertTrue(self.vault.put(key,'fixture-secret-'+key))
        self.upgrade()
        for key in keys:
            self.assertEqual(store.load(key),'')
            self.assertTrue(store.authorization_required(key))
        self.assertEqual(self.calls,[('read',module.MASTER_ACCOUNT,False)])
        with store.prompt_policy(True):
            self.assertEqual(store.load('mail-a'),'fixture-secret-mail-a')
        for key in keys:
            self.assertEqual(store.load(key),'fixture-secret-'+key)
            self.assertFalse(store.authorization_required(key))
        self.assertEqual(self.calls,[('read',module.MASTER_ACCOUNT,False),('read',module.MASTER_ACCOUNT,True)])
        self.assertTrue(store.save('oauth:fixture','fixture-refreshed-token'))
        self.assertEqual(len(self.calls),2)

    def test_legacy_items_migrate_individually_then_next_launch_uses_one_unlock(self):
        self.legacy={'mail-a':'fixture-password-a','mail-b':'fixture-password-b','mail-c':'fixture-password-c'}
        with store.prompt_policy(True):
            self.assertEqual(store.load('mail-a'),self.legacy['mail-a'])
        self.assertTrue(self.path.exists())
        self.assertEqual(store.load('mail-b'),'')
        self.assertTrue(store.authorization_required('mail-b'))
        for key in ('mail-b','mail-c'):
            with store.prompt_policy(True):
                self.assertEqual(store.load(key),self.legacy[key])
        self.assertEqual([key for op,key,interactive in self.calls if interactive],['mail-a','mail-b','mail-c'])
        self.upgrade()
        with store.prompt_policy(True):
            self.assertEqual(store.load('mail-a'),self.legacy['mail-a'])
        self.assertEqual(store.load('mail-b'),self.legacy['mail-b'])
        self.assertEqual(store.load('mail-c'),self.legacy['mail-c'])
        self.assertEqual(self.calls,[('read',module.MASTER_ACCOUNT,True)])

    def test_ciphertext_excludes_secrets_identifiers_and_master(self):
        identifier='fixture-account-identifier'
        secret='fixture-邮箱-password-that-must-not-be-persisted-in-plaintext'
        self.assertTrue(self.vault.put(identifier,secret))
        blob=self.path.read_bytes()
        for value in (identifier,secret,self.master):
            self.assertNotIn(value.encode('utf-8'),blob)
        self.assertEqual(list(self.path.parent.glob('.credential-vault-*')),[])
        self.assertEqual(self.vault.get(identifier),(0,secret))

    @unittest.skipUnless(os.name == 'posix', 'POSIX mode bits apply to macOS vault files')
    def test_vault_file_is_readable_and_writable_only_by_its_owner(self):
        self.assertTrue(self.vault.put('fixture','fixture-secret'))
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode),0o600)

    def test_changed_payload_uses_a_new_nonce(self):
        self.assertTrue(self.vault.put('fixture','fixture-secret-one'))
        first=self.path.read_bytes()
        self.assertTrue(self.vault.put('fixture','fixture-secret-two'))
        second=self.path.read_bytes()
        length=len(module.MAGIC)
        self.assertNotEqual(first[length:length+12],second[length:length+12])

    def test_authenticated_corruption_is_fail_closed_and_never_overwritten(self):
        self.assertTrue(self.vault.put('fixture','fixture-secret'))
        corrupted=bytearray(self.path.read_bytes());corrupted[-1]^=1
        self.path.write_bytes(corrupted)
        self.vault=module.Vault(self.path);module._instance=self.vault;self.reset_store()
        self.legacy['fixture']='fixture-stale-legacy'
        with self.assertLogs(module.log,level='WARNING'):
            self.assertEqual(store.load('fixture'),'')
        self.assertFalse(store.save('fixture','fixture-replacement'))
        self.assertEqual(self.path.read_bytes(),bytes(corrupted))
        self.assertFalse(any(key=='fixture' for op,key,interactive in self.calls),'Damaged encrypted data must not silently revive a legacy secret')

    def test_missing_master_key_never_creates_a_replacement_for_existing_ciphertext(self):
        self.assertTrue(self.vault.put('fixture','fixture-secret'))
        original=self.path.read_bytes();self.master=None;self.upgrade()
        self.assertEqual(store.load('fixture'),'')
        self.assertFalse(store.save('fixture','fixture-replacement'))
        self.assertEqual(self.path.read_bytes(),original)
        self.assertFalse(any(op=='add' for op,key,interactive in self.calls))

    def test_atomic_write_failure_preserves_old_data_in_memory_and_on_disk(self):
        self.assertTrue(self.vault.put('fixture','fixture-original'))
        original=self.path.read_bytes()
        with patch.object(module.os,'replace',side_effect=OSError('fixture-disk-error')):
            with self.assertLogs(module.log,level='WARNING'):
                self.assertFalse(self.vault.put('fixture','fixture-unsaved'))
        self.assertEqual(self.vault.get('fixture'),(0,'fixture-original'))
        self.assertEqual(self.path.read_bytes(),original)
        self.assertEqual(list(self.path.parent.glob('.credential-vault-*')),[])

    def test_delete_tombstone_prevents_revival_from_unmigrated_legacy_items(self):
        self.assertTrue(store.save('fixture','fixture-current'))
        self.legacy['fixture']='fixture-stale-legacy'
        store.delete('fixture');self.upgrade()
        with store.prompt_policy(True):
            self.assertEqual(store.load('fixture'),'')
        self.assertEqual(self.calls,[('read',module.MASTER_ACCOUNT,True)])
        self.assertTrue(store.save('fixture','fixture-relogin'))
        self.assertEqual(store.load('fixture'),'fixture-relogin')

    def test_concurrent_saves_do_not_lose_accounts(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            jobs=[pool.submit(self.vault.put,'fixture-'+str(i),'fixture-secret-'+str(i)) for i in range(12)]
            self.assertTrue(all(job.result(timeout=5) for job in jobs))
        self.upgrade()
        for i in range(12):
            self.assertEqual(self.vault.get('fixture-'+str(i),interactive=True),(0,'fixture-secret-'+str(i)))
        self.assertEqual(self.calls,[('read',module.MASTER_ACCOUNT,True)])

    def test_failed_migration_keeps_authorized_legacy_credentials_usable(self):
        self.legacy['fixture']='fixture-legacy-secret'
        with patch.object(module,'put',return_value=False),store.prompt_policy(True):
            with self.assertLogs(store.log,level='WARNING'):
                self.assertEqual(store.load('fixture'),'fixture-legacy-secret')
        self.assertEqual(self.legacy['fixture'],'fixture-legacy-secret')
        self.assertEqual(store.load('fixture'),'fixture-legacy-secret')

    def test_reader_access_creation_failure_keeps_the_legacy_session_usable(self):
        self.legacy['fixture']='fixture-legacy-secret'
        with patch.object(module,'put',side_effect=OSError('fixture-sensitive-error')),store.prompt_policy(True):
            with self.assertLogs(store.log,level='WARNING') as output:
                self.assertEqual(store.load('fixture'),'fixture-legacy-secret')
        self.assertNotIn('fixture-sensitive-error','\n'.join(output.output))
        self.assertEqual(store.load('fixture'),'fixture-legacy-secret')

    def test_startup_and_passive_status_restore_three_accounts_with_one_authorization(self):
        from app import config,system_settings
        users=['one@example.test','two@example.test','three@example.test']
        ids=[system_settings._account_key('imap.example.test',user) for user in users]
        accounts={key:dict(user=user,host='imap.example.test',db_path=str(self.path.parent/(key+'.db')),raw_dir=str(self.path.parent/key)) for key,user in zip(ids,users)}
        registry={'accounts':accounts,'last_account':ids[1]}
        for key in ids:
            self.assertTrue(self.vault.put(key,'fixture-secret-'+key))
        self.upgrade()
        changes={key:getattr(config,key) for key in dir(config) if key.isupper()}
        with patch.multiple(config,**changes), \
             patch.object(system_settings,'_load_registry',return_value=registry), \
             patch.object(system_settings,'_save_registry'), \
             patch.object(system_settings,'_activate_storage'),patch.object(system_settings,'_persist'):
            config.IMAP_PASSWORD=config.IMAP_USER=''
            system_settings.initialize_current_account()
            system_settings.initialize_current_account()
            public=system_settings.public_config()
            self.assertEqual(config.IMAP_USER,users[1])
            self.assertTrue(all(a['credential_available'] for a in public['accounts']))
            self.assertTrue(all(a['credential_migrated'] for a in public['accounts']))
            self.assertFalse(any(a['credential_authorization_required'] for a in public['accounts']))
            self.assertEqual(self.calls,[('read',module.MASTER_ACCOUNT,True)])

    def test_master_cancellation_can_recover_when_an_explicit_other_action_unlocks_it(self):
        for key in ('a','b'):
            self.assertTrue(self.vault.put(key,'fixture-secret-'+key))
        self.upgrade()
        with patch.object(native,'read_for_app',return_value=(-128,'')),store.prompt_policy(True):
            self.assertEqual(store.load('a'),'')
        with store.prompt_policy(True):
            self.assertEqual(store.load('b'),'fixture-secret-b')
        self.assertEqual(store.load('a'),'fixture-secret-a')


if __name__=='__main__':
    unittest.main()
