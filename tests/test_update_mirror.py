"""Signed domestic source, resume persistence and redirect/DNS boundary contracts."""
import base64
import copy
from contextlib import contextmanager
import hashlib
import io
import json
import os
import ssl
import socket
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
    def setUp(self):
        route = patch.object(resume.update_routing, 'download_source', return_value='atomgit')
        route.start(); self.addCleanup(route.stop)
        with updater.update_routing._lock:
            updater.update_routing._recent.clear()

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
        with patch.object(mirror, 'read_json', side_effect=[signed(MANIFEST)]) as read, \
                patch.object(trust, 'PUBLIC_KEY', PUBLIC):
            result = mirror.discover()
        self.assertEqual(result['assets']['macos-arm64'], ASSET)
        self.assertTrue(all(call.args[0].startswith(mirror.STATIC_MANIFEST_URL) for call in read.call_args_list))
        for change in ({'version':'2.9.0'}, {'release_url':'https://other.example.test'},
                       {'assets': {**MANIFEST['assets'], 'macos-arm64': {**MANIFEST['assets']['macos-arm64'], 'url':'https://other.example.test/a.pkg'}}}):
            with patch.object(mirror,'read_json',side_effect=[signed({**MANIFEST,**change})]),patch.object(trust,'PUBLIC_KEY',PUBLIC):
                with self.assertRaises(ValueError):mirror.discover()

    def test_check_uses_domestic_and_custom_source_stays_custom(self):
        with patch.object(updater,'FROZEN',True),patch.dict(os.environ,{'MAILAI_APP_VERSION':'2.9.6','MAILAI_UPDATE_MANIFEST_URL':updater.DEFAULT_MANIFEST_URL}), \
                patch.object(mirror,'discover',return_value={**MANIFEST,'assets':{'macos-arm64':ASSET}}), \
                patch.object(updater,'device_key',return_value='macos-arm64'),patch.object(updater,'_read_manifest',side_effect=AssertionError('GitHub must not be contacted')):
            self.assertEqual(updater.check(force=True)['asset'],{**ASSET,'preferred_source':'atomgit'})
        with patch.object(updater,'FROZEN',True),patch.dict(os.environ,{'MAILAI_UPDATE_MANIFEST_URL':'https://updates.example.test/latest.json'}), \
                patch.object(mirror,'discover',side_effect=AssertionError('Custom source must not switch')),patch.object(updater,'_read_manifest',return_value=MANIFEST):
            updater.check(force=True)

    def test_stale_mirror_does_not_hide_newer_backup_or_fail_when_backup_is_offline(self):
        older=json.loads(json.dumps(MANIFEST).replace(TAG,'v2.9.5').replace(TAG[1:],'2.9.5'))
        for backup in (MANIFEST,ValueError('offline')):
            with updater.update_routing._lock:updater.update_routing._recent.clear()
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

    def test_overseas_preference_starts_github_then_resumes_from_domestic(self):
        requests=[]
        @contextmanager
        def open_mock(url,**kwargs):
            requests.append((url,kwargs['headers']))
            if len(requests)==1:yield Response(DATA[:8],headers={'Content-Length':str(len(DATA))})
            else:yield Response(DATA[8:],206,{'Content-Length':str(len(DATA)-8),'Content-Range':f'bytes 8-{len(DATA)-1}/{len(DATA)}'})
        with tempfile.TemporaryDirectory() as folder,patch.object(resume.update_routing,'download_source',return_value='github'), \
                patch.object(resume,'open_public',side_effect=open_mock),patch.object(resume.time,'sleep'):
            target=Path(folder)/'MailAI.pkg';resume.download({**ASSET,'preferred_source':'github'},target)
            self.assertEqual(target.read_bytes(),DATA)
            self.assertEqual([item[0] for item in requests],[ASSET['url'],ASSET['mirror_url']])
            self.assertEqual(requests[1][1]['Range'],'bytes=8-')

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
            self.assertEqual(urls,[ASSET['mirror_url'],ASSET['url'],ASSET['mirror_url'],ASSET['url'],ASSET['mirror_url'],fallback['url']])

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

    def test_publisher_edge_keeps_tls_hostname_and_blocks_private_override(self):
        from unittest.mock import MagicMock
        connection=MagicMock();response=connection.getresponse.return_value;response.status=200
        with patch.object(transport,'_public_target',return_value=('file.gitcode.com',['1.1.1.1'])), \
                patch.object(transport.http.client,'HTTPSConnection',return_value=connection) as ctor:
            with transport.open_public('https://file.gitcode.com/object',connect_ip='8.8.8.8'):pass
            self.assertEqual(ctor.call_args.args[0],'file.gitcode.com')
            self.assertTrue(ctor.call_args.kwargs['context'].check_hostname)
            with patch.object(transport.socket,'create_connection') as connect:
                connection._create_connection(('file.gitcode.com',443),10)
                self.assertEqual(connect.call_args.args[0],('8.8.8.8',443))
            connection.request.reset_mock()
            with self.assertRaises(ValueError):
                with transport.open_public('https://file.gitcode.com/object',connect_ip='127.0.0.1'):pass
            connection.request.assert_not_called()

    def test_failed_upload_edge_retries_default_dns_without_credentials_in_storage(self):
        calls=[]
        @contextmanager
        def open_mock(url,**kwargs):
            calls.append(kwargs)
            self.assertNotIn('Authorization',kwargs['headers'])
            if kwargs.get('connect_ip'):raise OSError('edge unavailable')
            yield Response(b'')
        def api_mock(path,*args,**kwargs):
            if '/upload_url?' in path:return {'url':'https://file.gitcode.com/upload?signature=synthetic','headers':{'Content-Type':'application/octet-stream'}}
            return {'assets':[]}
        with tempfile.TemporaryDirectory() as folder,patch.dict(os.environ,{'ATOMGIT_UPLOAD_EDGE_IP':'8.8.8.8'}), \
                patch.object(syncer,'api',side_effect=api_mock),patch.object(syncer,'open_public',side_effect=open_mock), \
                patch.object(syncer,'matches',return_value=True),patch.object(syncer.time,'sleep'):
            path=Path(folder)/'release-note.txt';path.write_bytes(b'public release')
            syncer.upload(TAG,path,'synthetic-token')
        self.assertEqual([item.get('connect_ip') for item in calls],['8.8.8.8',None])

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
            with patch.object(syncer,'api',side_effect=api_mock),patch.object(syncer,'upload',side_effect=upload_mock),patch.object(syncer,'publish_channel',side_effect=lambda *args:events.append(('channel','latest.signed.json'))):
                syncer.sync(TAG,root,'synthetic-token','notes')
            uploads=[name for kind,name in events if kind=='upload']
            self.assertEqual(uploads[-2:],['latest.json','latest.signed.json'])
            self.assertLess(events.index(('upload','latest.signed.json')),events.index(('PATCH','/releases/'+TAG)))
            self.assertLess(events.index(('PATCH','/releases/'+TAG)),events.index(('channel','latest.signed.json')))
            (root/mirror.NAMES['macos-arm64']).write_bytes(DATA[:8])
            with patch.object(syncer,'api',side_effect=AssertionError('Must reject before API')):
                with self.assertRaises(ValueError):syncer.sync(TAG,root,'synthetic-token','notes')
                with self.assertRaises(ValueError):syncer.upload(TAG,root/mirror.NAMES['macos-arm64'],'synthetic-token')

    def test_historical_mirror_does_not_replace_latest_or_channel(self):
        with tempfile.TemporaryDirectory() as folder,patch.object(trust,'PUBLIC_KEY',PUBLIC):
            root=Path(folder)
            for name in mirror.NAMES.values():(root/name).write_bytes(DATA)
            (root/'latest.json').write_text(json.dumps(MANIFEST))
            (root/'latest.signed.json').write_text(json.dumps(signed(MANIFEST)))
            def api_mock(path,*args,**kwargs):
                return {'tag_name':'v2.11.0' if 'latest?' in path else TAG,'prerelease':False,'assets':[]}
            with patch.object(syncer,'api',side_effect=api_mock) as api,patch.object(syncer,'upload'),patch.object(syncer,'publish_channel') as channel:
                syncer.sync(TAG,root,'synthetic-token','notes')
            channel.assert_not_called()
            self.assertFalse(any(len(call.args)>2 and call.args[2]=='PATCH' for call in api.call_args_list))

    def test_mirror_retry_does_not_overwrite_existing_attachment(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'readme.txt';path.write_text('published bytes')
            with patch.object(syncer,'api',return_value={'assets':[{'name':path.name}]}),patch.object(syncer,'matches',return_value=False):
                with self.assertRaises(ValueError):syncer.upload(TAG,path,'synthetic-token')
            with patch.object(syncer,'api',return_value={'assets':[{'name':path.name}]}) as api,patch.object(syncer,'matches',return_value=True):
                syncer.upload(TAG,path,'synthetic-token')
                self.assertEqual(api.call_count,1)


class UpdateNetworkTest(unittest.TestCase):
    """Exercise the real transport boundaries, including the reported VPN case."""
    def setUp(self):
        # Never depend on the developer/CI machine's real proxy or DNS settings.
        self.proxy = patch.object(transport.update_proxy, 'proxy_for', return_value=None)
        self.proxy.start()
        self.addCleanup(self.proxy.stop)

    def dns(self, *addresses):
        return patch.object(transport.socket, 'getaddrinfo',
                            return_value=[(0, 0, 0, '', (value, 443)) for value in addresses])

    def connection(self, payload=DATA):
        from unittest.mock import MagicMock
        connection = MagicMock()
        connection.getresponse.return_value = Response(payload)
        return connection

    def test_official_fake_ip_keeps_origin_tls_and_pins_vpn_address(self):
        connection = self.connection()
        with self.dns('198.18.0.8'), patch.object(transport.http.client, 'HTTPSConnection', return_value=connection) as ctor:
            with transport.open_public(ASSET['mirror_url']) as response:
                self.assertEqual(response.read(), DATA)
            self.assertEqual(ctor.call_args.args[0], 'atomgit.com')
            context = ctor.call_args.kwargs['context']
            self.assertTrue(context.check_hostname)
            self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
            with patch.object(transport.socket, 'create_connection') as connect:
                connection._create_connection(('atomgit.com', 443), 5)
                self.assertEqual(connect.call_args.args[0], ('198.18.0.8', 443))

    def test_fake_ip_exception_never_allows_arbitrary_private_or_other_hosts(self):
        from unittest.mock import MagicMock
        for hostname, address in [('atomgit.com', '127.0.0.1'), ('atomgit.com', '10.0.0.1'),
                                  ('atomgit.com', '169.254.169.254'), ('atomgit.com', '::1'),
                                  ('updates.example.test', '198.18.0.8'),
                                  ('atomgit.com.example.test', '198.18.0.8')]:
            with self.subTest(hostname=hostname, address=address), self.dns(address), \
                    patch.object(transport.http.client, 'HTTPSConnection', MagicMock()) as ctor:
                with self.assertRaises(ValueError):
                    with transport.open_public('https://' + hostname + '/package'): pass
                ctor.assert_not_called()
        with self.dns('198.18.0.8'):
            for method in ['PUT', 'POST', 'DELETE']:
                with self.assertRaises(ValueError):
                    with transport.open_public(ASSET['mirror_url'], method=method): pass

    def test_proxy_connect_uses_origin_domain_without_local_dns_or_auth_leak(self):
        connection = self.connection()
        credentials = {'Proxy-Authorization': 'Basic c3ludGhldGljOnNlY3JldA=='}
        with patch.object(transport.update_proxy, 'proxy_for', return_value=('127.0.0.1', 7890, credentials)), \
                patch.object(transport.socket, 'getaddrinfo', side_effect=AssertionError('Proxy resolves origin')), \
                patch.object(transport.http.client, 'HTTPSConnection', return_value=connection) as ctor:
            with transport.open_public(ASSET['mirror_url'], headers={'Proxy-Authorization': 'must-not-leak'}): pass
            self.assertEqual(ctor.call_args.args, ('127.0.0.1', 7890))
            connection.set_tunnel.assert_called_once_with('atomgit.com', 443, headers=credentials)
            self.assertNotIn('Proxy-Authorization', connection.request.call_args.kwargs['headers'])
            self.assertTrue(ctor.call_args.kwargs['context'].check_hostname)

    def test_proxy_does_not_bypass_private_redirect_validation(self):
        connection = self.connection()
        response = connection.getresponse.return_value
        response.status = 302
        response.getheader = lambda name: 'https://127.0.0.1/private'
        with patch.object(transport.update_proxy, 'proxy_for', return_value=('127.0.0.1', 7890, {})) as proxy, \
                self.dns('127.0.0.1'), patch.object(transport.http.client, 'HTTPSConnection', return_value=connection) as ctor:
            with self.assertRaises(ValueError):
                with transport.open_public(ASSET['mirror_url']): pass
            self.assertEqual(ctor.call_count, 1)
            self.assertEqual(proxy.call_count, 1)

    def test_connect_tls_verifies_origin_hostname_instead_of_proxy(self):
        from unittest.mock import MagicMock
        context = MagicMock()
        with patch.object(transport.update_proxy, 'proxy_for', return_value=('127.0.0.1', 7890, {})), \
                patch.object(transport, 'ssl_context', return_value=context), \
                patch.object(transport.http.client.HTTPConnection, 'connect'):
            connection = transport._connection(ASSET['mirror_url'], 'GET', 4, None)
            connection.sock = MagicMock()
            connection.connect()
            self.assertEqual(context.wrap_socket.call_args.kwargs['server_hostname'], 'atomgit.com')
            connection.close()

    def test_proxy_authentication_failure_has_actionable_error(self):
        connection = self.connection()
        connection.request.side_effect = OSError('Tunnel connection failed: 407 Proxy Authentication Required')
        with patch.object(transport.update_proxy, 'proxy_for', return_value=('127.0.0.1', 7890, {})), \
                patch.object(transport.http.client, 'HTTPSConnection', return_value=connection):
            with self.assertRaisesRegex(transport.update_proxy.ProxyConfigurationError, '身份验证'):
                with transport.open_public(ASSET['mirror_url']): pass

    def test_redirect_reselects_proxy_and_strips_origin_secrets(self):
        first, second = self.connection(), self.connection()
        first.getresponse.return_value.status = 302
        first.getresponse.return_value.getheader = lambda name: 'https://file-cdn.gitcode.com/package'
        with patch.object(transport.update_proxy, 'proxy_for', return_value=('127.0.0.1', 7890, {})) as proxy, \
                patch.object(transport.http.client, 'HTTPSConnection', side_effect=[first, second]):
            with transport.open_public(ASSET['mirror_url'], headers={'Authorization': 'synthetic-secret',
                                      'Cookie': 'synthetic-cookie', 'Range': 'bytes=8-'}): pass
            self.assertEqual(proxy.call_count, 2)
            second.set_tunnel.assert_called_once_with('file-cdn.gitcode.com', 443, headers={})
            forwarded = second.request.call_args.kwargs['headers']
            self.assertNotIn('Authorization', forwarded)
            self.assertNotIn('Cookie', forwarded)
            self.assertEqual(forwarded['Range'], 'bytes=8-')

    def test_multiple_public_addresses_retry_only_validated_addresses(self):
        connection = self.connection()
        with self.dns('1.1.1.1', '8.8.8.8'), \
                patch.object(transport.http.client, 'HTTPSConnection', return_value=connection):
            with transport.open_public(ASSET['mirror_url']): pass
            with patch.object(transport.socket, 'create_connection', side_effect=[OSError('unreachable'), 'socket']) as connect:
                self.assertEqual(connection._create_connection(('atomgit.com', 443), 5), 'socket')
                self.assertEqual([call.args[0] for call in connect.call_args_list], [('1.1.1.1', 443), ('8.8.8.8', 443)])

    def test_system_and_bundled_roots_both_loaded_without_disabling_verification(self):
        with patch.object(transport.ssl, 'create_default_context') as create:
            context = transport.ssl_context()
            create.assert_called_once_with()
            context.load_verify_locations.assert_called_once_with(cafile=transport.certifi.where())

    def test_invalid_tls_certificate_is_never_ignored_for_vpn_or_proxy(self):
        connection = self.connection()
        connection.request.side_effect = ssl.SSLCertVerificationError(1, 'untrusted synthetic certificate')
        with self.dns('198.18.0.8'), patch.object(transport.http.client, 'HTTPSConnection', return_value=connection):
            with self.assertRaises(ssl.SSLCertVerificationError):
                with transport.open_public(ASSET['mirror_url']): pass
        connection.close.assert_called()

    def test_source_diagnostics_are_specific_and_do_not_expose_urls_or_secrets(self):
        import urllib.error
        self.assertIn('证书', transport.connection_diagnostic(ssl.SSLCertVerificationError(1, 'private detail')))
        self.assertIn('DNS', transport.connection_diagnostic(transport._NonPublicTarget('atomgit.com', ['10.0.0.1'])))
        self.assertIn('解析', transport.connection_diagnostic(socket.gaierror('synthetic error')))
        self.assertEqual(transport.connection_diagnostic(TimeoutError('synthetic')), '连接超时')
        error = urllib.error.HTTPError('https://synthetic:secret@example.test/?token=secret', 403, 'secret', {}, None)
        try:
            self.assertEqual(transport.connection_diagnostic(error), 'HTTP 403')
        finally:
            error.close()

    def test_vpn_download_still_verifies_complete_package_hash(self):
        connection = self.connection()
        with tempfile.TemporaryDirectory() as folder, self.dns('198.18.0.8'), \
                patch.object(transport.http.client, 'HTTPSConnection', return_value=connection), \
                patch.object(resume.update_routing, 'download_source', return_value='atomgit'):
            target = Path(folder) / 'MailAI.pkg'
            resume.download(ASSET, target)
            self.assertEqual(target.read_bytes(), DATA)
            connection.getresponse.return_value = Response(b'x' * len(DATA))
            target.unlink()
            with self.assertRaisesRegex(ValueError, 'SHA-256'):
                resume.download(ASSET, target)
            self.assertFalse(target.exists())


class UpdateProxyTest(unittest.TestCase):
    def setUp(self):
        from app import update_proxy
        self.module = update_proxy
        bypass = patch.object(update_proxy.urllib.request, 'proxy_bypass', return_value=False)
        bypass.start(); self.addCleanup(bypass.stop)

    def test_environment_proxy_precedes_system_and_credentials_stay_in_connect(self):
        with patch.object(self.module.urllib.request, 'getproxies_environment',
                          return_value={'https': 'http://synthetic:p%40ss@127.0.0.1:7890'}), \
                patch.object(self.module, '_windows_pac', side_effect=AssertionError('Environment wins')):
            host, port, headers = self.module.proxy_for(ASSET['mirror_url'], 5)
            self.assertEqual((host, port), ('127.0.0.1', 7890))
            self.assertEqual(base64.b64decode(headers['Proxy-Authorization'][6:]), b'synthetic:p@ss')

    def test_bypass_and_pac_direct_are_respected(self):
        with patch.object(self.module.urllib.request, 'proxy_bypass', return_value=True):
            self.assertIsNone(self.module.proxy_for(ASSET['mirror_url'], 5))
        with patch.object(self.module.sys, 'platform', 'win32'), \
                patch.object(self.module.urllib.request, 'getproxies_environment', return_value={}), \
                patch.object(self.module, '_windows_pac', return_value=''), \
                patch.object(self.module.urllib.request, 'getproxies', side_effect=AssertionError('DIRECT wins')):
            self.assertIsNone(self.module.proxy_for(ASSET['mirror_url'], 5))

    def test_windows_pac_and_static_proxy_and_no_proxy_only_environment(self):
        with patch.object(self.module.sys, 'platform', 'win32'), \
                patch.object(self.module.urllib.request, 'getproxies_environment', return_value={'no': 'localhost'}):
            with patch.object(self.module, '_windows_pac', return_value='http=unused:80;https=127.0.0.1:7890'):
                self.assertEqual(self.module.proxy_for(ASSET['mirror_url'], 5), ('127.0.0.1', 7890, {}))
            with patch.object(self.module, '_windows_pac', return_value=None), \
                    patch.object(self.module.urllib.request, 'getproxies_registry',
                                 return_value={'https': 'http://127.0.0.1:8080'}, create=True), \
                    patch.object(self.module.urllib.request, 'getproxies', side_effect=AssertionError('NO_PROXY must not hide registry')):
                self.assertEqual(self.module.proxy_for(ASSET['mirror_url'], 5), ('127.0.0.1', 8080, {}))

    def test_invalid_proxy_is_actionable_without_exposing_credentials(self):
        for value in ['socks5://synthetic:secret@127.0.0.1:7890', 'http://synthetic:secret@proxy.test:bad',
                      'http://synthetic:secret@proxy.test:0', 'http://[invalid']:
            with patch.object(self.module.urllib.request, 'getproxies_environment', return_value={'https': value}):
                with self.assertRaises(OSError) as error:
                    self.module.proxy_for(ASSET['mirror_url'], 5)
                self.assertNotIn('secret', str(error.exception))

    def test_native_windows_pac_result_timeouts_cleanup_and_wpad_fallback(self):
        import ctypes
        from unittest.mock import MagicMock
        # Model the native API's out parameters and ownership on all CI OSes.
        for has_pac, success, answer in [(True, True, 'https=127.0.0.1:7890'),
                                          (True, True, ''), (False, False, ''), (True, False, '')]:
            with self.subTest(has_pac=has_pac, success=success, answer=answer):
                winhttp, kernel = MagicMock(), MagicMock()
                pac_buffer = ctypes.create_unicode_buffer('https://pac.example.test/config.pac')
                proxy_buffer = ctypes.create_unicode_buffer(answer)
                allocated = []

                def config(pointer):
                    pointer._obj.auto = True
                    if has_pac:
                        pointer._obj.pac = ctypes.cast(pac_buffer, ctypes.c_void_p).value
                        allocated.append(pointer._obj.pac)
                    return True

                def resolve(session, url, options, result):
                    self.assertEqual(url, ASSET['mirror_url'])
                    self.assertFalse(options._obj.auto_login)
                    self.assertEqual(options._obj.flags, 2 if has_pac else 1)
                    if success and answer:
                        result._obj.proxy = ctypes.cast(proxy_buffer, ctypes.c_void_p).value
                        allocated.append(result._obj.proxy)
                    return success

                winhttp.WinHttpGetIEProxyConfigForCurrentUser.side_effect = config
                winhttp.WinHttpGetProxyForUrl.side_effect = resolve
                winhttp.WinHttpOpen.return_value = 123
                with patch.object(ctypes, 'WinDLL', side_effect=[winhttp, kernel], create=True), \
                        patch.object(ctypes, 'get_last_error', return_value=12180, create=True):
                    if has_pac and not success:
                        with self.assertRaisesRegex(self.module.ProxyConfigurationError, '12180'):
                            self.module._windows_pac(ASSET['mirror_url'], 4)
                    else:
                        self.assertEqual(self.module._windows_pac(ASSET['mirror_url'], 4), answer if success else None)
                winhttp.WinHttpSetTimeouts.assert_called_once_with(123, 4000, 4000, 4000, 4000)
                winhttp.WinHttpCloseHandle.assert_called_once_with(123)
                self.assertEqual([call.args[0] for call in kernel.GlobalFree.call_args_list], allocated)


if __name__=='__main__':unittest.main()
