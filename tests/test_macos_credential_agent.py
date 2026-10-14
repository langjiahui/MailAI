"""Immutable reader integrity and private IPC, with synthetic data only."""
import hashlib,io,json,os
from pathlib import Path
import sys,tempfile,unittest,zipfile
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app import macos_credential_agent as agent,macos_keychain as native

class AgentTests(unittest.TestCase):
    def test_untrusted_source_process_cannot_use_agent_or_fall_back(self):
        with patch.object(sys,'frozen',False,create=True),patch.object(native,'read') as direct:
            self.assertEqual(native.read_for_app('MailAI',agent.ACCOUNT),(-1,''))
            direct.assert_not_called()

    def test_secret_is_only_in_pipe_input_and_failure_is_not_logged(self):
        secret='A'*43+'='
        with patch.object(agent,'install',return_value=Path('/private/fixture-agent')),patch.object(agent.subprocess,'run',return_value=SimpleNamespace(returncode=0,stdout='0\n\n')) as run:
            self.assertEqual(agent.request('add',secret=secret),(0,''))
            self.assertNotIn(secret,str(run.call_args.args));self.assertIn(secret,run.call_args.kwargs['input'])
            self.assertIn('\n0\n',run.call_args.kwargs['input'])
        with patch.object(agent,'install',side_effect=ValueError(secret)):
            self.assertEqual(agent.request('read'),(-1,''))

    def test_malformed_secrets_cannot_inject_an_operation(self):
        with patch.object(agent,'install') as install:
            for value in ('','x\nread\n1\n','A'*43+'=\n','A'*42+'='):
                self.assertEqual(agent.request('add',secret=value),(-1,''))
            install.assert_not_called()

    def test_archive_tampering_and_symbolic_link_install_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);bundle=root/'bundle';native_dir=bundle/'app/native';native_dir.mkdir(parents=True)
            target=native_dir/'credential-agent-v1.zip';payload=b'synthetic executable'
            buffer=io.BytesIO()
            with zipfile.ZipFile(buffer,'w') as zipped:
                zipped.writestr('MailAICredentialAgent',payload)
                zipped.writestr('manifest.json',json.dumps({'certificate_sha1':agent.CERTIFICATE,'files':{'MailAICredentialAgent':{'sha256':hashlib.sha256(payload).hexdigest(),'identifier':agent.IDENTIFIER}}}))
            archive=buffer.getvalue();target.write_bytes(archive)
            user=root/'user'
            with patch.object(sys,'platform','darwin'),patch.object(sys,'frozen',True,create=True),patch.object(agent,'APP_DIR',bundle),patch.object(agent,'USER_DIR',user),patch.object(agent,'ARCHIVE_SHA256',hashlib.sha256(archive).hexdigest()),patch.object(agent.subprocess,'run') as verify:
                target.write_bytes(archive+b'tampered')
                with self.assertRaises(ValueError):agent.install()
                verify.assert_not_called()
                target.write_bytes(archive)
                installed=user/'credential-agent/v1/MailAICredentialAgent';installed.parent.mkdir(parents=True)
                installed.symlink_to(root/'elsewhere')
                with self.assertRaises(ValueError):agent.install()
                self.assertFalse((root/'elsewhere').exists());verify.assert_not_called()

if __name__=='__main__':unittest.main()
