"""Signed Android mirroring preserves desktop channels and refuses changed bytes."""
import base64
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import update_trust
from scripts import sign_android_update as signer, sync_android_atomgit_release as mirror


class AndroidMirrorTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.key = Ed25519PrivateKey.generate()
        patched = patch.object(update_trust, 'PUBLIC_KEY', base64.b64encode(self.key.public_key().public_bytes_raw()).decode())
        patched.start(); self.addCleanup(patched.stop)
        self.apk = self.root/'MailAI-Android-1.4.0.apk'
        self.apk.write_bytes(b'synthetic apk bytes')
        self.manifest = dict(schema=1, applicationId='com.mailai.mobile', version='1.4.0', code=2100112,
            url='https://github.com/langjiahui/MailAI/releases/download/android-v1.4.0/'+self.apk.name,
            sha256=hashlib.sha256(self.apk.read_bytes()).hexdigest(),size=self.apk.stat().st_size,
            notes='synthetic update',page='https://github.com/langjiahui/MailAI/releases/tag/android-v1.4.0')
        (self.root/'mailai-android-update.json').write_text(json.dumps(self.manifest))
        signer.sign(self.root, base64.b64encode(self.key.private_bytes_raw()).decode())

    def test_signature_payload_and_checksums_match_exact_android_bytes(self):
        envelope=json.loads((self.root/'android-latest.signed.json').read_text())
        self.assertEqual(update_trust.verify(envelope),self.manifest)
        self.assertEqual(base64.b64decode(envelope['payload']),update_trust.canonical(self.manifest))
        self.assertIn('android-latest.signed.json',(self.root/'SHA256SUMS.txt').read_text())

    def test_tampered_apk_is_rejected_before_any_remote_action(self):
        self.apk.write_bytes(b'tampered')
        with patch.object(mirror,'api') as api:
            with self.assertRaises(ValueError):mirror.sync('android-v1.4.0',self.root,'synthetic-token','notes')
            api.assert_not_called()

    def test_publishing_android_restores_desktop_latest_and_uses_independent_pointer(self):
        desktop=dict(tag_name='v2.10.3',name='MailAI 2.10.3',body='desktop',prerelease=False)
        current=dict(latest=desktop,android=None)
        def api(path, token, method='GET', body=None):
            if path=='/releases/latest?type=latest':return current['latest']
            if path=='/releases' and method=='POST':
                current['android']={**body,'prerelease':True};return current['android']
            if path=='/releases/android-v1.4.0':
                if current['android'] is None:raise HTTPError('https://example.test',404,'missing',{},None)
                if method=='PATCH':current['android']['prerelease']=False;current['latest']=current['android']
                return current['android']
            if path=='/releases/v2.10.3' and method=='PATCH':current['latest']=desktop;return desktop
            raise AssertionError(path)
        with patch.object(mirror,'api',side_effect=api), patch.object(mirror,'upload') as upload, patch.object(mirror,'publish') as publish:
            mirror.sync('android-v1.4.0',self.root,'synthetic-token','notes')
            self.assertEqual(current['latest'],desktop)
            self.assertFalse(current['android']['prerelease'])
            self.assertTrue(upload.called)
            self.assertEqual(publish.call_args.kwargs,dict(filename='android-latest.signed.json'))


if __name__=='__main__':unittest.main()
