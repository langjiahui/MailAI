"""Verify native query flags/CF data ownership with synthetic results only."""
import ctypes as C
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import macos_keychain as native


@unittest.skipUnless(sys.platform == 'darwin', 'Security.framework requires macOS')
class NativeTests(unittest.TestCase):
    def setUp(self):
        self.security, self.cf = native._libraries()
        self.cf.CFDictionaryGetValue.argtypes = [C.c_void_p, C.c_void_p]
        self.cf.CFDictionaryGetValue.restype = C.c_void_p
        self.cf.CFEqual.argtypes = [C.c_void_p, C.c_void_p]
        self.cf.CFEqual.restype = C.c_bool
        self.cf.CFDataCreate.argtypes = [C.c_void_p, C.c_void_p, C.c_long]
        self.cf.CFDataCreate.restype = C.c_void_p

    def query_result(self, interactive, status, value=''):
        def matching(query, output):
            legacy = C.c_uint8()
            self.assertEqual(self.security.SecKeychainGetUserInteractionAllowed(C.byref(legacy)),0)
            self.assertEqual(bool(legacy.value),interactive, 'Legacy file-based UI policy must agree with the query')
            flag = self.cf.CFDictionaryGetValue(query, C.c_void_p.in_dll(self.security,'kSecUseAuthenticationUI'))
            expected = C.c_void_p.in_dll(self.security, 'kSecUseAuthenticationUIAllow' if interactive else 'kSecUseAuthenticationUIFail')
            self.assertTrue(self.cf.CFEqual(flag,expected), 'OS query must carry the exact UI policy')
            if status == 0:
                encoded = value.encode('utf-8')
                data = self.cf.CFDataCreate(None, C.c_char_p(encoded), len(encoded))
                C.cast(output,C.POINTER(C.c_void_p))[0] = data
            return status
        with patch.object(self.security, 'SecItemCopyMatching', side_effect=matching) as query:
            result = native.read('MailAI-synthetic-test','fixture',interactive=interactive)
            query.assert_called_once()
            return result

    def test_quiet_query_forbids_system_dialog_and_preserves_authorization_status(self):
        self.assertEqual(self.query_result(False,-25308),(-25308,''))

    def test_explicit_query_allows_system_authorization(self):
        self.assertEqual(self.query_result(True,-128),(-128,''))

    def test_unicode_data_decodes_without_stripping_password_characters(self):
        secret = ' fixture-密码 \n'
        self.assertEqual(self.query_result(False,0,secret),(0,secret))

    def test_missing_item_is_distinct_from_access_denied(self):
        self.assertEqual(self.query_result(False,native.NOT_FOUND),(native.NOT_FOUND,''))

    def test_new_master_is_added_natively_without_overwriting_existing_items(self):
        self.cf.CFArrayGetCount.argtypes=[C.c_void_p]
        self.cf.CFArrayGetCount.restype=C.c_long
        self.cf.CFArrayGetValueAtIndex.argtypes=[C.c_void_p,C.c_long]
        self.cf.CFArrayGetValueAtIndex.restype=C.c_void_p
        self.security.SecTrustedApplicationValidateWithPath.argtypes=[C.c_void_p,C.c_char_p]
        self.security.SecTrustedApplicationValidateWithPath.restype=C.c_int32
        actual_access=self.security.SecAccessCreate
        def access(descriptor,apps,result):
            self.assertTrue(apps,'A null trusted list would use changing caller identity')
            self.assertEqual(self.cf.CFArrayGetCount(apps),1,'Do not grant access to all applications')
            trusted=self.cf.CFArrayGetValueAtIndex(apps,0)
            self.assertEqual(self.security.SecTrustedApplicationValidateWithPath(trusted,b'/usr/bin/security'),0)
            return actual_access(descriptor,apps,result)
        def add(query,result):
            legacy=C.c_uint8()
            self.assertEqual(self.security.SecKeychainGetUserInteractionAllowed(C.byref(legacy)),0)
            self.assertEqual(legacy.value,0)
            data=self.cf.CFDictionaryGetValue(query,C.c_void_p.in_dll(self.security,'kSecValueData'))
            value=C.string_at(self.cf.CFDataGetBytePtr(data),self.cf.CFDataGetLength(data)).decode()
            self.assertEqual(value,'fixture-master-key')
            self.assertTrue(self.cf.CFDictionaryGetValue(query,C.c_void_p.in_dll(self.security,'kSecAttrAccess')))
            return native.DUPLICATE
        with patch.object(self.security,'SecAccessCreate',side_effect=access) as creation, \
             patch.object(self.security,'SecItemAdd',side_effect=add) as addition:
            self.assertEqual(native.add_new('MailAI-synthetic-test','fixture-master','fixture-master-key'),native.DUPLICATE)
            addition.assert_called_once()
            creation.assert_called_once()

    def test_interaction_policy_restores_previous_setting_on_exception(self):
        before = C.c_uint8()
        self.assertEqual(self.security.SecKeychainGetUserInteractionAllowed(C.byref(before)),0)
        with patch.object(self.security,'SecItemCopyMatching',side_effect=RuntimeError('fixture')):
            with self.assertRaises(RuntimeError):
                native.read('MailAI-synthetic-test','fixture',interactive=False)
        after = C.c_uint8()
        self.assertEqual(self.security.SecKeychainGetUserInteractionAllowed(C.byref(after)),0)
        self.assertEqual(before.value,after.value)

    def test_cannot_suppress_interaction_never_executes_query(self):
        with patch.object(self.security,'SecKeychainSetUserInteractionAllowed',return_value=-1), \
             patch.object(self.security,'SecItemCopyMatching') as query:
            self.assertEqual(native.read('MailAI-synthetic-test','fixture'),(-1,''))
            query.assert_not_called()

    def test_real_locked_file_keychain_fails_quietly_without_requesting_password(self):
        # Create only an ephemeral test keychain. Search-list restoration is
        # guaranteed; the query is constrained to this test file, never login.
        sec, cf = self.security, self.cf
        signatures = {
            'SecKeychainCopySearchList':([C.POINTER(C.c_void_p)],C.c_int32),
            'SecKeychainSetSearchList':([C.c_void_p],C.c_int32),
            'SecKeychainCreate':([C.c_char_p,C.c_uint32,C.c_void_p,C.c_uint8,C.c_void_p,C.POINTER(C.c_void_p)],C.c_int32),
            'SecKeychainAddGenericPassword':([C.c_void_p,C.c_uint32,C.c_char_p,C.c_uint32,C.c_char_p,C.c_uint32,C.c_char_p,C.c_void_p],C.c_int32),
            'SecKeychainLock':([C.c_void_p],C.c_int32),
            'SecKeychainDelete':([C.c_void_p],C.c_int32),
        }
        for name,(args,result) in signatures.items():
            fn=getattr(sec,name);fn.argtypes=args;fn.restype=result
        cf.CFArrayCreate.argtypes=[C.c_void_p,C.POINTER(C.c_void_p),C.c_long,C.c_void_p]
        cf.CFArrayCreate.restype=C.c_void_p
        cf.CFDictionaryCreateMutableCopy.argtypes=[C.c_void_p,C.c_long,C.c_void_p]
        cf.CFDictionaryCreateMutableCopy.restype=C.c_void_p
        cf.CFDictionarySetValue.argtypes=[C.c_void_p,C.c_void_p,C.c_void_p]
        cf.CFDictionarySetValue.restype=None
        original_search=C.c_void_p();keychain=C.c_void_p();search=None
        actual_matching=sec.SecItemCopyMatching
        self.assertEqual(sec.SecKeychainCopySearchList(C.byref(original_search)),0)
        with tempfile.TemporaryDirectory(prefix='mailai-keychain-regression-') as folder:
            try:
                with native.interaction_policy(False) as status:
                    self.assertEqual(status,0)
                    password=b'isolated-fixture-password'
                    self.assertEqual(sec.SecKeychainCreate(str(Path(folder)/'fixture.keychain-db').encode(),len(password),password,False,None,C.byref(keychain)),0)
                    # Creation may add a search-list entry. Restore immediately.
                    self.assertEqual(sec.SecKeychainSetSearchList(original_search),0)
                    secret=b'fixture-only-secret'
                    service=b'MailAI-locked-test';account=b'fixture'
                    self.assertEqual(sec.SecKeychainAddGenericPassword(keychain,len(service),service,len(account),account,len(secret),secret,None),0)
                    self.assertEqual(sec.SecKeychainLock(keychain),0)
                search=cf.CFArrayCreate(None,(C.c_void_p*1)(keychain.value),1,C.addressof(C.c_char.in_dll(cf,'kCFTypeArrayCallBacks')))
                self.assertTrue(search)
                def test_matching(query,output):
                    constrained=cf.CFDictionaryCreateMutableCopy(None,0,query)
                    try:
                        cf.CFDictionarySetValue(constrained,C.c_void_p.in_dll(sec,'kSecMatchSearchList'),search)
                        return actual_matching(constrained,output)
                    finally:
                        cf.CFRelease(constrained)
                with patch.object(sec,'SecItemCopyMatching',side_effect=test_matching):
                    started=time.monotonic()
                    status,secret=native.read('MailAI-locked-test','fixture',interactive=False)
                    self.assertIn(status,native.AUTH_REQUIRED)
                    self.assertEqual(secret,'')
                    self.assertLess(time.monotonic()-started,3,'Quiet read must return immediately instead of opening an authorization dialog')
            finally:
                sec.SecKeychainSetSearchList(original_search)
                if keychain.value:
                    with native.interaction_policy(False):
                        sec.SecKeychainDelete(keychain)
                    cf.CFRelease(keychain)
                if search:
                    cf.CFRelease(search)
                cf.CFRelease(original_search)


if __name__ == '__main__':
    unittest.main()
