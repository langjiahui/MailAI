"""Sign the independent Android channel with the existing pinned release key."""
import base64
import hashlib
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.update_trust import canonical, verify
from scripts.android_release import validate_manifest


def sign(folder, encoded_key):
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    manifest = json.loads((folder / 'mailai-android-update.json').read_text())
    validate_manifest(manifest)
    key = Ed25519PrivateKey.from_private_bytes(base64.b64decode(encoded_key, validate=True))
    payload = canonical(manifest)
    envelope = dict(algorithm='ed25519', manifest=manifest,
                    payload=base64.b64encode(payload).decode(),
                    signature=base64.b64encode(key.sign(payload)).decode())
    verify(envelope)
    (folder / 'android-latest.signed.json').write_text(json.dumps(envelope, ensure_ascii=False, indent=2) + '\n')
    (folder / 'SHA256SUMS.txt').write_text(''.join(
        hashlib.sha256(path.read_bytes()).hexdigest() + '  ' + path.name + '\n'
        for path in sorted(folder.iterdir()) if path.is_file() and path.name != 'SHA256SUMS.txt'))


if __name__ == '__main__':
    sign(Path(sys.argv[1]), os.environ['UPDATE_SIGNING_KEY'])
