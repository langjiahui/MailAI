"""Optional outbound DingTalk Stream connection; no public port or UI automation."""
import asyncio
import json
import logging
import threading
from urllib.parse import quote, urlsplit

from . import credential_store, remote_control

_lock = threading.RLock()
_thread = None
_stop = threading.Event()
_generation = 0
_state = {'phase': 'disabled', 'message': '未启用'}
_sdk_log = logging.getLogger('mailai.dingtalk.sdk')
_sdk_log.addHandler(logging.NullHandler())
_sdk_log.propagate = False
_sdk_log.disabled = True  # Upstream SDK logs connection tickets and raw payloads.


def _status(phase, message):
    with _lock:
        _state.update(phase=phase, message=message)


def status():
    with _lock:
        return dict(_state)


def open_connection(saved, secret):
    import requests
    from dingtalk_stream import DingTalkStreamClient, ChatbotMessage
    response = requests.post(DingTalkStreamClient.OPEN_CONNECTION_API,
                             json={'clientId': saved['client_id'], 'clientSecret': secret,
                                   'subscriptions': [{'type': 'CALLBACK', 'topic': ChatbotMessage.TOPIC}],
                                   'ua': 'MailAI-DingTalk/1.0'}, timeout=(10, 20), allow_redirects=False)
    response.raise_for_status()
    data = response.json()
    endpoint = urlsplit(data.get('endpoint', ''))
    if (endpoint.scheme != 'wss' or not endpoint.hostname or not endpoint.hostname.endswith('.dingtalk.com')
            or endpoint.username or endpoint.password or endpoint.port not in (None, 443) or endpoint.query or endpoint.fragment):
        raise ValueError('Unexpected stream endpoint')
    if not data.get('ticket'):
        raise ValueError('Missing stream ticket')
    return data


def reply_text(webhook, text):
    import requests
    target = urlsplit(webhook or '')
    if (target.scheme != 'https' or target.hostname not in ('oapi.dingtalk.com', 'api.dingtalk.com')
            or target.username or target.password or target.port not in (None, 443)):
        raise ValueError('Unexpected session webhook')
    response = requests.post(webhook, json={'msgtype': 'text', 'text': {'content': text}},
                             timeout=(10, 20), allow_redirects=False)
    response.raise_for_status()
    if response.json().get('errcode', 0) != 0:
        raise ValueError('DingTalk reply rejected')


async def _listen(saved, secret, stop):
    import dingtalk_stream as sdk
    import websockets

    class Handler(sdk.ChatbotHandler):
        async def process(self, callback):
            if stop.is_set():
                return sdk.AckMessage.STATUS_OK, 'OK'
            incoming = sdk.ChatbotMessage.from_dict(callback.data)
            if incoming.message_type != 'text' or incoming.text is None or not isinstance(incoming.text.content, str):
                return sdk.AckMessage.STATUS_OK, 'OK'
            response = await asyncio.to_thread(
                remote_control.handle_message, corp_id=incoming.sender_corp_id,
                staff_id=incoming.sender_staff_id, conversation_id=incoming.conversation_id,
                message_id=incoming.message_id, text=incoming.text.content,
                private=incoming.conversation_type == '1')
            if response is not None and not stop.is_set():
                try:
                    await asyncio.to_thread(reply_text, incoming.session_webhook, response)
                    remote_control.delivered(channel='dingtalk', corp_id=incoming.sender_corp_id,
                        staff_id=incoming.sender_staff_id, conversation_id=incoming.conversation_id,
                        message_id=incoming.message_id)
                    webhook = incoming.session_webhook
                    remote_control.deliver_sync_feedback('dingtalk', incoming.message_id,
                        lambda text: reply_text(webhook, text) if not stop.is_set() else None,
                        conversation_id=incoming.conversation_id)
                except Exception:
                    _status('reply_failed', '结果未能回传手机，请在 MailAI 核对；连接仍在运行')
                    return sdk.AckMessage.STATUS_SYSTEM_EXCEPTION, 'Reply unavailable'
            return sdk.AckMessage.STATUS_OK, 'OK'

    client = sdk.DingTalkStreamClient(sdk.Credential(saved['client_id'], secret), logger=_sdk_log)
    handler = Handler()
    handler.logger = _sdk_log
    client.register_callback_handler(sdk.ChatbotMessage.TOPIC, handler)
    client.pre_start()
    client.system_handler.logger = _sdk_log
    client.event_handler.logger = _sdk_log
    delay = 2
    callbacks = set()
    try:
        while not stop.is_set():
            try:
                _status('connecting', '正在连接钉钉')
                connection = await asyncio.to_thread(open_connection, saved, secret)
                if stop.is_set():
                    break
                uri = connection['endpoint'] + '?ticket=' + quote(connection['ticket'], safe='')
                async with websockets.connect(uri, open_timeout=15, ping_interval=20, ping_timeout=20, max_size=1024 * 1024) as ws:
                    client.websocket = ws
                    _status('connected', '已连接 · 仅接受本人单聊指令')
                    delay = 2
                    while not stop.is_set():
                        try:
                            raw = await asyncio.wait_for(ws.recv(), timeout=1)
                        except asyncio.TimeoutError:
                            continue
                        message = json.loads(raw)
                        if message.get('type') == 'CALLBACK':
                            # Bound work: busy messages are not acked, so the platform can retry.
                            if len(callbacks) >= 8:
                                continue
                            task = asyncio.create_task(client.background_task(message))
                            callbacks.add(task)
                            task.add_done_callback(callbacks.discard)
                        else:
                            await client.background_task(message)
            except Exception:
                if stop.is_set():
                    break
                _status('reconnecting', '连接未成功，正在自动重连；请核对凭证、机器人发布状态和网络')
                for _ in range(delay):
                    if stop.is_set():
                        break
                    await asyncio.sleep(1)
                delay = min(delay * 2, 60)
    finally:
        # Do not cancel an SMTP operation mid-flight. Durable confirmation receipts
        # remain consumed if the process exits before its result can be returned.
        if callbacks:
            await asyncio.gather(*callbacks, return_exceptions=True)


def start():
    global _thread, _stop
    with _lock:
        if _thread and _thread.is_alive():
            return
        saved = remote_control.settings()
        if not saved['enabled']:
            _state.update(phase='disabled', message='未启用')
            return
        secret = credential_store.load(remote_control.secret_key(saved['client_id']))
        if not secret:
            _state.update(phase='error', message='应用密钥不可用，请重新保存配置')
            return
        try:
            import dingtalk_stream  # noqa: F401
        except ImportError:
            _state.update(phase='error', message='当前版本缺少钉钉组件，请更新安装包')
            return
        stop = threading.Event()
        _stop = stop

        def run():
            try:
                asyncio.run(_listen(saved, secret, stop))
            except Exception:
                _status('error', '钉钉通道异常，请检查配置后重新连接')
            else:
                _status('disabled', '已断开')

        _state.update(phase='connecting', message='正在连接钉钉')
        _thread = threading.Thread(target=run, daemon=True, name='dingtalk-remote')
        _thread.start()


def stop(timeout=1):
    global _generation
    with _lock:
        _generation += 1
        _stop.set()
        thread = _thread
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
        threading.Thread(target=resume, daemon=True, name='dingtalk-reconnect').start()
        return status()
    start()
    return status()
