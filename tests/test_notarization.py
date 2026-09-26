"""Apple tooling is mocked; validate fail-closed publishing and key cleanup."""
import base64
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.notarize_macos import notarize


def main():
    with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {}, clear=True):
        artifact = Path(root) / 'MailAI.pkg'; artifact.write_bytes(b'fixture')
        with patch('scripts.notarize_macos.subprocess.run') as runner:
            assert not notarize(artifact, artifact)
            runner.assert_not_called()
        env = {'MAILAI_NOTARY_KEY_BASE64': base64.b64encode(b'private fixture').decode(),
               'MAILAI_NOTARY_KEY_ID': 'test-key', 'MAILAI_NOTARY_ISSUER': 'test-issuer'}
        with patch.dict(os.environ, env):
            paths = []
            def run(command, **kwargs):
                if 'submit' in command:
                    key = Path(command[command.index('--key') + 1]); paths.append(key)
                    assert key.read_bytes() == b'private fixture'
                    return subprocess.CompletedProcess(command, 0, '{"status":"Accepted"}', '')
                return subprocess.CompletedProcess(command, 0)
            with patch('scripts.notarize_macos.subprocess.run', side_effect=run) as runner:
                assert notarize(artifact, artifact)
                assert runner.call_count == 3  # submit, staple, validate
            assert all(not path.exists() for path in paths)
            with patch('scripts.notarize_macos.subprocess.run', return_value=
                       subprocess.CompletedProcess([], 0, '{"status":"Invalid","id":"test"}', '')) as runner:
                try:
                    notarize(artifact, artifact)
                except RuntimeError:
                    pass
                else:
                    raise AssertionError('rejected notarization published as success')
                assert runner.call_count == 1
        with patch.dict(os.environ, {'MAILAI_NOTARY_KEY_ID': 'partial'}):
            try:
                notarize(artifact, artifact)
            except ValueError:
                pass
            else:
                raise AssertionError('partial credentials silently skipped')
    print('Notarization opt-in, rejection handling and private-key cleanup passed')


if __name__ == '__main__':
    main()
