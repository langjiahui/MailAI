"""Pinned release signatures shared by publishers and anonymous update clients."""
import base64
import json
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

PUBLIC_KEY = 'eZ9V84iPGy4Sx2AwSvVG/xLWGFqZ8iyd7Az9YiDWAZY='


def canonical(manifest: dict) -> bytes:
    return json.dumps(manifest, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


def verify(envelope: dict) -> dict:
    try:
        manifest = envelope['manifest']
        if not isinstance(manifest, dict) or envelope.get('algorithm') != 'ed25519':
            raise ValueError('Invalid signature envelope')
        Ed25519PublicKey.from_public_bytes(base64.b64decode(PUBLIC_KEY, validate=True)).verify(
            base64.b64decode(envelope['signature'], validate=True), canonical(manifest))
        return manifest
    except (InvalidSignature, ValueError, TypeError, KeyError) as exc:
        raise ValueError('更新清单签名校验失败') from exc
