"""Private-master migration; synthetic credentials and temporary files only."""
import base64
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.exceptions import InvalidTag
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app import macos_keychain as native, macos_credential_vault as module

class UpgradeTests(unittest.TestCase):
    def setUp(self):
        folder=tempfile.TemporaryDirectory(prefix='mailai-private-vault-test-')
        self.addCleanup(folder.cleanup)
        self.path=Path(folder.name)/'credentials.v1.enc'
        self.old_key=b'l'*32
        self.keys={module.LEGACY_MASTER_ACCOUNT:base64.urlsafe_b64encode(self.old_key).decode()}
        self.calls=[]
        self.record={'version':1,'items':{'a':'fixture-a','b':'fixture-b','c':'fixture-c'},'removed':[]}
        nonce=os.urandom(12)
        self.original=module.LEGACY_MAGIC+nonce+AESGCM(self.old_key).encrypt(nonce,json.dumps(self.record).encode(),module.LEGACY_MAGIC)
        self.path.write_bytes(self.original)
        self.vault=module.Vault(self.path)
        def read(service,key,*,interactive=False):
            self.calls.append(('read',key,interactive))
            if key not in self.keys:return native.NOT_FOUND,''
            if not interactive:return -25308,''
            return 0,self.keys[key]
        def add(service,key,value,*,interactive=False):
            self.calls.append(('add',key,interactive))
            if key in self.keys:return native.DUPLICATE
            self.keys[key]=value
            return 0
        for name,fn in [('read_for_app',read),('add_new',add)]:
            mocked=patch.object(native,name,side_effect=fn);mocked.start();self.addCleanup(mocked.stop)

    def test_background_does_not_rekey_or_change_legacy_permissions(self):
        self.assertEqual(self.vault.get('a'),(-25308,''))
        self.assertEqual(self.calls,[])
        self.assertEqual(self.path.read_bytes(),self.original)
        self.assertNotIn(module.MASTER_ACCOUNT,self.keys)

    def test_authorized_rekey_preserves_all_items_and_old_master_cannot_decrypt(self):
        self.assertEqual(self.vault.get('a',interactive=True),(0,'fixture-a'))
        blob=self.path.read_bytes();self.assertTrue(blob.startswith(module.MAGIC))
        key=base64.urlsafe_b64decode(self.keys[module.MASTER_ACCOUNT])
        self.assertNotEqual(key,self.old_key)
        nonce=blob[len(module.MAGIC):len(module.MAGIC)+12];ciphertext=blob[len(module.MAGIC)+12:]
        with self.assertRaises(InvalidTag):AESGCM(self.old_key).decrypt(nonce,ciphertext,module.MAGIC)
        self.assertEqual(json.loads(AESGCM(key).decrypt(nonce,ciphertext,module.MAGIC)),self.record)
        self.keys.pop(module.LEGACY_MASTER_ACCOUNT)
        self.calls.clear();reopened=module.Vault(self.path)
        for name in ('a','b','c'):self.assertEqual(reopened.get(name,interactive=True),(0,'fixture-'+name))
        self.assertEqual(self.calls,[('read',module.MASTER_ACCOUNT,True)])

    def test_cancel_preserves_original_and_explicit_retry_succeeds(self):
        with patch.object(native,'read_for_app',return_value=(-128,'')):
            self.assertEqual(self.vault.get('a',interactive=True),(-128,''))
        self.assertEqual(self.path.read_bytes(),self.original)
        self.assertNotIn(module.MASTER_ACCOUNT,self.keys)
        self.assertEqual(self.vault.get('a',interactive=True),(0,'fixture-a'))

    def test_saving_an_unchanged_legacy_secret_still_performs_security_migration(self):
        self.assertTrue(self.vault.put('a','fixture-a',interactive=True))
        self.assertTrue(self.path.read_bytes().startswith(module.MAGIC))
        self.assertIn(module.MASTER_ACCOUNT,self.keys)

    def test_write_failure_preserves_original_and_remains_retryable(self):
        with patch.object(module.os,'replace',side_effect=OSError('fixture')):
            with self.assertLogs(module.log,level='WARNING'):
                self.assertEqual(self.vault.get('a',interactive=True),(-25308,''))
        self.assertEqual(self.path.read_bytes(),self.original)
        self.assertEqual(self.vault.get('a'),(-25308,''))
        self.assertEqual(self.vault.get('a',interactive=True),(0,'fixture-a'))

    def test_lost_key_and_corruption_never_create_a_replacement_master(self):
        self.keys.clear()
        self.assertEqual(self.vault.get('a',interactive=True),(module.ERROR,''))
        self.assertFalse(self.vault.put('a','fixture-new',interactive=True))
        self.assertEqual(self.path.read_bytes(),self.original)
        self.assertFalse(any(op=='add' for op,*_ in self.calls))
        self.keys[module.LEGACY_MASTER_ACCOUNT]=base64.urlsafe_b64encode(self.old_key).decode()
        bad=bytearray(self.original);bad[-1]^=1;self.path.write_bytes(bad)
        with self.assertLogs(module.log,level='WARNING'):
            self.assertEqual(module.Vault(self.path).get('a',interactive=True),(module.ERROR,''))
        self.assertFalse(any(op=='add' for op,*_ in self.calls))

    def test_quiet_reads_do_not_wait_for_foreground_authorization(self):
        entered=threading.Event();release=threading.Event()
        def hold():
            with self.vault._lock:entered.set();release.wait(2)
        worker=threading.Thread(target=hold);worker.start();self.assertTrue(entered.wait(1))
        try:self.assertEqual(self.vault.get('a'),(-25308,''))
        finally:release.set();worker.join(2)

if __name__=='__main__':unittest.main()
