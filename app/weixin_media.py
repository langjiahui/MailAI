"""Bounded encrypted attachment uploads following Tencent's iLink media protocol."""
import base64
import hashlib
import re
import secrets
from urllib.parse import quote, urlsplit

MAX_BYTES = 20 * 1024 * 1024
CDN = 'https://novac2c.cdn.weixin.qq.com/c2c'


def upload_url(result, filekey):
    url = result.get('upload_full_url')
    if not url:
        param = result.get('upload_param')
        if not isinstance(param, str) or not param or len(param) > 16384:
            raise RuntimeError('微信未提供附件上传地址')
        url = CDN + '/upload?encrypted_query_param=' + quote(param, safe='') + '&filekey=' + filekey
    try:
        p = urlsplit(url)
        if (p.scheme != 'https' or p.hostname != 'novac2c.cdn.weixin.qq.com' or p.port not in (None, 443)
                or p.username or p.password or p.fragment or p.path != '/c2c/upload' or len(url) > 32768):
            raise ValueError()
    except (TypeError, ValueError):
        raise RuntimeError('微信附件上传地址不受信任') from None
    return url


def send(saved, token, user, context, client_id, attachment, mode, allowed):
    from .weixin_remote import _request
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.primitives.padding import PKCS7
    import requests
    payload = attachment['payload']
    if len(payload) > MAX_BYTES or not allowed():
        raise RuntimeError('附件大小或授权已变化')
    key, filekey = secrets.token_bytes(16), secrets.token_hex(16)
    padder = PKCS7(128).padder()
    padded = padder.update(payload) + padder.finalize()
    encryptor = Cipher(algorithms.AES(key), modes.ECB()).encryptor()
    ciphertext = encryptor.update(padded) + encryptor.finalize()
    result = _request(saved['base_url'], '/ilink/bot/getuploadurl', token=token, read_timeout=15, body={
        'filekey': filekey, 'media_type': 1 if mode == 'image' else 3, 'to_user_id': user,
        'rawsize': len(payload), 'rawfilemd5': hashlib.md5(payload).hexdigest(),
        'filesize': len(ciphertext), 'no_need_thumb': True, 'aeskey': key.hex()})
    if result.get('ret', 0) or result.get('errcode', 0):
        raise RuntimeError('微信附件上传参数不可用')
    url = upload_url(result, filekey)
    if not allowed():
        raise RuntimeError('附件授权已取消')
    # Only ciphertext goes to the CDN; never forward the bot Authorization header.
    with requests.post(url, data=ciphertext, headers={'Content-Type': 'application/octet-stream'},
                       timeout=(5, 30), allow_redirects=False, stream=True) as response:
        param = response.headers.get('x-encrypted-param')
        if response.status_code != 200 or not isinstance(param, str) or not param or len(param) > 16384:
            raise RuntimeError('微信附件上传未完成')
    media = {'encrypt_query_param': param, 'aes_key': base64.b64encode(key.hex().encode()).decode(), 'encrypt_type': 1}
    name = str(attachment.get('name') or '附件').replace('\\', '/').split('/')[-1]
    name = re.sub(r'[\x00-\x1f\x7f]', '', name)[:200] or '附件'
    item = ({'type': 2, 'image_item': {'media': media, 'mid_size': len(ciphertext)}} if mode == 'image' else
            {'type': 4, 'file_item': {'media': media, 'file_name': name, 'len': str(len(payload))}})
    if not allowed():
        raise RuntimeError('附件授权已取消')
    result = _request(saved['base_url'], '/ilink/bot/sendmessage', token=token, read_timeout=15,
        body={'msg': {'from_user_id': '', 'to_user_id': user, 'client_id': client_id + '-media',
                      'message_type': 2, 'message_state': 2, 'context_token': context, 'item_list': [item]}})
    if result.get('ret', 0) or result.get('errcode', 0):
        raise RuntimeError('微信未确认接收附件')
