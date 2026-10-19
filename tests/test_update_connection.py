"""Update discovery and downloads recover transport failures without weakening TLS."""
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import ssl
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import release_update as updater

PAYLOAD = b'verified public release package'
SHA = hashlib.sha256(PAYLOAD).hexdigest()
URL = updater.GITHUB_RELEASE_URL + '/download/v2.8.19/MailAI-macOS-arm64.pkg'
API = updater.GITHUB_API_URL + '/assets/123'
RELEASE = {'tag_name':'v2.8.19', 'html_url':updater.GITHUB_RELEASE_URL+'/tag/v2.8.19',
           'published_at':'2026-10-15T15:13:10Z','body':'Connection recovery',
           'draft':False,'prerelease':False,'assets':[
               {'id':123,'name':'MailAI-macOS-arm64.pkg','browser_download_url':URL,
                'size':len(PAYLOAD),'digest':'sha256:'+SHA}]}

class Response(io.BytesIO):
    def __init__(self, value):
        super().__init__(value)
        self.headers = {'Content-Length':str(len(value))}


def dropped():
    return urllib.error.URLError(ssl.SSLEOFError(8,'UNEXPECTED_EOF_WHILE_READING'))


class UpdateConnectionTest(unittest.TestCase):
    def test_tls_eof_uses_official_metadata_and_caches_success(self):
        with patch.dict(os.environ, {'MAILAI_APP_VERSION':'2.8.18','MAILAI_UPDATE_MANIFEST_URL':updater.DEFAULT_MANIFEST_URL}), \
             patch.object(updater.update_routing,'discover',side_effect=lambda loader, _version: loader()), \
             patch.object(updater,'FROZEN',True),patch.object(updater,'device_key',return_value='macos-arm64'), \
             patch.object(updater,'_cache',{'checked_at':0,'result':None}),patch.object(updater.time,'sleep'), \
             patch.object(updater.urllib.request,'urlopen',side_effect=[dropped(),Response(json.dumps(RELEASE).encode())]) as request:
            result=updater.check(force=True)
            self.assertTrue(result['available'])
            self.assertEqual(result['latest_version'],'2.8.19')
            self.assertEqual(result['asset'],{'url':URL,'sha256':SHA,'size':len(PAYLOAD),'api_url':API})
            self.assertEqual(updater.check(),result)
            self.assertEqual(request.call_count,2)
            self.assertEqual(request.call_args_list[0].args[0].full_url,updater.DEFAULT_MANIFEST_URL)
            self.assertEqual(request.call_args_list[1].args[0].full_url,updater.GITHUB_API_URL+'/latest')
            for call in request.call_args_list:
                self.assertEqual(call.kwargs['context'].verify_mode,ssl.CERT_REQUIRED)
                self.assertTrue(call.kwargs['context'].check_hostname)

    def test_custom_source_retries_without_switching_repositories(self):
        custom='https://updates.example.test/latest.json'
        with patch.object(updater.urllib.request,'urlopen',side_effect=dropped()) as request,patch.object(updater.time,'sleep'):
            with self.assertRaisesRegex(ValueError,'连接更新服务中断'):
                updater._read_manifest(custom)
        self.assertEqual(request.call_count,3)
        self.assertTrue(all(call.args[0].full_url==custom for call in request.call_args_list))

    def test_certificate_and_invalid_json_fail_without_fallback(self):
        for error,message in [(urllib.error.URLError(ssl.SSLCertVerificationError(1,'certificate verify failed')),'安全证书'),
                              (None,None)]:
            with patch.object(updater.urllib.request,'urlopen',side_effect=error,return_value=Response(b'invalid json')) as request:
                with self.assertRaises(ValueError) as failure:
                    updater._read_manifest(updater.DEFAULT_MANIFEST_URL)
                if message:self.assertIn(message,str(failure.exception))
                self.assertEqual(request.call_count,1)

    def test_truncated_manifest_retries_and_invalid_metadata_is_rejected(self):
        short=Response(b'{"version":');short.headers['Content-Length']='100'
        with patch.object(updater.urllib.request,'urlopen',side_effect=[short,Response(json.dumps(RELEASE).encode())]),patch.object(updater.time,'sleep'):
            self.assertEqual(updater._read_manifest(updater.DEFAULT_MANIFEST_URL)['version'],'2.8.19')
        for change in ({'digest':'sha256:bad'}, {'browser_download_url':'https://other.example.test/MailAI.pkg'}, {'id':True}):
            invalid=copy.deepcopy(RELEASE);invalid['assets'][0].update(change)
            with self.assertRaises(ValueError):updater._github_manifest(invalid)
        for change in ({'draft':True},{'prerelease':True},{'html_url':'https://other.example.test'},{'assets':[None]}):
            with self.assertRaises(ValueError):updater._github_manifest({**RELEASE,**change})

    def test_download_changes_transport_but_pins_the_same_package(self):
        asset={'url':URL,'sha256':SHA,'size':len(PAYLOAD)}
        with tempfile.TemporaryDirectory() as folder,patch.object(updater.time,'sleep'), \
             patch.object(updater.urllib.request,'urlopen',side_effect=[dropped(),Response(json.dumps(RELEASE).encode()),Response(PAYLOAD)]) as request:
            target=Path(folder)/'MailAI.pkg';updater._download(asset,target)
            self.assertEqual(target.read_bytes(),PAYLOAD)
            self.assertEqual([call.args[0].full_url for call in request.call_args_list],
                             [URL,updater.GITHUB_API_URL+'/tags/v2.8.19',API])
            self.assertEqual(request.call_args_list[-1].args[0].get_header('Accept'),'application/octet-stream')
            self.assertFalse(target.with_suffix('.pkg.part').exists())
        invalid=copy.deepcopy(RELEASE);invalid['assets'][0]['digest']='sha256:'+'0'*64
        with tempfile.TemporaryDirectory() as folder,patch.object(updater.time,'sleep'), \
             patch.object(updater.urllib.request,'urlopen',side_effect=[dropped(),Response(json.dumps(invalid).encode())]) as request:
            target=Path(folder)/'MailAI.pkg'
            with self.assertRaisesRegex(ValueError,'不一致'):updater._download(asset,target)
            self.assertFalse(target.exists())
            self.assertEqual(request.call_count,2)

    def test_short_download_retries_official_transport_before_hash_check(self):
        asset = {'url': URL, 'sha256': SHA, 'size': len(PAYLOAD)}
        for declared in (str(len(PAYLOAD)), '5', None):
            with self.subTest(content_length=declared), tempfile.TemporaryDirectory() as folder:
                short = Response(PAYLOAD[:5])
                short.headers = {'Content-Length': declared} if declared else {}
                progress = []
                with patch.object(updater.time, 'sleep'), patch.object(
                    updater.urllib.request, 'urlopen', side_effect=[
                        short, Response(json.dumps(RELEASE).encode()), Response(PAYLOAD)
                    ]
                ) as request:
                    target = Path(folder) / 'MailAI.pkg'
                    updater._download(asset, target, progress=lambda **s: progress.append(s))
                self.assertEqual(target.read_bytes(), PAYLOAD)
                self.assertEqual([call.args[0].full_url for call in request.call_args_list],
                                 [URL, updater.GITHUB_API_URL + '/tags/v2.8.19', API])
                self.assertEqual(progress[-1]['phase'], 'verified')
                self.assertFalse(target.with_suffix('.pkg.part').exists())

    def test_complete_corrupt_download_stops_without_retry(self):
        asset = {'url': URL, 'sha256': SHA, 'size': len(PAYLOAD)}
        with tempfile.TemporaryDirectory() as folder, patch.object(
            updater.urllib.request, 'urlopen', return_value=Response(b'x' * len(PAYLOAD))
        ) as request:
            target = Path(folder) / 'MailAI.pkg'
            with self.assertRaisesRegex(ValueError, 'SHA-256'):
                updater._download(asset, target)
            self.assertEqual(request.call_count, 1)
            self.assertFalse(target.exists())
            self.assertFalse(target.with_suffix('.pkg.part').exists())

    def test_custom_short_download_exhausts_retries_and_keeps_existing_file(self):
        asset = {'url': 'https://updates.example.test/MailAI.pkg', 'sha256': SHA, 'size': len(PAYLOAD)}
        with tempfile.TemporaryDirectory() as folder, patch.object(updater.time, 'sleep'), patch.object(
            updater.urllib.request, 'urlopen', side_effect=lambda *a, **k: Response(PAYLOAD[:5])
        ) as request:
            target = Path(folder) / 'MailAI.pkg'
            target.write_bytes(b'previous installer')
            with self.assertRaisesRegex(ValueError, '下载多次中断'):
                updater._download(asset, target)
            self.assertEqual(request.call_count, 3)
            self.assertTrue(all(call.args[0].full_url == asset['url'] for call in request.call_args_list))
            self.assertEqual(target.read_bytes(), b'previous installer')
            self.assertFalse(target.with_suffix('.pkg.part').exists())


if __name__=='__main__':unittest.main()
