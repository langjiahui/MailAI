"""Personal WeChat text channel using Tencent's published iLink protocol.

Protocol reference: Tencent/openclaw-weixin/docs/protocol_zh_CN.md.
No OpenClaw installation, browser automation, or public callback port is needed.
"""
import base64
import hashlib
import io
import json
import logging
import secrets
import threading
import time
from contextlib import closing
from urllib.parse import urlsplit

from . import credential_store, remote_control

BASE_URL = 'https://ilinkai.weixin.qq.com'
PROTOCOL_VERSION = '2.4.8'
_lock = threading.RLock()
_login = None
_thread = None
_stop = threading.Event()
_generation = 0
_state = {'phase': 'disabled', 'message': '未连接微信'}
_notice_context = None  # Recent authorized conversation only; never persist its platform token.
_presence_announced = False
_last_recovery_notice = float('-inf')
log = logging.getLogger(__name__)


def trusted_base(value):
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except (TypeError, ValueError) as exc:
        raise ValueError('微信返回的连接地址不受信任') from exc
    if (parsed.scheme != 'https' or not parsed.hostname or
            not (parsed.hostname == 'weixin.qq.com' or parsed.hostname.endswith('.weixin.qq.com')) or
            parsed.username or parsed.password or port not in (None, 443) or parsed.path not in ('', '/') or parsed.query or parsed.fragment):
        raise ValueError('微信返回的连接地址不受信任')
    return 'https://' + parsed.hostname


def _request(base, path, *, token='', body=None, params=None, read_timeout=20, connect_timeout=8):
    import requests
    base = trusted_base(base)
    headers = {'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': str((2 << 16) | (4 << 8) | 8)}
    if body is not None:
        headers.update({'Content-Type': 'application/json', 'AuthorizationType': 'ilink_bot_token',
                        'X-WECHAT-UIN': base64.b64encode(str(secrets.randbits(32)).encode()).decode()})
    if token:
        headers['Authorization'] = 'Bearer ' + token
        body = {**(body or {}), 'base_info': {'channel_version': PROTOCOL_VERSION, 'bot_agent': 'MailAI/1.0'}}
    response = requests.request('POST' if body is not None else 'GET', base + path, headers=headers,
                                json=body, params=params, timeout=(connect_timeout, read_timeout), allow_redirects=False)
    response.raise_for_status()
    if not 200 <= response.status_code < 300:
        raise ValueError('微信连接发生重定向')
    data = response.json()
    if not isinstance(data, dict):
        raise ValueError('微信返回格式无效')
    return data


def _status(phase, message):
    with _lock:
        _state.update(phase=phase, message=message)


def status():
    with _lock:
        return dict(_state)


@remote_control.config_change
def save_config(payload):
    with remote_control.LOCK:
        saved = remote_control.settings('weixin')
        previous = saved.copy()
        ids = payload.get('account_ids', [])
        accounts = remote_control.system_settings._load_registry().get('accounts', {})
        if not isinstance(ids, list) or len(ids) > 20 or any(not isinstance(i, str) or i not in accounts or not accounts[i].get('visible', True) for i in ids):
            raise ValueError('请选择可控制的邮箱')
        saved['enabled'] = bool(payload.get('enabled', False))
        saved['ai_enabled'] = bool(payload.get('ai_enabled', False))
        saved['account_ids'] = list(dict.fromkeys(ids))
        if saved['enabled'] and (not saved['bot_id'] or not saved['user_id'] or not ids or
                                 not credential_store.load('remote-weixin:' + saved['bot_id'])):
            raise ValueError('请先扫码连接本人微信并选择邮箱')
        with closing(remote_control.connection()) as c, c:
            c.execute('INSERT OR REPLACE INTO settings VALUES(2,?)', (json.dumps(saved),))
            if any(previous.get(k) != saved.get(k) for k in ('enabled', 'account_ids')):
                c.execute("DELETE FROM sessions WHERE id LIKE 'weixin:%'")
                c.execute('DELETE FROM weixin_pending WHERE bot_id=?', (saved['bot_id'],))
        return remote_control.public_config('weixin')


def begin_login():
    global _login
    if not credential_store.available():
        raise ValueError('系统凭据库不可用，无法安全保存微信登录凭证')
    if remote_control.settings('weixin')['enabled']:
        raise ValueError('请先关闭微信控制，再重新扫码连接')
    data = _request(BASE_URL, '/ilink/bot/get_bot_qrcode', body={'local_token_list': []}, params={'bot_type': '3'})
    content = data.get('qrcode_img_content')
    code = data.get('qrcode')
    if not isinstance(content, str) or not isinstance(code, str) or not code or not content or max(len(code), len(content)) > 8192:
        raise ValueError('未能获取微信二维码，请稍后重试')
    import qrcode
    output = io.BytesIO()
    qrcode.make(content).save(output, format='PNG')
    login_id = secrets.token_urlsafe(24)
    with _lock:
        _login = {'id': login_id, 'qrcode': code, 'base': BASE_URL, 'expires': time.time() + 240}
    return {'login_id': login_id, 'image': 'data:image/png;base64,' + base64.b64encode(output.getvalue()).decode(),
            'status': 'wait', 'message': '请用本人微信扫一扫，并在手机确认连接'}


def cancel_login(login_id):
    global _login
    with _lock:
        if _login and _login['id'] == login_id:
            _login = None


def poll_login(login_id, verify_code=''):
    global _login
    with _lock:
        current = dict(_login or {})
    if current.get('id') != login_id or time.time() > current.get('expires', 0):
        return {'status': 'expired', 'message': '二维码已过期，请重新获取'}
    params = {'qrcode': current['qrcode']}
    if verify_code:
        if not verify_code.isascii() or not verify_code.isdigit() or len(verify_code) > 12:
            raise ValueError('请填写手机显示的数字验证码')
        params['verify_code'] = verify_code
    data = _request(current['base'], '/ilink/bot/get_qrcode_status', params=params, read_timeout=15)
    state = data.get('status', 'wait')
    if state == 'scaned_but_redirect':
        host = data.get('redirect_host') or ''
        redirected = trusted_base(host if host.startswith('https://') else 'https://' + host)
        with _lock:
            if _login and _login['id'] == login_id:
                _login['base'] = redirected
        return {'status': 'wait', 'message': '已扫码，正在完成连接'}
    if state == 'confirmed':
        token, bot_id, user_id = (data.get(k) for k in ('bot_token', 'ilink_bot_id', 'ilink_user_id'))
        if not all(isinstance(v, str) and v and len(v) <= 8192 for v in (token, bot_id, user_id)):
            raise ValueError('微信未返回完整的本人身份，请重新扫码')
        base = trusted_base(data.get('baseurl') or current['base'])
        with remote_control.CONFIG_GATE.write(), remote_control.LOCK, _lock:
            if not _login or _login['id'] != login_id:
                return {'status': 'expired', 'message': '此二维码已被替换，请使用新二维码'}
            if not credential_store.save('remote-weixin:' + bot_id, token):
                raise ValueError('本机凭据库保存失败，请检查钥匙串或 Windows 凭据管理器')
            saved = remote_control.settings('weixin')
            old_bot_id = saved['bot_id']
            saved.update(enabled=False, bot_id=bot_id, user_id=user_id, base_url=base)
            with closing(remote_control.connection()) as c, c:
                c.execute('INSERT OR REPLACE INTO settings VALUES(2,?)', (json.dumps(saved),))
                c.execute("DELETE FROM sessions WHERE id LIKE 'weixin:%'")
                if old_bot_id != bot_id:
                    c.execute('DELETE FROM sessions WHERE id=?', ('weixin-cursor:' + old_bot_id,))
                    c.execute('DELETE FROM weixin_pending WHERE bot_id=?', (old_bot_id,))
            _login = None
            if old_bot_id and old_bot_id != bot_id:
                try:
                    credential_store.delete('remote-weixin:' + old_bot_id)
                except Exception:
                    pass  # Successful new binding must not fail on old-key cleanup.
        _status('disabled', '微信已绑定 · 选择邮箱后启用')
        return {'status': 'confirmed', 'message': '微信已连接本人身份，请选择邮箱并启用控制',
                'config': remote_control.public_config('weixin')}
    messages = {'wait': '等待本人微信扫码', 'scaned': '已扫码，请在手机确认',
                'need_verifycode': '请输入手机显示的验证码', 'expired': '二维码已过期，请重新获取',
                'verify_code_blocked': '验证码尝试次数过多，请重新获取二维码',
                'binded_redirect': '该机器人已经绑定，请检查微信连接后重新获取二维码'}
    return {'status': state, 'message': messages.get(state, '等待微信确认')}


def _cursor(bot_id, value=None):
    # Cursor contains no credential; persist only after processing a complete batch.
    key = 'weixin-cursor:' + bot_id
    with closing(remote_control.connection()) as c, c:
        if value is not None:
            c.execute('INSERT OR REPLACE INTO sessions VALUES(?,?)', (key, json.dumps(value)))
            return value
        row = c.execute('SELECT value FROM sessions WHERE id=?', (key,)).fetchone()
        return json.loads(row[0]) if row else ''


def _queue_update_batch(saved, result):
    """Commit a batch's replyable messages and cursor in one local transaction."""
    messages = result.get('msgs') or []
    if not isinstance(messages, list):
        raise ValueError('微信消息批次格式无效')
    bot_id = saved['bot_id']
    with closing(remote_control.connection()) as c, c:
        for message in messages:
            if (not isinstance(message, dict) or message.get('message_type') != 1 or message.get('group_id')
                    or message.get('from_user_id') != saved.get('user_id')):
                continue
            message_id = message.get('message_id') or message.get('client_id')
            context = message.get('context_token')
            if isinstance(message_id, int) and not isinstance(message_id, bool):
                message_id = str(message_id)
            if (not isinstance(message_id, str) or not message_id or len(message_id) > 512
                    or not isinstance(context, str) or not context or len(context) > 8192):
                continue
            items = message.get('item_list')
            if not isinstance(items, list):
                continue
            compact_items = []
            for item in items[:16]:
                if not isinstance(item, dict):
                    continue
                if item.get('type') == 1 and isinstance(item.get('text_item'), dict):
                    value = item['text_item'].get('text')
                    if isinstance(value, str):
                        compact_items.append({'type': 1, 'text_item': {'text': value[:4001]}})
                elif item.get('type') == 3 and isinstance(item.get('voice_item'), dict):
                    value = item['voice_item'].get('text')
                    if isinstance(value, str):
                        compact_items.append({'type': 3, 'voice_item': {'text': value[:4001]}})
            if not compact_items:
                continue
            payload = {'message_type': 1, 'from_user_id': saved['user_id'], 'message_id': message_id,
                       'client_id': message.get('client_id') if isinstance(message.get('client_id'), str) else '',
                       'context_token': context, 'item_list': compact_items}
            pending_id = hashlib.sha256((bot_id + ':' + message_id).encode()).hexdigest()
            c.execute('INSERT OR IGNORE INTO weixin_pending(id,bot_id,payload,created) VALUES(?,?,?,?)',
                      (pending_id, bot_id, json.dumps(payload, ensure_ascii=False), time.time()))
        count = c.execute('SELECT COUNT(*) FROM weixin_pending WHERE bot_id=?', (bot_id,)).fetchone()[0]
        if count > 1000:
            raise RuntimeError('微信待回传指令过多，已暂停接收新指令')
        cursor = result.get('get_updates_buf')
        if cursor:
            c.execute('INSERT OR REPLACE INTO sessions VALUES(?,?)',
                      ('weixin-cursor:' + bot_id, json.dumps(cursor)))
        return cursor, count


def _drain_pending(saved, token, stop):
    """A bad reply is deferred without pinning all later platform updates."""
    import requests
    bot_id = saved['bot_id']
    with closing(remote_control.connection()) as c:
        pending = c.execute('SELECT id,payload,attempts FROM weixin_pending '
                            'WHERE bot_id=? AND retry_at<=? ORDER BY created,id LIMIT 8',
                            (bot_id, time.time())).fetchall()
    for row in pending:
        if stop.is_set():
            break
        try:
            process_message(saved, token, json.loads(row['payload']))
        except Exception as exc:
            attempts = row['attempts'] + 1
            with closing(remote_control.connection()) as c, c:
                c.execute('UPDATE weixin_pending SET attempts=?,retry_at=? WHERE id=?',
                          (attempts, time.time() + min(300, 2 ** min(attempts, 8)), row['id']))
            log.warning('微信指令回传待重试（%s）', type(exc).__name__)
            if isinstance(exc, requests.RequestException):
                break  # A shared connection failure should not trigger eight long waits.
        else:
            with closing(remote_control.connection()) as c, c:
                c.execute('DELETE FROM weixin_pending WHERE id=?', (row['id'],))
    with closing(remote_control.connection()) as c:
        return c.execute('SELECT COUNT(*) FROM weixin_pending WHERE bot_id=?', (bot_id,)).fetchone()[0]


def process_message(saved, token, message):
    global _notice_context, _presence_announced
    if (not isinstance(message, dict) or message.get('message_type') != 1 or message.get('group_id')
            or not isinstance(message.get('context_token'), str) or not message['context_token']):
        return
    user = message.get('from_user_id') or ''
    if not isinstance(user, str):
        return
    items = message.get('item_list') or []
    if not isinstance(items, list):
        return
    text = '\n'.join(item['text_item']['text'] for item in items if isinstance(item, dict)
                     and item.get('type') == 1 and isinstance(item.get('text_item'), dict)
                     and isinstance(item['text_item'].get('text'), str))
    voice_hint = ''
    if not text:
        voices = [item['voice_item'].get('text') for item in items if isinstance(item, dict)
                  and item.get('type') == 3 and isinstance(item.get('voice_item'), dict)]
        if not voices:
            return
        from .remote_commands import canonicalize
        transcript = voices[0] if len(voices) == 1 and isinstance(voices[0], str) else ''
        command = canonicalize(transcript.strip()) if len(transcript) <= 4000 else None
        # A transcription can be wrong. Voice is read/query only, never SMTP confirmation.
        if command and (command in ('帮助', '状态', '最新邮件', '未读邮件', '新邮件', '更多新邮件', '今日简报',
                                    '重要邮件', '今天待办', '下一封', '上一封', '返回列表', '返回待办',
                                    '下一项', '上一项', '查看当前邮件', '查看当前待办', '附件列表', '邮箱列表')
                        or command.startswith(('查看第 ', '查看待办', '附件列表第 ', '时间邮件 '))):
            text = command
            voice_hint = '按微信提供的语音转写执行查询；识别有误时请用文字更正。\n\n'
        else:
            text = '帮助'
            voice_hint = '语音暂只支持明确查询（例如“最新邮件”“查看第一封”）。发信、确认和附件传输请使用文字；无转写时请改用文字。\n\n'
    response = remote_control.handle_message(channel='weixin', staff_id=user,
                    conversation_id=user, message_id=str(message.get('message_id') or message.get('client_id') or ''),
                    text=text, private=True, binding_id=saved['bot_id'])
    if response is None:
        return
    response = voice_hint + response
    if user != saved.get('user_id'):
        return
    with _lock:
        _notice_context = {'bot_id': saved['bot_id'], 'user_id': user,
                           'context_token': message['context_token'], 'at': time.monotonic()}
        announce = not _presence_announced
    if announce:
        response += ('\n\nMailAI 电脑端已启动并连接。请保持电脑开机联网、MailAI 运行；关机、休眠或断网时无法回复，'
                     '也无法保证立即通知。恢复后可发“状态”核对；发信结果不明时先核对发件箱。')
    # Stable outbound ID when a platform batch or SMTP confirmation is replayed.
    import hashlib
    client_id = 'mailai-' + hashlib.sha256(f'{saved["bot_id"]}:{message.get("message_id")}:{message.get("client_id")}'.encode()).hexdigest()[:32]
    result = _request(saved['base_url'], '/ilink/bot/sendmessage', token=token, body={
        'msg': {'from_user_id': '', 'to_user_id': user, 'client_id': client_id,
                'message_type': 2, 'message_state': 2, 'context_token': message['context_token'],
                'item_list': [{'type': 1, 'text_item': {'text': response}}]}})
    if result.get('ret', 0) != 0 or result.get('errcode', 0) != 0:
        raise ValueError('微信消息回传失败')
    remote_control.delivered(channel='weixin', staff_id=user, conversation_id=user,
        message_id=str(message.get('message_id') or message.get('client_id') or ''))
    with _lock:
        _presence_announced = True
    def feedback(text):
        result = _request(saved['base_url'], '/ilink/bot/sendmessage', token=token, body={
            'msg': {'from_user_id': '', 'to_user_id': user, 'client_id': client_id + '-sync',
                    'message_type': 2, 'message_state': 2, 'context_token': message['context_token'],
                    'item_list': [{'type': 1, 'text_item': {'text': text}}]}})
        if result.get('ret', 0) or result.get('errcode', 0):
            raise ValueError('同步反馈回传失败')
    remote_control.deliver_sync_feedback('weixin', str(message.get('message_id') or message.get('client_id') or ''), feedback, conversation_id=user)
    from . import remote_media, weixin_media
    active_stop = _stop
    def send_attachment(att, mode, allowed):
        weixin_media.send(saved, token, user, message['context_token'], client_id, att, mode,
                          lambda: not active_stop.is_set() and allowed())
    def media_feedback(text):
        result = _request(saved['base_url'], '/ilink/bot/sendmessage', token=token, body={
            'msg': {'from_user_id': '', 'to_user_id': user, 'client_id': client_id + '-media-result',
                    'message_type': 2, 'message_state': 2, 'context_token': message['context_token'],
                    'item_list': [{'type': 1, 'text_item': {'text': text}}]}})
        if result.get('ret', 0) or result.get('errcode', 0):
            raise RuntimeError('附件反馈回传失败')
    remote_media.deliver(saved, user, str(message.get('message_id') or message.get('client_id') or ''), send_attachment, media_feedback)


def _send_presence(saved, token, text):
    """Best effort, one attempt, and only while the same owner still authorizes control."""
    with _lock:
        context = dict(_notice_context or {})
    if (context.get('bot_id') != saved.get('bot_id') or context.get('user_id') != saved.get('user_id')
            or time.monotonic() - context.get('at', float('-inf')) > 1800):
        return False
    try:
        current = remote_control.settings('weixin')
        if not current.get('enabled') or any(current.get(k) != saved.get(k) for k in ('bot_id', 'user_id', 'base_url')):
            return False
        result = _request(saved['base_url'], '/ilink/bot/sendmessage', token=token,
            connect_timeout=1, read_timeout=1, body={'msg': {
                'from_user_id': '', 'to_user_id': context['user_id'],
                'client_id': 'mailai-presence-' + secrets.token_hex(16),
                'message_type': 2, 'message_state': 2, 'context_token': context['context_token'],
                'item_list': [{'type': 1, 'text_item': {'text': text}}]}})
        return not result.get('ret', 0) and not result.get('errcode', 0)
    except Exception:
        return False  # Expired conversation or failed notices never retry mail operations.


def _listen(saved, token, stop):
    import requests
    global _last_recovery_notice
    cursor, delay, disconnected_at = _cursor(saved['bot_id']), 2, None
    while not stop.is_set():
        try:
            _drain_pending(saved, token, stop)
            if stop.is_set():
                break
            result = _request(saved['base_url'], '/ilink/bot/getupdates', token=token,
                              body={'get_updates_buf': cursor}, read_timeout=40)
            if stop.is_set():
                break
            if result.get('ret') == -14 or result.get('errcode') == -14:
                _status('expired', '微信登录已失效，请关闭控制后重新扫码')
                return
            if result.get('ret', 0) != 0 or result.get('errcode', 0) != 0:
                raise ValueError('微信收取失败')
            now = time.monotonic()
            if disconnected_at is not None:
                if now - disconnected_at >= 30 and now - _last_recovery_notice >= 300:
                    _last_recovery_notice = now
                    _send_presence(saved, token, 'MailAI 电脑端已恢复连接。可发“状态”或“最新邮件”核对；'
                                   '此前未收到结果的发信请先检查发件箱，勿直接重发。')
                disconnected_at = None
            if not stop.is_set():
                if result.get('msgs'):
                    with remote_control.CONFIG_GATE.read():
                        current = remote_control.settings('weixin')
                        if (not current.get('enabled') or any(current.get(key) != saved.get(key)
                                for key in ('bot_id', 'user_id', 'base_url'))):
                            return
                        next_cursor, outstanding = _queue_update_batch(saved, result)
                else:
                    next_cursor, outstanding = _queue_update_batch(saved, result)
                if next_cursor:
                    cursor = next_cursor
                outstanding = _drain_pending(saved, token, stop)
                _status('connected', (f'已连接 · {outstanding} 条手机回复待重试' if outstanding
                                      else '已连接 · 仅接受扫码本人指令'))
            delay = 2
            stop.wait(.2)  # Avoid a busy loop if the service returns immediately.
        except requests.exceptions.ReadTimeout:
            continue  # A long-poll timeout does not imply a broken login.
        except requests.exceptions.HTTPError as exc:
            if exc.response is not None and exc.response.status_code in (401, 403):
                _status('expired', '微信凭证已失效或访问被拒绝，请关闭控制后重新扫码')
                return
            if stop.is_set():
                break
            _status('reconnecting', '微信服务暂不可用，正在自动重试')
            if disconnected_at is None:
                disconnected_at = time.monotonic()
            stop.wait(delay)
            delay = min(delay * 2, 60)
        except Exception:
            if stop.is_set():
                break
            _status('reconnecting', '微信连接或回传暂不可用，正在重试；发送结果不明时请先在 MailAI 核对')
            if disconnected_at is None:
                disconnected_at = time.monotonic()
            stop.wait(delay)
            delay = min(delay * 2, 60)


def start():
    global _thread, _stop, _presence_announced
    with _lock:
        if _thread and _thread.is_alive():
            return
        saved = remote_control.settings('weixin')
        if not saved['enabled']:
            _state.update(phase='disabled', message='已绑定 · 未启用' if saved['bot_id'] else '未连接微信')
            return
        token = credential_store.load('remote-weixin:' + saved['bot_id'])
        if not token:
            _state.update(phase='error', message='微信凭证不可用，请重新扫码')
            return
        stop = threading.Event()
        _stop = stop
        _presence_announced = False
        _state.update(phase='connecting', message='正在连接微信')
        def run():
            try:
                _listen(saved, token, stop)
            finally:
                if stop.is_set():
                    _status('disabled', '已断开')
        _thread = threading.Thread(target=run, daemon=True, name='weixin-remote')
        _thread.start()


def stop(timeout=1, *, notify=False):
    global _generation
    with _lock:
        _generation += 1
        _stop.set()
        thread = _thread
    if notify and thread and thread.is_alive():
        def announce_exit():
            try:
                saved = remote_control.settings('weixin')
                token = credential_store.load('remote-weixin:' + saved.get('bot_id', ''))
                if token:
                    _send_presence(saved, token, 'MailAI 电脑端正在退出，手机邮件控制将暂停。'
                                   '请重新启动电脑端并保持联网后再查询；突然断网或关机时可能无法通知。')
            except Exception:
                pass
        worker = threading.Thread(target=announce_exit, daemon=True, name='weixin-exit-notice')
        worker.start()
        worker.join(1.5)  # A network failure must not hold the application open.
    if thread and thread.is_alive():
        thread.join(timeout)
    return not thread or not thread.is_alive()


def restart():
    if not stop():
        _status('stopping', '正在结束上一连接，随后自动更新连接状态')
        previous = _thread
        generation = _generation
        def resume():
            previous.join()
            with _lock:
                if generation == _generation:
                    start()
        threading.Thread(target=resume, daemon=True, name='weixin-reconnect').start()
        return status()
    start()
    return status()
