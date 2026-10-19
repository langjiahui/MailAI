"""Signed domestic source, resume persistence and redirect/DNS boundary contracts."""
import base64
import copy
from contextlib import contextmanager
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import update_mirror as mirror, update_resume as resume, update_trust as trust, update_transport as transport
from app import release_update as updater
from scripts import sync_atomgit_release as syncer

DATA = b'one complete official package for resume testing'
SHA = hashlib.sha256(DATA).hexdigest()
TAG = 'v2.10.0'
KEY = Ed25519PrivateKey.generate()
PUBLIC = base64.b64encode(KEY.public_key().public_bytes_raw()).decode()
MANIFEST = {'version': TAG[1:], 'release_url': mirror.GITHUB_RELEASES + '/tag/' + TAG,
            'assets': {device: {'url': mirror.GITHUB_RELEASES + '/download/' + TAG + '/' + name,
                               'sha256': SHA, 'size': len(DATA)} for device, name in mirror.NAMES.items()}}
ASSET = {**MANIFEST['assets']['macos-arm64'], 'mirror_url': mirror.attachment(TAG, mirror.NAMES['macos-arm64'])}


def signed(manifest):
    return {'algorithm': 'ed25519', 'manifest': manifest,
            'signature': base64.b64encode(KEY.sign(trust.canonical(manifest))).decode()}


class Response(io.BytesIO):
    def __init__(self, data, status=200, headers=None):
        super().__init__(data)
        self.status = status
        self.headers = headers or {'Content-Length': str(len(data))}


class MirrorTest(unittest.TestCase):
    def test_signature_rejects_tampering_and_wrong_key(self):
        envelope = signed(copy.deepcopy(MANIFEST))
        with patch.object(trust, 'PUBLIC_KEY', PUBLIC):
            self.assertEqual(trust.verify(envelope), MANIFEST)
            envelope['manifest']['assets']['macos-arm64']['sha256'] = '0' * 64
            with self.assertRaises(ValueError): trust.verify(envelope)
        with self.assertRaises(ValueError): trust.verify(signed(MANIFEST))
        for invalid in ({}, {'algorithm':'none','manifest':MANIFEST,'signature':''}, {'manifest': [], 'signature': ''}):
            with self.assertRaises(ValueError): trust.verify(invalid)

    def test_domestic_discovery_needs_no_github_and_binds_urls(self):
        with patch.object(mirror, 'read_json', side_effect=[{'tag_name': TAG}, signed(MANIFEST)]) as read, \
                patch.object(trust, 'PUBLIC_KEY', PUBLIC):
            result = mirror.discover()
        self.assertEqual(result['assets']['macos-arm64'], ASSET)
        self.assertTrue(all(call.args[0].startswith(mirror.ATOM_API) for call in read.call_args_list))
        for change in ({'version':'2.9.0'}, {'release_url':'https://other.example.test'},
                       {'assets': {**MANIFEST['assets'], 'macos-arm64': {**MANIFEST['assets']['macos-arm64'], 'url':'https://other.example.test/a.pkg'}}}):
            with patch.object(mirror,'read_json',side_effect=[{'tag_name':TAG},signed({**MANIFEST,**change})]),patch.object(trust,'PUBLIC_KEY',PUBLIC):
                with self.assertRaises(ValueError):mirror.discover()

    def test_check_uses_domestic_and_custom_source_stays_custom(self):
        with patch.object(updater,'FROZEN',True),patch.dict(os.environ,{'MAILAI_APP_VERSION':'2.9.6','MAILAI_UPDATE_MANIFEST_URL':updater.DEFAULT_MANIFEST_URL}), \
                patch.object(mirror,'discover',return_value={**MANIFEST,'assets':{'macos-arm64':ASSET}}), \
                patch.object(updater,'device_key',return_value='macos-arm64'),patch.object(updater,'_read_manifest',side_effect=AssertionError('GitHub must not be contacted')):
            self.assertEqual(updater.check(force=True)['asset'],ASSET)
        with patch.object(updater,'FROZEN',True),patch.dict(os.environ,{'MAILAI_UPDATE_MANIFEST_URL':'https://updates.example.test/latest.json'}), \
                patch.object(mirror,'discover',side_effect=AssertionError('Custom source must not switch')),patch.object(updater,'_read_manifest',return_value=MANIFEST):
            updater.check(force=True)

    def test_stale_mirror_does_not_hide_newer_backup_or_fail_when_backup_is_offline(self):
        older={**MANIFEST,'version':'2.9.5'}
        for backup in (MANIFEST,ValueError('offline')):
            with patch.object(updater,'FROZEN',True),patch.dict(os.environ,{'MAILAI_APP_VERSION':'2.9.6','MAILAI_UPDATE_MANIFEST_URL':updater.DEFAULT_MANIFEST_URL}), \
                    patch.object(mirror,'discover',return_value=older),patch.object(updater,'_read_manifest',**({'side_effect':backup} if isinstance(backup,Exception) else {'return_value':backup})):
                result=updater.check(force=True)
                self.assertEqual(result['latest_version'],'2.9.5' if isinstance(backup,Exception) else TAG[1:])

    def test_dropped_download_resumes_from_retained_bytes(self):
        requests=[]
        @contextmanager
        def open_mock(url, **kwargs):
            requests.append((url,kwargs['headers']))
            if len(requests)==1:
                yield Response(DATA[:8],headers={'Content-Length':str(len(DATA))})
            else:
                yield Response(DATA[8:],206,{'Content-Length':str(len(DATA)-8),'Content-Range':f'bytes 8-{len(DATA)-1}/{len(DATA)}'})
        with tempfile.TemporaryDirectory() as folder,patch.object(resume,'open_public',side_effect=open_mock),patch.object(resume.time,'sleep'):
            target=Path(folder)/'MailAI.pkg';resume.download(ASSET,target)
            self.assertEqual(target.read_bytes(),DATA)
            self.assertNotIn('Range',requests[0][1]);self.assertEqual(requests[1][1]['Range'],'bytes=8-')
            self.assertFalse(target.with_suffix('.pkg.part').exists())
            self.assertFalse(target.with_suffix('.pkg.part.json').exists())

    def seed(self,target,data,identity=None):
        part=target.with_suffix('.pkg.part');part.write_bytes(data)
        part.with_suffix('.part.json').write_text(json.dumps(identity or {'sha256':SHA,'size':len(DATA)}))
        return part

    def test_restart_and_range_ignored_restart_safely(self):
        for status in (200,206):
            requests=[]
            @contextmanager
            def open_mock(url,**kwargs):
                requests.append(kwargs['headers'])
                yield Response(DATA if status==200 else DATA[8:],status,
                    {'Content-Length':str(len(DATA) if status==200 else len(DATA)-8),
                     'Content-Range':f'bytes 8-{len(DATA)-1}/{len(DATA)}'})
            with tempfile.TemporaryDirectory() as folder,patch.object(resume,'open_public',side_effect=open_mock):
                target=Path(folder)/'MailAI.pkg';self.seed(target,DATA[:8]);resume.download(ASSET,target)
                self.assertEqual(target.read_bytes(),DATA);self.assertEqual(requests[0]['Range'],'bytes=8-')

    def test_invalid_range_and_complete_corruption_remove_untrusted_part(self):
        for response in (Response(DATA[8:],206,{'Content-Range':f'bytes 0-{len(DATA)-9}/{len(DATA)}'}),Response(b'x'*len(DATA))):
            @contextmanager
            def open_mock(*a,**kw):yield response
            with tempfile.TemporaryDirectory() as folder,patch.object(resume,'open_public',side_effect=open_mock):
                target=Path(folder)/'MailAI.pkg';part=self.seed(target,DATA[:8])
                with self.assertRaises(ValueError):resume.download(ASSET,target)
                self.assertFalse(target.exists());self.assertFalse(part.exists())

    def test_exhaustion_keeps_progress_and_fallback_keeps_same_identity(self):
        urls=[]
        @contextmanager
        def open_mock(url,**kwargs):
            urls.append(url)
            if len(urls)==1:yield Response(DATA[:8],headers={'Content-Length':str(len(DATA))})
            else:raise OSError('offline')
        with tempfile.TemporaryDirectory() as folder,patch.object(resume,'open_public',side_effect=open_mock),patch.object(resume.time,'sleep'):
            target=Path(folder)/'MailAI.pkg';fallback={**ASSET,'url':'https://api.github.com/repos/langjiahui/MailAI/releases/assets/123'}
            with self.assertRaises(OSError):resume.download(ASSET,target,fallback=lambda asset:fallback)
            self.assertEqual(target.with_suffix('.pkg.part').read_bytes(),DATA[:8])
            self.assertEqual(urls,[ASSET['mirror_url']]*3+[ASSET['url']]*2+[fallback['url']])

    def test_old_identity_is_discarded_and_complete_part_reused_without_network(self):
        with tempfile.TemporaryDirectory() as folder,patch.object(resume,'open_public',side_effect=AssertionError('No network')):
            target=Path(folder)/'MailAI.pkg';self.seed(target,DATA);resume.download(ASSET,target)
            self.assertEqual(target.read_bytes(),DATA)
        @contextmanager
        def open_mock(url,**kwargs):
            self.assertNotIn('Range',kwargs['headers']);yield Response(DATA)
        with tempfile.TemporaryDirectory() as folder,patch.object(resume,'open_public',side_effect=open_mock):
            target=Path(folder)/'MailAI.pkg';self.seed(target,b'old part',{'sha256':'0'*64,'size':len(DATA)})
            resume.download(ASSET,target);self.assertEqual(target.read_bytes(),DATA)

    def test_private_targets_and_credentials_are_blocked(self):
        for address in ('127.0.0.1','10.0.0.1','169.254.169.254','::1','fe80::1'):
            with patch.object(transport.socket,'getaddrinfo',return_value=[(0,0,0,'',(address,443))]):
                with self.assertRaises(ValueError):transport._public_target('https://updates.example.test/a')
        for url in ('http://example.test/a','https://user:password@example.test/a','https://example.test:8443/a'):
            with self.assertRaises(ValueError):transport._public_target(url)


    def test_redirect_checks_next_target_and_pins_validated_ip(self):
        from unittest.mock import MagicMock
        connection = MagicMock()
        connection.getresponse.return_value.status = 302
        connection.getresponse.return_value.getheader.return_value = 'https://127.0.0.1/package'
        with patch.object(transport, '_public_target', side_effect=[('updates.example.test',['8.8.8.8']),ValueError('Private address')]), \
                patch.object(transport.http.client,'HTTPSConnection',return_value=connection) as ctor:
            with self.assertRaises(ValueError):
                with transport.open_public('https://updates.example.test/pkg'):pass
            self.assertEqual(ctor.call_count,1)
            self.assertTrue(ctor.call_args.kwargs['context'].check_hostname)
            with patch.object(transport.socket,'create_connection') as connect:
                connection._create_connection(('updates.example.test',443),10)
                self.assertEqual(connect.call_args.args[0],('8.8.8.8',443))

    def test_mirror_publishes_metadata_last_and_rejects_bad_source_before_upload(self):
        with tempfile.TemporaryDirectory() as folder,patch.object(trust,'PUBLIC_KEY',PUBLIC):
            root=Path(folder)
            for name in mirror.NAMES.values():(root/name).write_bytes(DATA)
            (root/'latest.json').write_text(json.dumps(MANIFEST))
            (root/'latest.signed.json').write_text(json.dumps(signed(MANIFEST)))
            events=[]
            def api_mock(path,token,method='GET',body=None):
                events.append((method,path))
                return {'tag_name':TAG,'prerelease':False,'assets':[]}
            def upload_mock(tag,path,token):events.append(('upload',path.name))
            with patch.object(syncer,'api',side_effect=api_mock),patch.object(syncer,'upload',side_effect=upload_mock):
                syncer.sync(TAG,root,'synthetic-token','notes')
            uploads=[name for kind,name in events if kind=='upload']
            self.assertEqual(uploads[-2:],['latest.json','latest.signed.json'])
            self.assertLess(events.index(('upload','latest.signed.json')),events.index(('PATCH','/releases/'+TAG)))
            (root/mirror.NAMES['macos-arm64']).write_bytes(DATA[:8])
            with patch.object(syncer,'api',side_effect=AssertionError('Must reject before API')):
                with self.assertRaises(ValueError):syncer.sync(TAG,root,'synthetic-token','notes')
                with self.assertRaises(ValueError):syncer.upload(TAG,root/mirror.NAMES['macos-arm64'],'synthetic-token')

    def test_mirror_retry_does_not_overwrite_existing_attachment(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'readme.txt';path.write_text('published bytes')
            with patch.object(syncer,'api',return_value={'assets':[{'name':path.name}]}),patch.object(syncer,'matches',return_value=False):
                with self.assertRaises(ValueError):syncer.upload(TAG,path,'synthetic-token')
            with patch.object(syncer,'api',return_value={'assets':[{'name':path.name}]}) as api,patch.object(syncer,'matches',return_value=True):
                syncer.upload(TAG,path,'synthetic-token')
                self.assertEqual(api.call_count,1)


if __name__=='__main__':unittest.main()
