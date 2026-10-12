"""Ephemeral owner-tool UI fixture; never reads production private keys."""
import json
import sys
import tempfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from scripts import companion_gift_issuer as issuer
from app import companion_gifts

with tempfile.TemporaryDirectory(prefix='mailai-gift-issuer-test-') as root:
    key=Ed25519PrivateKey.generate()
    kid,value=issuer.public(key)
    companion_gifts.TRUSTED_KEYS[kid]=value
    issuer.load_key=lambda home:key
    issuer.webbrowser.open=lambda url:print(json.dumps(dict(url=url,public=value,recipient=companion_gifts.recipient_code('1'*32))),flush=True)
    issuer.serve(Path(root))
