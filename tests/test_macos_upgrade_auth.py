"""Only ephemeral keychain/data, exact constrained queries, no user secrets."""
import ctypes as C
from pathlib import Path
import os
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))


@unittest.skipUnless(sys.platform == "darwin", "Real keychain integration requires macOS")
class UpgradeTests(unittest.TestCase):
    def test_two_different_signatures_restore_the_same_vault_without_reauthorization(self):
        with tempfile.TemporaryDirectory(prefix='mailai-stable-reader-real-') as folder:
            environment=patch.dict(os.environ,{'MAILAI_HOME':folder})
            environment.start()
            self.addCleanup(environment.stop)
            from app import macos_keychain as native, macos_credential_vault as module
            sec,cf=native._libraries()
            signatures={
                'SecKeychainCopySearchList':([C.POINTER(C.c_void_p)],C.c_int32),
                'SecKeychainSetSearchList':([C.c_void_p],C.c_int32),
                'SecKeychainCreate':([C.c_char_p,C.c_uint32,C.c_void_p,C.c_uint8,C.c_void_p,C.POINTER(C.c_void_p)],C.c_int32),
                'SecKeychainDelete':([C.c_void_p],C.c_int32),
            }
            for name,(args,result) in signatures.items():
                function=getattr(sec,name);function.argtypes=args;function.restype=result
            cf.CFDictionaryCreateMutableCopy.argtypes=[C.c_void_p,C.c_long,C.c_void_p]
            cf.CFDictionaryCreateMutableCopy.restype=C.c_void_p
            cf.CFDictionarySetValue.argtypes=[C.c_void_p,C.c_void_p,C.c_void_p]
            cf.CFDictionarySetValue.restype=None
            original=C.c_void_p();keychain=C.c_void_p();search=None
            assert sec.SecKeychainCopySearchList(C.byref(original))==0
            keychain_path=Path(folder)/'fixture.keychain-db'
            try:
                with native.interaction_policy(False) as status:
                    assert status==0
                    password=b'fixture-keychain-password'
                    assert sec.SecKeychainCreate(str(keychain_path).encode(),len(password),password,False,None,C.byref(keychain))==0
                    assert sec.SecKeychainSetSearchList(original)==0
                search=cf.CFArrayCreate(None,(C.c_void_p*1)(keychain.value),1,C.addressof(C.c_char.in_dll(cf,'kCFTypeArrayCallBacks')))
                actual_add=sec.SecItemAdd;actual_matching=sec.SecItemCopyMatching;actual_run=subprocess.run
                def constrained_add(query,output):
                    copy=cf.CFDictionaryCreateMutableCopy(None,0,query)
                    try:
                        cf.CFDictionarySetValue(copy,C.c_void_p.in_dll(sec,'kSecUseKeychain'),keychain)
                        return actual_add(copy,output)
                    finally:cf.CFRelease(copy)
                def constrained_match(query,output):
                    copy=cf.CFDictionaryCreateMutableCopy(None,0,query)
                    try:
                        cf.CFDictionarySetValue(copy,C.c_void_p.in_dll(sec,'kSecMatchSearchList'),search)
                        return actual_matching(copy,output)
                    finally:cf.CFRelease(copy)
                reads=[]
                def scoped_read(service,account,*,interactive=False):
                    if not interactive:return native.read(service,account,interactive=False)
                    reads.append((service,account))
                    # Stop a regression instead of leaving a test authorization dialog open.
                    def limited_run(*args,**kwargs):
                        kwargs['timeout']=4
                        return actual_run(*args,**kwargs)
                    with patch.object(native.subprocess,'run',side_effect=limited_run):
                        return native._read_system_tool(service,account,keychain=str(keychain_path))
                with patch.object(sec,'SecItemAdd',side_effect=constrained_add), \
                     patch.object(sec,'SecItemCopyMatching',side_effect=constrained_match), \
                     patch.object(native,'read_for_app',side_effect=scoped_read):
                    path=Path(folder)/'credentials.v1.enc'
                    vault=module.Vault(path)
                    secrets={'mail-a':'fixture-a','mail-b':'fixture-b','mail-c':'fixture-c'}
                    for key,value in secrets.items():assert vault.put(key,value)
                    assert reads==[]
                    assert native.read(module.SERVICE,module.MASTER_ACCOUNT)[0] in {0,*native.AUTH_REQUIRED},'Quiet native query must finish without a dialog'
                    original_ciphertext=path.read_bytes()
                    hashes=[]
                    for version in (1,2):
                        source=Path(folder)/f'parent-{version}.c';host=Path(folder)/f'parent-{version}'
                        source.write_text('#include <unistd.h>\nint main(int argc,char **argv){return execv("/usr/bin/security",argv)==-1?111:0;}\n')
                        actual_run(['clang',str(source),'-o',str(host)],check=True,capture_output=True)
                        actual_run(['codesign','--force','--sign','-','--identifier',f'com.mailai.fixture.parent.v{version}',str(host)],check=True,capture_output=True)
                        signature=actual_run(['codesign','--display','--verbose=4',str(host)],check=True,capture_output=True)
                        hashes.append(re.search(rb'CDHash=([^\n]+)',signature.stderr)[1])
                        reads.clear();reopened=module.Vault(path)
                        with patch.object(native,'SYSTEM_READER',str(host)):
                            for key,value in secrets.items():
                                status,secret=reopened.get(key,interactive=True)
                                assert status==0 and secret==value,f'Host {version}: stable restoration status {status}'
                        assert reads==[(module.SERVICE,module.MASTER_ACCOUNT)],'Each fresh process restores exactly one master'
                        assert path.read_bytes()==original_ciphertext
                    assert hashes[0]!=hashes[1],'Parents must have different signing identities'
                    for value in [' fixture ', 'fixture\\secret', 'fixture-密码\n', 'deadbeef', 'a"quoted"value']:
                        account='unicode-fixture-'+str(len(reads))
                        assert native.add_new('MailAI-stable-fixture',account,value)==0
                        status,secret=scoped_read('MailAI-stable-fixture',account,interactive=True)
                        assert status==0 and secret==value,'Real system output must preserve original bytes'
                    print('PASS real keychain: exact /usr/bin/security trust, two different parent signatures, one master for three mailboxes, ciphertext unchanged, spaces/Unicode/quotes preserved; no authorization dialog required')
            finally:
                sec.SecKeychainSetSearchList(original)
                if keychain.value:
                    with native.interaction_policy(False):sec.SecKeychainDelete(keychain)
                    cf.CFRelease(keychain)
                if search:cf.CFRelease(search)
                cf.CFRelease(original)


if __name__ == "__main__":
    unittest.main()
