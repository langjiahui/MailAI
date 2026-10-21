"""The static channel is signed, monotonic, byte-preserving and non-forced."""
import base64
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app import update_trust as trust,update_mirror as mirror
from scripts import publish_update_channel as channel

KEY=Ed25519PrivateKey.generate()
PUBLIC=base64.b64encode(KEY.public_key().public_bytes_raw()).decode()


def envelope(version,notes='verified update'):
    manifest={'version':version,'notes':notes}
    return {'algorithm':'ed25519','manifest':manifest,'signature':base64.b64encode(KEY.sign(trust.canonical(manifest))).decode()}


class ChannelTest(unittest.TestCase):
    def setUp(self):
        self.folder=tempfile.TemporaryDirectory();self.addCleanup(self.folder.cleanup)
        self.root=Path(self.folder.name);self.repository=self.root/'remote.git'
        subprocess.run(['git','init','--bare',str(self.repository)],check=True,capture_output=True)
        for value in [patch.object(channel,'REPOSITORY',str(self.repository)),patch.object(trust,'PUBLIC_KEY',PUBLIC),patch.object(channel,'read_json',side_effect=lambda url:json.loads(self.raw()))]:
            value.start();self.addCleanup(value.stop)

    def raw(self, filename='latest.signed.json'):
        return subprocess.check_output(['git','--git-dir='+str(self.repository),'show','refs/heads/updates:'+filename])

    def write(self,version,notes='verified update'):
        path=self.root/('manifest-'+version+'.json');path.write_text(json.dumps(envelope(version,notes))+'\n');return path

    def head(self):return subprocess.check_output(['git','--git-dir='+str(self.repository),'rev-parse','refs/heads/updates']).strip()

    def test_new_and_existing_channel_preserve_exact_bytes(self):
        path=self.write('2.10.1');channel.publish(path,'synthetic-token')
        self.assertEqual(self.raw(),path.read_bytes());head=self.head()
        channel.publish(path,'synthetic-token');self.assertEqual(self.head(),head)
        newer=self.write('2.10.2');channel.publish(newer,'synthetic-token')
        self.assertEqual(self.raw(),newer.read_bytes())

    def test_old_release_cannot_replace_newer_channel(self):
        channel.publish(self.write('2.10.2'),'synthetic-token');head=self.head()
        channel.publish(self.write('2.10.1'),'synthetic-token');self.assertEqual(self.head(),head)

    def test_same_version_different_content_and_invalid_signature_are_rejected(self):
        channel.publish(self.write('2.10.1'),'synthetic-token');head=self.head()
        with self.assertRaises(ValueError):channel.publish(self.write('2.10.1','changed bytes'),'synthetic-token')
        self.assertEqual(self.head(),head)
        invalid=self.write('2.10.2');data=json.loads(invalid.read_text());data['manifest']['notes']='tampered';invalid.write_text(json.dumps(data))
        with self.assertRaises(ValueError):channel.publish(invalid,'synthetic-token')
        self.assertEqual(self.head(),head)

    def test_domestic_discovery_uses_static_signature_without_anonymous_api(self):
        value={'version':'2.10.1','release_url':mirror.GITHUB_RELEASES+'/tag/v2.10.1','assets':{device:{'url':mirror.GITHUB_RELEASES+'/download/v2.10.1/'+name,'size':800,'sha256':'a'*64} for device,name in mirror.NAMES.items()}}
        packet={'algorithm':'ed25519','manifest':value,'signature':base64.b64encode(KEY.sign(trust.canonical(value))).decode()}
        with patch.object(mirror,'read_json',return_value=packet) as read:
            result=mirror.discover()
        self.assertEqual(read.call_count,1)
        self.assertEqual(read.call_args.args[0],mirror.STATIC_MANIFEST_URL)
        self.assertTrue(all(item['mirror_url'].startswith(mirror.ATOM_RELEASES+'/download/') for item in result['assets'].values()))
        self.assertNotIn('api.atomgit.com',json.dumps(result))

    def test_android_pointer_never_replaces_desktop_and_has_its_own_version_order(self):
        channel.publish(self.write('2.10.3'),'synthetic-token')
        desktop=self.raw()
        with patch.object(channel,'read_json',side_effect=lambda url:json.loads(self.raw(url.rsplit('/',1)[1]))):
            channel.publish(self.write('1.4.0'),'synthetic-token',filename='android-latest.signed.json')
            android=self.raw('android-latest.signed.json')
            channel.publish(self.write('1.3.3'),'synthetic-token',filename='android-latest.signed.json')
            self.assertEqual(self.raw('android-latest.signed.json'),android)
        self.assertEqual(self.raw(),desktop)

    def test_access_denials_fail_promptly_but_transient_errors_still_retry(self):
        value=envelope('3.0.0')
        for code in [401,403,410]:
            with patch.object(channel,'read_json',side_effect=HTTPError('https://example.test',code,'denied',{},None)) as read,patch.object(channel.time,'sleep') as sleep:
                with self.assertRaises(HTTPError):channel.verify_public(value['manifest'])
                self.assertEqual(read.call_count,1);sleep.assert_not_called()
        for code in [404,429,503]:
            with patch.object(channel,'read_json',side_effect=[HTTPError('https://example.test',code,'temporary',{},None),value]) as read,patch.object(channel.time,'sleep') as sleep:
                channel.verify_public(value['manifest'])
                self.assertEqual(read.call_count,2);sleep.assert_called_once_with(30)


if __name__=='__main__':unittest.main()
