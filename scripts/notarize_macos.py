"""Optional Apple notarization. Fail closed when credentials are configured."""
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def notarize(archive: Path, target: Path):
    profile = os.environ.get('MAILAI_NOTARY_PROFILE', '')
    key = os.environ.get('MAILAI_NOTARY_KEY_BASE64', '')
    key_id = os.environ.get('MAILAI_NOTARY_KEY_ID', '')
    issuer = os.environ.get('MAILAI_NOTARY_ISSUER', '')
    if not any((profile, key, key_id, issuer)):
        print('Apple notarization is not configured; skipping.')
        return False
    if not profile and not all((key, key_id, issuer)):
        raise ValueError('Notarization requires an API key, key ID and team issuer ID')
    if not archive.exists() or not target.exists():
        raise ValueError('Notarization artifact is missing')
    with tempfile.TemporaryDirectory(prefix='mailai-notary-') as root:
        if profile:
            auth = ['--keychain-profile', profile]
        else:
            private_key = Path(root) / 'AuthKey.p8'
            private_key.write_bytes(base64.b64decode(''.join(key.split()), validate=True))
            private_key.chmod(0o600)
            auth = ['--key', str(private_key), '--key-id', key_id, '--issuer', issuer]
        result = subprocess.run(
            ['xcrun', 'notarytool', 'submit', str(archive), *auth,
             '--wait', '--timeout', '20m', '--output-format', 'json'],
            capture_output=True, text=True, timeout=1500,
        )
        if result.returncode:
            raise RuntimeError('Apple notarization failed or timed out; check the submission in Apple Developer')
        response = json.loads(result.stdout)
        if response.get('status') != 'Accepted':
            raise RuntimeError(f"Apple did not accept the artifact (submission {response.get('id', 'unknown')})")
        subprocess.run(['xcrun', 'stapler', 'staple', str(target)], check=True, timeout=120)
        subprocess.run(['xcrun', 'stapler', 'validate', str(target)], check=True, timeout=120)
    print(f'Notarized and validated: {target.name}')
    return True


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: notarize_macos.py ARCHIVE STAPLE_TARGET')
    notarize(Path(sys.argv[1]), Path(sys.argv[2]))
