"""Offline, pinned-public-key verification and atomic permanent gift claims."""
import base64
import json
import re

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from . import companion_growth as growth
from .companion_gift_keys import TRUSTED_KEYS

DOMAIN = b'MailAI/XiaoYou/Gift/v1\0'
MAX_CODE = 8192
FIELDS = {'v', 'kid', 'id', 'title', 'items', 'recipient', 'issued', 'expires'}
ERRORS = {
    'invalid': '礼券格式或签名无效，请确认已复制完整内容',
    'issuer': '这张礼券的发放密钥尚不受信任，请更新客户端或联系发放者',
    'recipient': '这张专属礼券不属于当前客户端，请核对领取编号',
    'expired': '礼券已超过领取期限',
    'future': '礼券尚未生效，请检查本机日期和时间',
    'unsupported': '礼券包含当前版本不支持的装扮，请更新客户端',
    'conflict': '礼券编号与已有领取记录不一致，请联系发放者',
}


class GiftError(ValueError):
    def __init__(self, name):
        super().__init__(ERRORS[name])
        self.code = name


def encode(value):
    return base64.urlsafe_b64encode(value).decode('ascii').rstrip('=')


def decode(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', value):
        raise GiftError('invalid')
    try:
        raw = base64.b64decode(value + '=' * (-len(value) % 4), altchars=b'-_', validate=True)
    except (ValueError, base64.binascii.Error) as exc:
        raise GiftError('invalid') from exc
    if encode(raw) != value:
        raise GiftError('invalid')
    return raw


def canonical(payload):
    return json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')


def recipient_code(client_id):
    # All 128 bits of the existing client identity, without revealing an email or hardware ID.
    value = base64.b32encode(bytes.fromhex(client_id)).decode('ascii').rstrip('=')
    return 'XY-' + '-'.join(value[n:n+5] for n in range(0, len(value), 5))


def normalize_recipient(value):
    if value == '*':
        return value
    if not isinstance(value, str) or len(value) > 60:
        raise GiftError('recipient')
    value = value.strip().upper()
    if not value.startswith('XY-'):
        raise GiftError('recipient')
    raw = value[3:].replace('-', '')
    if not re.fullmatch(r'[A-Z2-7]{26}', raw):
        raise GiftError('recipient')
    try:
        identity = base64.b32decode(raw + '=' * (-len(raw) % 8)).hex()
    except ValueError as exc:
        raise GiftError('recipient') from exc
    result = recipient_code(identity)
    if result[3:].replace('-', '') != raw:
        raise GiftError('recipient')
    return result


def validate_payload(payload):
    if not isinstance(payload, dict) or set(payload) != FIELDS or type(payload['v']) is not int or payload['v'] != 1:
        raise GiftError('invalid')
    for field, length in [('kid', 16), ('id', 32)]:
        if not isinstance(payload[field], str) or not re.fullmatch('[0-9a-f]{'+str(length)+'}', payload[field]):
            raise GiftError('invalid')
    if (not isinstance(payload['title'], str) or not 1 <= len(payload['title'].strip()) <= 80
            or any(ord(c) < 32 or 0xD800 <= ord(c) <= 0xDFFF for c in payload['title'])):
        raise GiftError('invalid')
    items = payload['items']
    if not isinstance(items, list) or not 1 <= len(items) <= 8 or any(not isinstance(item, str) for item in items):
        raise GiftError('invalid')
    if len(set(items)) != len(items):
        raise GiftError('invalid')
    if any(item not in growth.ITEMS or growth.ITEMS[item]['slot'] == 'consumable' for item in items):
        raise GiftError('unsupported')
    if payload['recipient'] != normalize_recipient(payload['recipient']):
        raise GiftError('recipient')
    if any(type(payload[field]) is not int or not 0 <= payload[field] <= 4102444800 for field in ('issued', 'expires')):
        raise GiftError('invalid')
    if payload['issued'] == 0 or (payload['expires'] and payload['expires'] <= payload['issued']):
        raise GiftError('invalid')


def verify(code):
    if not isinstance(code, str) or len(code) > MAX_CODE:
        raise GiftError('invalid')
    # Accept a code pasted with line wrapping, but no arbitrary JSON/key material.
    code = re.sub(r'\s+', '', code).lstrip('\ufeff')
    parts = code.split('.')
    if len(parts) != 3 or parts[0] != 'XYG1':
        raise GiftError('invalid')
    raw, signature = decode(parts[1]), decode(parts[2])
    if len(raw) > 4096 or len(signature) != 64:
        raise GiftError('invalid')
    try:
        payload = json.loads(raw)
        kid = payload.get('kid') if isinstance(payload, dict) else None
        key = TRUSTED_KEYS.get(kid) if isinstance(kid, str) else None
        if key is None:
            raise GiftError('issuer')
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(key)).verify(signature, DOMAIN + raw)
    except (InvalidSignature, ValueError, TypeError, UnicodeError) as exc:
        if isinstance(exc, GiftError):
            raise
        raise GiftError('invalid') from exc
    validate_payload(payload)
    if canonical(payload) != raw:
        raise GiftError('invalid')
    return payload, code


def _client(c):
    return recipient_code(c.execute('SELECT id FROM companion_client ORDER BY rowid LIMIT 1').fetchone()['id'])


def _receipt(c, payload, code):
    key = payload['kid'] + ':' + payload['id']
    row = c.execute('SELECT * FROM companion_gifts WHERE id=?', (key,)).fetchone()
    if row and row['code'] != code:
        raise GiftError('conflict')
    return row


def _eligible(c, payload, code, *, now=None):
    receipt = _receipt(c, payload, code)
    # Retrying an already committed claim remains successful after its deadline.
    if receipt:
        return receipt
    if payload['recipient'] not in ('*', _client(c)):
        raise GiftError('recipient')
    current = now or growth._now()
    timestamp = int(current.timestamp())
    if payload['issued'] > timestamp + 300:
        raise GiftError('future')
    if payload['expires'] and timestamp >= payload['expires']:
        raise GiftError('expired')
    return None


def preview(code):
    payload, code = verify(code)
    with growth.connection() as c:
        c.execute('BEGIN')
        receipt = _eligible(c, payload, code)
        owned = {row['item'] for row in c.execute('SELECT item FROM companion_inventory')}
        return {'id': payload['id'], 'title': payload['title'], 'exclusive': payload['recipient'] != '*',
                'expires': payload['expires'], 'claimed': bool(receipt),
                'items': [{'id': item, 'slot': growth.ITEMS[item]['slot'], 'owned': item in owned} for item in payload['items']]}


def claim(code):
    payload, code = verify(code)
    with growth.connection() as c:
        c.execute('BEGIN IMMEDIATE')
        if not _eligible(c, payload, code):
            now = growth._now().isoformat()
            c.executemany('INSERT OR IGNORE INTO companion_inventory VALUES(?,?)', [(item, now) for item in payload['items']])
            c.execute('INSERT INTO companion_gifts VALUES(?,?,?,?,?,?)',
                      (payload['kid'] + ':' + payload['id'], code, payload['title'], json.dumps(payload['items']), payload['recipient'], now))
        # No automatic equip: previewing/claiming a gift must not replace an existing outfit.
        return growth._snapshot(c)
