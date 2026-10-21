#!/usr/bin/env python3
"""Owner-only gift issuer. Not imported by the app or included in desktop builds."""
import argparse
import ast
import getpass
import hashlib
import json
import os
import secrets
import sqlite3
import re
from contextlib import contextmanager
import sys
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from app import companion_gifts as gifts, companion_growth as growth

DEFAULT_HOME = Path.home() / '.mailai-gift-issuer'
SERVICE = 'MailAI Gift Issuer'
LABELS = {
    'scarf': '暖橙围巾',
    'sky': '晴空蓝',
    'peach': '蜜桃粉',
    'cap': '信使帽',
    'satchel': '金色邮包',
    'sparkles': '点点星光',
    'orbit': '星环轨迹',
    'wings': '晴羽信使翼',
    'aurora': '极光涟漪',
    'midnight': '星夜蓝',
    'jacket': '云游披肩',
    'visor': '晴空护目镜',
    'armor': '星羽轻甲',
    'lightning': '电光脉冲',
    'mech_wings': '星羽机甲翼',
    'theme_monochrome': '黑白简约',
    'theme_baowu': '宝武蓝',
}
LABELS_EN = {
    'scarf': 'Warm scarf',
    'sky': 'Sky blue',
    'peach': 'Peach pink',
    'cap': 'Messenger cap',
    'satchel': 'Golden satchel',
    'sparkles': 'Little sparkles',
    'orbit': 'Star orbit',
    'wings': 'Sunlit messenger wings',
    'aurora': 'Aurora ripples',
    'midnight': 'Starlit blue',
    'jacket': 'Wanderer capelet',
    'visor': 'Clear-sky goggles',
    'armor': 'Starfeather armor',
    'lightning': 'Electric pulse',
    'mech_wings': 'Starfeather mech wings',
    'theme_monochrome': 'Monochrome',
    'theme_baowu': 'Baowu blue',
}


def secure_write(path, content):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'wb') as destination:
        destination.write(content)


def vault():
    # Do not silently fall back to a plaintext keyring backend.
    try:
        import keyring
    except ImportError as exc:
        raise ValueError('请先安装发放工具依赖：pip install -r scripts/requirements-gift-issuer.txt') from exc
    if sys.platform == 'darwin':
        from keyring.backends.macOS import Keyring
        return Keyring()
    backend = keyring.get_keyring()
    if backend.__class__.__module__.startswith(('keyrings.alt', 'keyring.backends.fail', 'keyring.backends.null')):
        raise ValueError('系统安全凭据库不可用，请改用密码解锁模式')
    return backend


def account(home):
    return hashlib.sha256(str(Path(home).resolve()).encode()).hexdigest()


def load_key(home, password=None):
    home = Path(home)
    if not (home / 'issuer.pem').is_file():
        raise ValueError('发放密钥尚未初始化，请先运行 init')
    if password is None:
        if (home / 'keychain.json').exists():
            password = vault().get_password(SERVICE, account(home))
            if not password:
                raise ValueError('钥匙串中没有解锁凭据，请恢复发放密钥与解锁凭据')
        else:
            password = getpass.getpass('发放密钥密码：')
    try:
        key = serialization.load_pem_private_key((home / 'issuer.pem').read_bytes(), password=password.encode())
    except (ValueError, TypeError) as exc:
        raise ValueError('发放密钥无法解锁，请核对密码或备份') from exc
    if not isinstance(key, Ed25519PrivateKey):
        raise ValueError('发放密钥类型不正确')
    return key


def public(key):
    raw = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return hashlib.sha256(raw).hexdigest()[:16], raw.hex()


def export_public(key, path):
    path = Path(path)
    keys = {}
    if path.exists():
        for node in ast.parse(path.read_text()).body:
            if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'TRUSTED_KEYS' for t in node.targets):
                keys = ast.literal_eval(node.value)
    if not isinstance(keys, dict):
        raise ValueError('公钥配置格式错误')
    kid, value = public(key)
    keys[kid] = value
    path.write_text('"""Public verification keys only. Never store issuer secrets here."""\nTRUSTED_KEYS = '+repr(keys)+'\n')
    return kid


def initialize(home, *, keychain=False, public_output=None):
    home = Path(home).resolve()
    repo = Path(__file__).resolve().parents[1]
    if home.is_relative_to(repo):
        raise ValueError('发放私钥必须保存在项目目录之外')
    if (home / 'issuer.pem').exists():
        raise ValueError('发放密钥已存在，保留原密钥；需要导出公钥时运行 public')
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    home.chmod(0o700)
    password = secrets.token_urlsafe(48) if keychain else getpass.getpass('设置发放密钥密码（至少 12 位）：')
    if len(password) < 12 or (not keychain and password != getpass.getpass('再次输入密码：')):
        raise ValueError('密码过短或两次输入不一致')
    key = Ed25519PrivateKey.generate()
    encrypted = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                  serialization.BestAvailableEncryption(password.encode()))
    if keychain:
        backend = vault()
        backend.set_password(SERVICE, account(home), password)
        if backend.get_password(SERVICE, account(home)) != password:
            raise ValueError('安全凭据保存未通过校验，未创建私钥文件')
    secure_write(home / 'issuer.pem', encrypted)
    if keychain:
        secure_write(home / 'keychain.json', b'{"service":"MailAI Gift Issuer"}\n')
    kid, value = public(key)
    secure_write(home / 'public.json', json.dumps({'kid':kid,'public':value}).encode())
    if public_output:
        export_public(key, public_output)
    return kid


def issue(key, items, *, title, recipient='*', days=0, now=None):
    if type(days) is not int or not 0 <= days <= 3650:
        raise ValueError('领取期限应为 0 到 3650 天，0 表示不限期')
    now = int(time.time()) if now is None else now
    kid, _ = public(key)
    payload = dict(v=1, kid=kid, id=uuid4().hex, title=title.strip(), items=items,
                   recipient=gifts.normalize_recipient(recipient), issued=now, expires=now+days*86400 if days else 0)
    gifts.validate_payload(payload)
    raw = gifts.canonical(payload)
    code = 'XYG1.'+gifts.encode(raw)+'.'+gifts.encode(key.sign(gifts.DOMAIN+raw))
    return payload, code


@contextmanager
def records(home):
    path = Path(home) / 'issued.sqlite3'
    if not path.exists():
        try:
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.close(descriptor)
        except FileExistsError:
            pass
    connection = sqlite3.connect(path, timeout=15)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("CREATE TABLE IF NOT EXISTS gifts (id TEXT PRIMARY KEY, kid TEXT NOT NULL, payload TEXT NOT NULL, request_id TEXT UNIQUE, request_hash TEXT)")
        # Preserve metadata written by the first issuer version. No private key/code is stored.
        legacy = Path(home) / 'issued.jsonl'
        if legacy.exists():
            for line in legacy.read_text(encoding='utf-8').splitlines():
                try:
                    payload = json.loads(line); gifts.validate_payload(payload)
                except (ValueError, TypeError):
                    continue
                connection.execute('INSERT OR IGNORE INTO gifts VALUES(?,?,?,NULL,NULL)', (payload['id'],payload['kid'],json.dumps(payload,ensure_ascii=False)))
        connection.commit()
        yield connection
        connection.commit()
    except BaseException:
        connection.rollback(); raise
    finally:
        connection.close()


def voucher(key, payload):
    raw = gifts.canonical(payload)
    return 'XYG1.'+gifts.encode(raw)+'.'+gifts.encode(key.sign(gifts.DOMAIN+raw))


def record(home, payload):
    with records(home) as c:
        c.execute('INSERT INTO gifts VALUES(?,?,?,NULL,NULL)', (payload['id'],payload['kid'],json.dumps(payload,ensure_ascii=False)))


def issue_saved(home, key, data):
    request_id = data.get('request_id')
    if not isinstance(request_id,str) or not re.fullmatch(r'[a-zA-Z0-9-]{8,80}',request_id):
        raise ValueError('发放请求缺少有效编号，请刷新页面后重试')
    items, title, days = data['items'], data['title'], data['days']
    recipient = gifts.normalize_recipient(data['recipient'])
    # Validate before reading a receipt. A repeated request may never change its gifts.
    payload, code = issue(key,items,title=title,recipient=recipient,days=days)
    fingerprint = hashlib.sha256(gifts.canonical(dict(items=items,title=title.strip(),recipient=recipient,days=days))).hexdigest()
    with records(home) as c:
        c.execute('BEGIN IMMEDIATE')
        existing = c.execute('SELECT * FROM gifts WHERE request_id=?',(request_id,)).fetchone()
        if existing:
            if existing['request_hash'] != fingerprint or existing['kid'] != payload['kid']:
                raise ValueError('发放请求与原记录不一致，请重新填写后生成')
            payload = json.loads(existing['payload']); code = voucher(key,payload)
        else:
            c.execute('INSERT INTO gifts VALUES(?,?,?,?,?)', (payload['id'],payload['kid'],json.dumps(payload,ensure_ascii=False),request_id,fingerprint))
    return payload, code


def history(home, key):
    kid,_ = public(key)
    with records(home) as c:
        rows = c.execute('SELECT payload FROM gifts WHERE kid=? ORDER BY rowid DESC LIMIT 20',(kid,)).fetchall()
    result=[]
    for row in rows:
        payload=json.loads(row['payload']);gifts.validate_payload(payload)
        result.append(packet(key,payload,voucher(key,payload)))
    return result


def packet(key,payload,code):
    return dict(code=code,id=payload['id'],title=payload['title'],items=[LABELS[item] for item in payload['items']],item_ids=payload['items'],
                exclusive=payload['recipient']!='*',recipient=payload['recipient'],expires=payload['expires'],issued=payload['issued'])


def serve(home):
    key = load_key(home)
    kid, raw = public(key)
    if gifts.TRUSTED_KEYS.get(kid) != raw:
        raise ValueError('当前客户端尚未内置此发放公钥，请先导出公钥并重新构建客户端')
    session = secrets.token_urlsafe(32)
    prefix = '/' + session
    options = ''.join(f'<label><input type="checkbox" value="{item}"><span data-item="{item}">{LABELS[item]}</span></label>' for item in growth.ITEMS if item in LABELS)
    item_names = {item:[LABELS[item],LABELS_EN[item]] for item in LABELS}
    page = (Path(__file__).with_name('gift_issuer.html').read_text(encoding='utf-8')
            .replace('__OPTIONS__',options)
            .replace('__STYLES__',Path(__file__).with_name('gift_issuer.css').read_text(encoding='utf-8'))
            .replace('__SCRIPT__',Path(__file__).with_name('gift_issuer.js').read_text(encoding='utf-8'))
            .replace('__ITEM_NAMES__',json.dumps(item_names,ensure_ascii=False))).encode()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass  # Never log the capability URL or voucher contents.

        def response(self, status, content, mime='application/json'):
            self.send_response(status)
            self.send_header('Content-Type', mime+'; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Frame-Options', 'DENY')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
            self.end_headers(); self.wfile.write(content)

        def valid(self):
            return self.headers.get('Host') == address

        def do_GET(self):
            if not self.valid():
                return self.response(404,b'{}')
            if self.path == prefix+'/history':
                try: self.response(200,json.dumps(history(home,key),ensure_ascii=False).encode())
                except (OSError,sqlite3.DatabaseError,ValueError): self.response(500,b'{"error_key":"historyFailed"}')
            elif self.path == prefix:
                self.response(200, page, 'text/html')
            else:
                self.response(404,b'{}')

        def do_POST(self):
            if not self.valid() or self.path != prefix+'/issue' or self.headers.get('Origin') != 'http://'+address:
                return self.response(403, b'{}')
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 4096:
                    raise ValueError('请求过大或为空')
                data = json.loads(self.rfile.read(length))
                payload, code = issue_saved(home,key,data)
                self.response(200,json.dumps(packet(key,payload,code),ensure_ascii=False).encode())
            except (ValueError, KeyError, TypeError, AttributeError):
                self.response(400, json.dumps({'error_key':'invalid','error':'请核对领取编号、礼物名称，并选择 1 到 8 件礼物'},ensure_ascii=False).encode())
            except (OSError,sqlite3.DatabaseError):
                self.response(500, json.dumps({'error_key':'saveFailed','error':'发放记录保存失败，请检查文件权限'},ensure_ascii=False).encode())
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    address = '127.0.0.1:'+str(server.server_port)
    print('发放工具已启动，只接受本机访问。关闭此终端即可停止。', flush=True)
    webbrowser.open('http://'+address+prefix)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=Path, default=DEFAULT_HOME)
    commands = parser.add_subparsers(dest='command', required=True)
    init = commands.add_parser('init');init.add_argument('--keychain', action='store_true');init.add_argument('--public-output', type=Path)
    pub = commands.add_parser('public');pub.add_argument('--output', type=Path, required=True)
    send = commands.add_parser('issue');send.add_argument('--items', nargs='+', required=True);send.add_argument('--title', required=True)
    target=send.add_mutually_exclusive_group(required=True);target.add_argument('--recipient');target.add_argument('--campaign', action='store_true')
    send.add_argument('--days', type=int, default=0);send.add_argument('--output', type=Path, required=True)
    commands.add_parser('gui')
    args = parser.parse_args()
    try:
        if args.command == 'init':
            print('发放密钥已创建，公钥编号：'+initialize(args.home,keychain=args.keychain,public_output=args.public_output))
        elif args.command == 'public':
            print('公钥已导出：'+export_public(load_key(args.home),args.output))
        elif args.command == 'gui':
            serve(args.home)
        else:
            key = load_key(args.home)
            kid, value = public(key)
            if gifts.TRUSTED_KEYS.get(kid) != value:
                raise ValueError('客户端尚未内置当前发放公钥，请先导出公钥并重新构建')
            payload, code = issue(key,args.items,title=args.title,recipient='*' if args.campaign else args.recipient,days=args.days)
            secure_write(args.output,(code+'\n').encode());record(args.home,payload)
            print('礼券已保存：'+str(args.output)+'；编号：'+payload['id'])
    except Exception as exc:
        # Keychain/backend exceptions can contain credentials. Only expose our own validation text.
        print(str(exc) if type(exc) is ValueError or isinstance(exc,gifts.GiftError) else '操作失败（'+type(exc).__name__+'），请检查文件与系统凭据库', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
