"""Private chat commands, with account-scoped execution and durable send receipts."""
from __future__ import annotations

import hashlib
import html
import json
import os
import re
import secrets
import sqlite3
import threading
import time
import weakref
from contextlib import closing, contextmanager
from functools import wraps

from . import credential_store, db, system_settings
from .account_context import snapshot, use
from .account_guard import guard
from .paths import DATA_DIR
from .remote_help import render as help_text

PATH = DATA_DIR / 'remote-control.sqlite3'
LOCK = threading.RLock()
_SESSION_LOCKS = weakref.WeakValueDictionary()
_SCHEMA_LOCK = threading.Lock()
_SCHEMA_READY_PATH = None


class _CommandGate:
    """Let independent chats run together, but finish them before changing access."""

    def __init__(self):
        self._condition = threading.Condition()
        self._readers = 0
        self._writer = False
        self._waiting_writers = 0

    @contextmanager
    def read(self):
        with self._condition:
            self._condition.wait_for(lambda: not self._writer and not self._waiting_writers)
            self._readers += 1
        try:
            yield
        finally:
            with self._condition:
                self._readers -= 1
                self._condition.notify_all()

    @contextmanager
    def write(self):
        with self._condition:
            self._waiting_writers += 1
            try:
                self._condition.wait_for(lambda: not self._writer and not self._readers)
                self._writer = True
            finally:
                self._waiting_writers -= 1
        try:
            yield
        finally:
            with self._condition:
                self._writer = False
                self._condition.notify_all()


CONFIG_GATE = _CommandGate()


def config_change(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        with CONFIG_GATE.write():
            return function(*args, **kwargs)
    return wrapped


def _session_lock(channel, corp_id, staff_id, conversation_id):
    # Weak values keep long-lived bots from accumulating one lock per old chat.
    key = (channel, str(corp_id), str(staff_id), str(conversation_id))
    with LOCK:
        lock = _SESSION_LOCKS.get(key)
        if lock is None:
            lock = threading.RLock()
            _SESSION_LOCKS[key] = lock
        return lock


def connection():
    global _SCHEMA_READY_PATH
    PATH.parent.mkdir(parents=True, exist_ok=True)
    if os.name != 'nt':
        try:
            fd = os.open(PATH, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
        except FileExistsError:
            pass
        else:
            os.close(fd)
    c = sqlite3.connect(PATH, timeout=5)
    c.row_factory = sqlite3.Row
    c.execute('PRAGMA busy_timeout=5000')
    c.execute('PRAGMA synchronous=FULL')
    with _SCHEMA_LOCK:
        if _SCHEMA_READY_PATH != str(PATH):
            c.executescript('''
        CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS receipts (
            id TEXT PRIMARY KEY, response TEXT NOT NULL, created REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS phone_progress (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS phone_delivery (id TEXT PRIMARY KEY, progress_id TEXT NOT NULL, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS weixin_pending (
            id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, payload TEXT NOT NULL,
            created REAL NOT NULL, retry_at REAL NOT NULL DEFAULT 0,
            attempts INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS idx_weixin_pending_due
            ON weixin_pending(bot_id, retry_at, created);
    ''')
            _SCHEMA_READY_PATH = str(PATH)
    if os.name != 'nt':
        os.chmod(PATH, 0o600)
    return c


def settings(channel='dingtalk'):
    with closing(connection()) as c:
        row = c.execute('SELECT value FROM settings WHERE id=?', (1 if channel == 'dingtalk' else 2,)).fetchone()
    if row:
        return {'ai_enabled': False, **json.loads(row[0])}
    return ({'ai_enabled': False, 'enabled': False, 'client_id': '', 'corp_id': '', 'staff_id': '', 'account_ids': []}
            if channel == 'dingtalk' else {'ai_enabled': False, 'enabled': False, 'bot_id': '', 'user_id': '', 'base_url': '', 'account_ids': []})


def secret_key(client_id):
    return 'remote-dingtalk:' + client_id


def public_config(channel='dingtalk'):
    saved = settings(channel)
    accounts = system_settings._load_registry().get('accounts', {})
    key = secret_key(saved['client_id']) if channel == 'dingtalk' else 'remote-weixin:' + saved['bot_id']
    from .llm.client import available
    return {**saved, 'ai_available': available(),
            'secret_saved': bool(credential_store.load(key)) if saved.get('client_id') or saved.get('bot_id') else False,
            'keychain_available': credential_store.available(),
            'accounts': [{'id': k, 'user': a['user']} for k, a in accounts.items() if a.get('visible', True)]}


@config_change
def save_config(payload):
    with LOCK:
        previous = settings()
        saved = {k: str(payload.get(k) or '').strip() for k in ('client_id', 'corp_id', 'staff_id')}
        if any(len(v) > 160 or not v.isascii() or any(ord(ch) < 32 for ch in v) for v in saved.values()):
            raise ValueError('钉钉标识格式不正确')
        saved['enabled'] = bool(payload.get('enabled', False))
        saved['ai_enabled'] = bool(payload.get('ai_enabled', False))
        ids = payload.get('account_ids', [])
        if not isinstance(ids, list) or len(ids) > 20 or any(not isinstance(i, str) for i in ids):
            raise ValueError('请选择可控制的邮箱')
        accounts = system_settings._load_registry().get('accounts', {})
        if any(i not in accounts or not accounts[i].get('visible', True) for i in ids):
            raise ValueError('所选邮箱已移除，请刷新设置')
        saved['account_ids'] = list(dict.fromkeys(ids))
        secret = str(payload.get('client_secret') or '').strip()
        if len(secret) > 512:
            raise ValueError('Client Secret 过长')
        if saved['enabled'] and (not all(saved[k] for k in ('client_id', 'corp_id', 'staff_id')) or not ids):
            raise ValueError('启用前请填写应用、组织、本人用户标识并选择邮箱')
        if secret:
            if not saved['client_id']:
                raise ValueError('请先填写 Client ID')
            if not credential_store.save(secret_key(saved['client_id']), secret):
                raise ValueError('系统凭据库不可用，未保存密钥；请启用钥匙串或 Windows 凭据管理器')
        if saved['enabled'] and not credential_store.load(secret_key(saved['client_id'])):
            raise ValueError('请填写 Client Secret')
        with closing(connection()) as c, c:
            c.execute('INSERT OR REPLACE INTO settings VALUES(1,?)', (json.dumps(saved),))
            # Changing access invalidates previews and list indexes, never send receipts.
            if secret or any(previous.get(k) != saved.get(k) for k in ('enabled', 'client_id', 'corp_id', 'staff_id', 'account_ids')):
                c.execute("DELETE FROM sessions WHERE id LIKE 'dingtalk:%'")
        return public_config()


def authorized(saved, corp_id, staff_id, private, channel='dingtalk'):
    if channel == 'weixin':
        return (saved['enabled'] and private and bool(staff_id) and bool(saved['user_id'])
                and secrets.compare_digest(saved['user_id'].encode(), str(staff_id).encode()))
    return (saved['enabled'] and private and bool(corp_id) and bool(staff_id)
            and str(corp_id).isascii() and str(staff_id).isascii()
            and secrets.compare_digest(saved['corp_id'], str(corp_id))
            and secrets.compare_digest(saved['staff_id'], str(staff_id)))


def _save_session(key, state):
    with closing(connection()) as c, c:
        c.execute('INSERT OR REPLACE INTO sessions VALUES(?,?)', (key, json.dumps({k: v for k, v in state.items() if not k.startswith('_')})))


def _available(saved):
    accounts = system_settings._load_registry().get('accounts', {})
    return {k: accounts[k] for k in saved['account_ids']
            if k in accounts and accounts[k].get('visible', True)}


def handle_message(*, corp_id='', staff_id, conversation_id, message_id, text, private=True,
                   channel='dingtalk', binding_id=''):
    """Only called by an authenticated channel, never by a public HTTP endpoint."""
    with CONFIG_GATE.read(), _session_lock(channel, corp_id, staff_id, conversation_id):
        if channel not in ('dingtalk', 'weixin'):
            return None
        saved = settings(channel)
        if (channel == 'weixin' and binding_id and
                not secrets.compare_digest(str(saved.get('bot_id', '')), str(binding_id))):
            return None
        if not authorized(saved, corp_id, staff_id, private, channel):
            return None  # Do not expose mail or account names to strangers/groups.
        if not conversation_id or not message_id or len(str(message_id)) > 512 or len(str(conversation_id)) > 512:
            return '无法识别消息编号，请重新发送指令。'
        client_id = saved.get('client_id') or saved.get('bot_id')
        key = channel + ':' + hashlib.sha256(f'{client_id}:{corp_id}:{staff_id}:{conversation_id}'.encode()).hexdigest()
        receipt = hashlib.sha256(f'{key}:{message_id}'.encode()).hexdigest()
        with closing(connection()) as c, c:
            cached = c.execute('SELECT response FROM receipts WHERE id=?', (receipt,)).fetchone()
            if cached:
                return cached[0]
            # Reserve before any side effect, including a crash during SMTP.
            c.execute('INSERT INTO receipts VALUES(?,?,?)',
                      (receipt, '这条指令已受理，结果尚未确认；请在 MailAI 发件箱核对，勿重复发送。', time.time()))
            row = c.execute('SELECT value FROM sessions WHERE id=?', (key,)).fetchone()
            state = json.loads(row[0]) if row else {}
        checkpoint = media_request = None
        try:
            response = _execute(key, state, saved, str(text or '').strip(), channel)
            from .remote_guidance import guide
            response = guide(response, text, state)
            _save_session(key, state)
            checkpoint = state.pop('_phone_checkpoint', None)
            media_request = state.pop('_media_request', None)
            if not state.get('introduced'):
                state['introduced'] = True
                _save_session(key, state)
                response = '已连接 MailAI，只处理你授权的邮箱。\n随时发送“帮助”查看指令；发信需要预览和确认编号。\n\n' + response
            watch = state.pop('_sync_watch', None)
            if watch:
                from . import mailbox_jobs
                future = mailbox_jobs.poll_future(state['account_id'])
                if future is not None:
                    remember_sync(channel, str(message_id), saved, state['account_id'], future, conversation_id=str(conversation_id))
                else:
                    response = response.replace('完成后会尝试在这段聊天反馈。', '请稍后核对同步状态。')
        except Exception:
            checkpoint = None
            media_request = None
            # Avoid leaking credentials, SMTP responses, URLs or raw exception text into IM.
            response = '操作未完成。请在 MailAI 检查邮箱连接和任务与发件箱；发送结果不明时请先核对，勿直接重发。'
        with closing(connection()) as c, c:
            c.execute('UPDATE receipts SET response=? WHERE id=?', (response, receipt))
            if checkpoint:
                c.execute('INSERT OR REPLACE INTO phone_delivery VALUES(?,?,?)',
                          (receipt, key + ':' + state['account_id'], json.dumps(checkpoint)))
        if media_request:
            from .remote_media import queue
            queue(receipt, media_request)
        return response


def _execute(key, state, saved, text, channel):
    _expire_context(state)
    if len(text) > 4000:
        return '指令过长，请将回复正文控制在 4000 字以内。'
    from .remote_commands import canonicalize
    text = canonicalize(text) or text
    help_match = re.fullmatch(r'帮助(?:\s+(邮件|待办|回复|附件|设置|更多))?', text)
    if help_match:
        return help_text(help_match[1] or '', channel, saved.get('ai_enabled', False))
    accounts = _available(saved)
    if not accounts:
        return '尚未授权可控制的邮箱，请在设置 → 手机控制中选择邮箱。'
    if text in ('邮箱列表', '查看邮箱', '连接邮箱'):
        return '已授权邮箱：\n' + '\n'.join(a['user'] for a in accounts.values()) + '\n输入：切换邮箱 邮箱地址'
    switch = re.fullmatch(r'(?:切换|连接)(?:到)?邮箱\s+(.+)', text)
    if switch:
        matches = [k for k, a in accounts.items() if a['user'].casefold() == switch[1].strip().casefold()]
        if len(matches) != 1:
            return '未找到唯一的已授权邮箱，请输入“邮箱列表”后使用完整邮箱地址。'
        state.clear()
        state.update(account_id=matches[0], introduced=True)
        _save_session(key, state)
        return f'当前聊天邮箱：{accounts[matches[0]]["user"]}\n电脑端正在查看的邮箱保持不变。'
    account_id = state.get('account_id') or next(iter(accounts))
    if account_id not in accounts:
        return '当前聊天邮箱已取消授权，请重新选择邮箱。'
    state['account_id'] = account_id
    from .remote_language import normalize
    if state.get('awaiting_reply') and canonicalize(text) is None:
        # Explicitly entered reply mode: the next free text is literal body, not model instructions.
        text = '回复：' + text
    from .remote_document_reply import matches as document_command
    if channel == 'weixin' and document_command(text):
        language_error = None
    else:
        text, language_error = normalize(text, saved.get('ai_enabled', False), context={
            'has_current': bool(state.get('selected')), 'current_number': _current_number(state),
            'list_size': len(state.get('ids', [])), 'has_preview': bool(state.get('pending'))})
    if language_error:
        return language_error
    state['_ai_enabled'] = saved.get('ai_enabled', False)
    guard.acquire_work()
    try:
        with use(snapshot(account_id)):
            return _mail_command(key, state, text, accounts[account_id]['user'], channel)
    finally:
        guard.release()


def _mail_command(key, state, text, user, channel):
    from .remote_document_reply import command as document_reply_command
    document_response = document_reply_command(state, text, user, channel)
    if document_response is not None:
        return document_response
    from .remote_media import command as media_command
    media_response = media_command(state, text, user, channel)
    if media_response is not None:
        return media_response
    if text in ('新邮件', '更多新邮件', '今日简报') or text.startswith('时间邮件 '):
        return _work_briefing(key, state, text, user)
    if text == '重要邮件':
        from . import remote_briefing
        candidates = remote_briefing.important()
        rows = candidates[:10]
        _clear_task_view(state)
        state.update(ids=[r['id'] for r in rows], list_kind='重要邮件', listed_at=time.time(), context_at=time.time())
        for field in ('selected', 'pending', 'awaiting_reply'):
            state.pop(field, None)
        lines = [f'{user}\n小邮 · 近 30 天重要邮件（收件箱中标为高优先级的邮件）']
        if rows:
            lines.append(remote_briefing.render_mails(rows))
        if not rows:
            lines.append('当前没有符合条件的邮件。可输入“最新邮件”查看全部来信。')
        else:
            if len(candidates) > 10:
                lines.append('先展示最近 10 封，其余可在电脑查看。')
            lines.append('输入“查看第一封”“下一封”继续阅读，或“回复这封”。重要程度不等同于安全结论。')
        lines.append('以上来自本机已同步记录；“查收邮件”可更新。')
        return '\n'.join(lines)
    if text == '今天待办':
        from . import remote_briefing
        rows = remote_briefing.today_tasks()
        for field in ('ids', 'listed_at', 'list_kind', 'selected', 'pending', 'awaiting_reply', 'selected_todo', 'phone_page', 'attachment_list'):
            state.pop(field, None)
        state.update(todo_ids=[r['id'] for r in rows[:10]], todo_view=True, last_view='todo_list', context_at=time.time())
        return remote_briefing.render_tasks(rows[:10], user, len(rows))
    if text == '返回列表' and state.get('todo_view'):
        text = '返回待办'
    if text == '返回待办':
        from . import remote_briefing
        if not state.get('todo_ids'):
            return '暂无可返回的待办列表，请输入“看看今天待办”。'
        rows = [remote_briefing.task(i) for i in state['todo_ids']]
        state.update(todo_view=True, last_view='todo_list', context_at=time.time())
        return remote_briefing.render_tasks(rows, user) + '\n沿用刚才的待办序号；“看看今天待办”可刷新。'
    todo_read = re.fullmatch(r'查看待办(原邮件)?第\s*(\d+)\s*项', text)
    if todo_read or text in ('查看当前待办', '下一项', '上一项'):
        from . import remote_briefing
        ids = state.get('todo_ids', [])
        current = ids.index(state['selected_todo']) + 1 if state.get('selected_todo') in ids else None
        number = int(todo_read[2]) if todo_read else current
        if text in ('下一项', '上一项') and number is not None:
            number += 1 if text == '下一项' else -1
        if number is None or not 1 <= number <= len(ids):
            return '待办序号不可用或已经到达列表边界。请输入“返回待办”查看，或“看看今天待办”刷新。'
        task = remote_briefing.task(ids[number - 1])
        if not task:
            return '这项待办或来源邮件已不可用，请输入“看看今天待办”刷新。'
        if state.get('pending') and _pending_source_id(state['pending']) != task['email_id']:
            state.pop('pending', None)
        state.pop('awaiting_reply', None)
        state.update(selected_todo=task['id'], selected=task['email_id'], todo_view=True, last_view='todo', context_at=time.time())
        if todo_read and todo_read[1]:
            text = '查看当前邮件'
        else:
            label = '已完成' if task['status'] == 'done' else remote_briefing.task_label(task)
            return (f'{user}\n待办第 {number} / {len(ids)} 项：{str(task["title"])[:500]}\n{label}'
                    f'\n来源：{str(task.get("email_subject") or "无主题")[:200]}\n发件人：{task.get("email_from") or "未知"}'
                    '\n输入“查看原邮件”核对，或“回复这封”回复来源邮件；“下一项”“返回待办”继续查看。')
    if text == '取消回复':
        state.pop('pending', None)
        state.pop('awaiting_reply', None)
        _save_session(key, state)
        return '已取消手机端待发送回复。当前邮件仍可继续查看。'
    if text == '状态':
        synced = db.get_runtime_settings().get('last_sync_success', '尚无成功同步记录')
        return f'当前聊天邮箱：{user}\n最近成功同步：{synced}\n{_context_hint(state)}\n电脑联网且 MailAI 后台运行时，手机控制才可用。'
    if text == '继续':
        if state.get('pending'):
            return _preview(state, user)
        if state.get('awaiting_reply'):
            return '继续回复当前邮件，请直接输入正文；输入“取消回复”退出。'
        if state.get('todo_view') and state.get('last_view') in ('todo', 'todo_list'):
            return _mail_command(key, state, '查看当前待办' if state.get('last_view') == 'todo' else '返回待办', user, channel)
        if state.get('selected'):
            text = '查看当前邮件'
        elif state.get('ids'):
            text = '返回列表'
        else:
            return '当前没有可继续的邮件上下文，请输入“最新邮件”开始。'
    if text == '回复预览':
        return _preview(state, user)
    if text.startswith('修改回复：'):
        if not state.get('pending') or state['pending']['expires'] < time.time():
            state.pop('pending', None)
            return '暂无有效的回复预览。请先查看邮件，再输入“回复：你的正文”。'
        if state['pending'].get('draft_id'):
            return '带填写附件的回复请在电脑端草稿箱修改；修改后微信确认编号会失效。'
        if not text.partition('：')[2].strip():
            return '请输入“修改回复：新的完整正文”；原预览仍保留。'
        state['selected'] = state['pending']['payload']['reply_to_email_id']
        text = '回复：' + text.partition('：')[2]
    if text == '返回列表':
        if not state.get('ids'):
            return '暂无可返回的列表，请输入“最新邮件”。'
        rows = [db.get_email(i) for i in state['ids']]
        lines = [f'{user}\n上次{state.get("list_kind", "邮件")}列表（序号保持不变）']
        lines += [f'{n}. {r.get("subject") or "（无主题）"}' if _usable(r) else f'{n}. （邮件已不可用）'
                  for n, r in enumerate(rows, 1)]
        state['context_at'] = time.time()
        return '\n\n'.join(lines) + '\n\n输入“查看第一封”开始阅读；“最新邮件”刷新列表。'
    if text in ('下一封', '上一封'):
        number = _current_number(state)
        if number is None:
            return '请先输入“最新邮件”，再“查看第一封”，之后即可连续翻阅。'
        direction = 1 if text == '下一封' else -1
        target = number + direction
        while 1 <= target <= len(state['ids']):
            if _usable(db.get_email(state['ids'][target - 1])):
                break
            target += direction
        else:
            return ('已经是这份列表的最后一封。' if direction == 1 else '已经是这份列表的第一封。') + '输入“返回列表”查看，或“最新邮件”刷新。'
        text = f'查看第 {target} 封'
    if text in ('查收邮件', '收取最新邮件', '同步邮件', '刷新邮件'):
        from .mailbox_jobs import poll_all
        result = poll_all(force=True, account_id=state['account_id'])
        if result.get('ok'):
            state['_sync_watch'] = True
        return (f'{user}\n已提交后台收取任务，完成后会尝试在这段聊天反馈。你也可以输入“状态”或“最新邮件”。'
                if result.get('ok') else '未能启动收取，请在 MailAI 检查邮箱连接。')
    if text in ('最新邮件', '查看最新邮件', '未读邮件'):
        with db.conn() as c:
            upper = c.execute('SELECT COALESCE(MAX(id),0) FROM emails').fetchone()[0]
        rows = db.list_emails(status='inbox', days=36500, limit=100 if text == '未读邮件' else 10, list_view=True)
        if text == '未读邮件':
            rows = [r for r in rows if not r.get('is_read')][:10]
        _clear_task_view(state)
        state['ids'] = [r['id'] for r in rows]
        state.pop('selected', None)
        state.pop('awaiting_reply', None)
        state.pop('pending', None)
        state['listed_at'] = state['context_at'] = time.time()
        state['list_kind'] = '未读邮件' if text == '未读邮件' else '最新邮件'
        if text != '未读邮件':
            # A latest-mail overview establishes the start of future incremental queries.
            from datetime import datetime
            state['_phone_checkpoint'] = dict(id=upper, at=datetime.now().isoformat(timespec='seconds'))
        _save_session(key, state)
        from . import remote_briefing
        synced = remote_briefing.phone_time(db.get_runtime_settings().get('last_sync_success'))
        lines = [f'{user}\n本机邮件 · 最近成功同步：{synced}']
        if rows:
            lines.append(remote_briefing.render_mails(rows, include_summary=False, include_priority=False))
        lines.append('输入“查看第一封”阅读；“查收邮件”收取新邮件。' if rows else '当前列表没有邮件。可先输入“查收邮件”。')
        return '\n\n'.join(lines)
    confirm = re.fullmatch(r'确认发送\s+([A-F0-9]{8})', text, re.I)
    if confirm:
        pending = state.pop('pending', None)
        if not pending or not secrets.compare_digest(pending['token'], confirm[1].upper()):
            if pending:
                state['pending'] = pending
            return ('上次邮件上下文已过期，未发送。请重新查看并回复。' if state.get('_expired_context') else
                    '确认编号不匹配，未发送。请使用回复预览中显示的确认指令。')
        _save_session(key, state)  # Consume before SMTP; never auto-resend on uncertainty.
        if time.time() > pending['expires']:
            return '回复预览已过期，未发送。请重新输入回复内容。'
        if pending.get('draft_id'):
            draft = db.get_draft(pending['draft_id'])
            from .remote_document_reply import draft_digest
            if not draft or draft.get('reply_to_email_id') != pending['email_id'] or not draft.get('attachments') \
                    or draft_digest(draft) != pending['digest']:
                return '填写后的草稿已变化，未发送。请在电脑端核对。'
            row = db.get_email(pending['email_id'])
            if not _usable(row):
                return '原邮件已移除或隔离，未发送。'
            from .web.routes.compose import api_send_mail
            from .web.schemas import SendMailRequest
            normalized_draft = {**draft, **{key: draft.get(key) or '' for key in
                                          ('to_addr', 'cc_addr', 'bcc_addr', 'subject', 'body_html', 'in_reply_to', 'references')}}
            result = api_send_mail(SendMailRequest(**normalized_draft))
            state.pop('prepared_draft_id', None)
            db.add_audit_log(row['id'], 'remote_document_reply', actor='remote_confirmed',
                             reason='本人通过微信核对附件与回复后确认发送', meta={'channel': channel})
            return '邮件服务器已接受带填写附件的回复。' + ('请在 MailAI 核对发送警告。' if result.get('warning') else '')
        row = db.get_email(pending['payload']['reply_to_email_id'])
        if not row or row.get('remote_missing') or row.get('status') in ('trash', 'quarantine'):
            return '原邮件已移除或隔离，未发送。请在 MailAI 中核对。'
        from .web.routes.compose import api_send_mail
        from .web.schemas import SendMailRequest
        result = api_send_mail(SendMailRequest(**pending['payload']))
        db.add_audit_log(row['id'], 'remote_reply', actor='remote_confirmed',
                         reason='本人通过手机单聊确认回复', meta={'channel': channel})
        return '邮件服务器已接受回复。' + ('请在 MailAI 核对发送警告和发件箱。' if result.get('warning') else '')
    if text == '确认发送':
        return '请输入预览中的完整指令：“确认发送 编号”。'
    ai = re.fullmatch(r'(总结|起草回复)(?:第)?\s*(\d+)?\s*(?:封(?:邮件)?)?\s*(?:[：:]\s*(.*))?', text, re.S)
    read = re.fullmatch(r'(?:查看|打开)(?:(?:第)?\s*(\d+)\s*封(?:邮件)?|当前邮件)', text)
    reply = re.fullmatch(r'回复(?:第)?\s*(\d+)?\s*(?:封(?:邮件)?)?\s*[：:]\s*(.+)', text, re.S)
    reply_start = re.fullmatch(r'回复(?:(?:第)?\s*(\d+)\s*封(?:邮件)?)?', text)
    if not read and not reply and not ai and not reply_start:
        if text.startswith('回复'):
            return '还没有生成回复预览，也没有发送邮件。请说“回复：你的正文”，或“回复这封”后再输入正文。'
        return help_text(channel=channel, ai_enabled=state.get('_ai_enabled', False))
    index = read[1] if read else ai[2] if ai else reply[1] if reply else reply_start[1]
    number = int(index) if index else None
    if number is not None:
        ids = state.get('ids', [])
        if time.time() - state.get('context_at', state.get('listed_at', 0)) > 1800 or not 1 <= number <= len(ids):
            return '邮件序号无效或列表已过期，请先输入“最新邮件”。'
        email_id = ids[number - 1]
        # In a combined daily briefing, mail and task numbers are separate lists.
        for field in ('todo_view', 'selected_todo'):
            state.pop(field, None)
    else:
        email_id = state.get('selected')
    row = db.get_email(email_id) if email_id else None
    if not row or row.get('remote_missing') or row.get('status') in ('trash', 'quarantine'):
        return ('上次邮件上下文已过期。' if state.get('_expired_context') else '当前未选中可用邮件。') + '请输入“最新邮件”，再“查看第一封”。'
    if state.get('pending') and _pending_source_id(state['pending']) != row['id']:
        state.pop('pending', None)
    state['selected'] = row['id']
    state['context_at'] = time.time()
    if reply_start:
        state.pop('pending', None)
        state['awaiting_reply'] = True
        _save_session(key, state)
        return f'回复：{row.get("subject") or "（无主题）"}\n请直接输入回复正文，我会先生成预览；输入“取消回复”退出。'
    state.pop('awaiting_reply', None)
    if ai:
        if not state.get('_ai_enabled'):
            return '请先在设置 → 手机控制中启用 AI 辅助。常用文字指令仍可直接使用。'
        from .remote_language import write_mail
        if ai[1] == '起草回复':
            state.pop('pending', None)
        _save_session(key, state)
        # Model latency must not hold the account-switch guard. The context remains scoped.
        guard.release()
        try:
            generated = write_mail(row, ai[1], ai[3] or '')
        finally:
            guard.acquire_work()
        row = db.get_email(row['id'])
        if not row or row.get('remote_missing') or row.get('status') in ('trash', 'quarantine'):
            return '邮件当前不可用，未创建回复。请重新查看列表。'
        if not generated:
            return 'AI 暂不可用，邮件未发送。可重试，或直接输入“回复：你的正文”。'
        if ai[1] == '总结':
            _save_session(key, state)
            return f'{row.get("subject") or "（无主题）"}\nAI 摘要（请核对原文）：\n{generated}\n\n输入“回复：你的正文”创建预览，或“起草回复：你的要求”。'
    if read:
        state['last_view'] = 'mail'
        _save_session(key, state)
        body = row.get('body_text') or row.get('summary') or '（无正文）'
        return f'{user}\n{row.get("subject") or "（无主题）"}\n发件人：{row.get("from_addr")}\n\n{body[:2500]}' + ('\n（正文较长，完整内容请在 MailAI 查看）' if len(body) > 2500 else '') + f'\n\n{_reading_hint(state)}'
    from .reply_recipients import recipients
    to = recipients(row, user)['to_addr']
    if not to:
        return '无法确定回复收件人，请在 MailAI 中处理。'
    body = generated if ai else reply[2].strip()
    subject = row.get('subject') or ''
    if not subject.lower().startswith('re:'):
        subject = 'Re: ' + subject
    from . import signatures
    signature_state = signatures.load()
    signature = next((item for item in signature_state['items']
                      if item['id'] == signature_state['default_id']), None)
    signature_html = signature['html'] if signature else ''
    body_html = '<p>' + html.escape(body).replace('\n', '<br>') + '</p>'
    if signature_html:
        body_html += (f'<br><br><div data-mailai-signature="{html.escape(signature["id"], quote=True)}" '
                      f'style="margin-top:22px">{signature_html}</div>')
    payload = {'to_addr': to, 'subject': subject, 'body_html': body_html,
               'mode': 'reply', 'reply_to_email_id': row['id'], 'in_reply_to': row.get('message_id') or '',
               'references': ' '.join(v for v in (row.get('references_header'), row.get('message_id')) if v)}
    token = secrets.token_hex(4).upper()
    state['pending'] = {'payload': payload, 'body': body, 'signature_html': signature_html,
                        'token': token, 'expires': time.time() + 600}
    _save_session(key, state)
    return _preview(state, user)



def _expire_context(state):
    touched = state.get('context_at', state.get('listed_at'))
    if touched is not None and time.time() - touched > 1800:
        for field in ('ids', 'selected', 'pending', 'awaiting_reply', 'document_plan', 'document_row_options', 'prepared_draft_id', 'listed_at', 'context_at', 'list_kind', 'todo_ids', 'todo_view', 'last_view', 'selected_todo', 'phone_page'):
            state.pop(field, None)
        state['_expired_context'] = True


def _usable(row):
    return bool(row and not row.get('remote_missing') and row.get('status') not in ('trash', 'quarantine'))


def _pending_source_id(pending):
    return pending.get('email_id') if pending.get('draft_id') else pending['payload']['reply_to_email_id']


def _current_number(state):
    try:
        return state.get('ids', []).index(state.get('selected')) + 1
    except ValueError:
        return None


def _clear_task_view(state):
    for field in ('todo_ids', 'todo_view', 'last_view', 'selected_todo', 'phone_page'):
        state.pop(field, None)


def delivered(*, channel, staff_id, conversation_id, message_id, corp_id=''):
    """Advance a phone checkpoint only after successful reply delivery, including replay."""
    with LOCK:
        if channel not in ('weixin', 'dingtalk'):
            return
        saved = settings(channel)
        if not authorized(saved, corp_id, staff_id, True, channel):
            return
        client_id = saved.get('client_id') or saved.get('bot_id')
        key = channel + ':' + hashlib.sha256(f'{client_id}:{corp_id}:{staff_id}:{conversation_id}'.encode()).hexdigest()
        receipt = hashlib.sha256(f'{key}:{message_id}'.encode()).hexdigest()
        with closing(connection()) as c, c:
            event = c.execute('SELECT * FROM phone_delivery WHERE id=?', (receipt,)).fetchone()
            if not event or event['progress_id'].removeprefix(key + ':') not in _available(saved):
                return
            value = json.loads(event['value'])
            old = c.execute('SELECT value FROM phone_progress WHERE id=?', (event['progress_id'],)).fetchone()
            # Late/out-of-order channel callbacks cannot move the cursor backwards.
            previous = json.loads(old[0]) if old else None
            if previous is None or (previous['id'], previous['at']) <= (value['id'], value['at']):
                c.execute('INSERT OR REPLACE INTO phone_progress VALUES(?,?)', (event['progress_id'], event['value']))
            c.execute('DELETE FROM phone_delivery WHERE id=?', (receipt,))


def _work_briefing(key, state, text, user):
    from datetime import datetime
    from . import remote_briefing as briefing
    from .remote_time import parse
    now = datetime.now()
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
    progress_id = key + ':' + state['account_id']
    with closing(connection()) as c:
        stored = c.execute('SELECT value FROM phone_progress WHERE id=?', (progress_id,)).fetchone()
    progress = json.loads(stored[0]) if stored else None
    if text == '今日简报':
        candidates, counts, _ = briefing.mail_window(start=day_start, end=now.isoformat(), important_only=True)
        tasks = briefing.today_tasks()
        # A daily overview should be short enough to scan in a phone chat.
        mail_page, task_page = candidates[:5], tasks[:5]
        _clear_task_view(state)
        state.update(ids=[r['id'] for r in mail_page], list_kind='今日重要邮件',
                     todo_ids=[r['id'] for r in task_page], listed_at=time.time(), context_at=time.time())
        for field in ('selected', 'selected_todo', 'pending', 'awaiting_reply'):
            state.pop(field, None)
        lines = [f'{user}\n小邮 · 今日简报\n邮件范围：{day_start[:10]} 00:00 至 {now:%H:%M}', briefing.sync_hint(),
                 f'今天高优先级来信 {counts["total"]} 封；今天需关注的未完成待办 {len(tasks)} 项。']
        lines.append(briefing.render_mails(mail_page) if candidates else '今天暂无已标为高优先级的来信。')
        if counts['total'] > 5:
            lines.append('今天重要邮件先显示 5 封，其余可在电脑查看。')
        lines += [briefing.render_tasks(task_page, user, len(tasks)),
                  '邮件与待办分别编号：说“查看第一封”看邮件，“查看第一项待办”看事项。重要程度不等同于安全结论。']
        return '\n'.join(lines)
    explicit = text.startswith('时间邮件 ')
    if explicit:
        try:
            start, end = parse(text, now)
        except ValueError as error:
            return str(error)
        query = dict(start=start.isoformat(), end=end.isoformat())
        label = f'{start:%Y-%m-%d %H:%M} 至 {end:%Y-%m-%d %H:%M}'
    elif text == '更多新邮件':
        page = state.get('phone_page')
        if not page:
            return '没有待展开的新邮件页。可说“有什么新邮件？”或“今天下午两点之后的邮件”。'
        query, label, explicit = dict(page['query']), page['label'], page['explicit']
        # Stable snapshot and oldest-first pages ensure unseen mail is not skipped.
        query['after_id'] = page['after_id']
    else:
        query = {'after_id': progress['id']} if progress else {'start': day_start, 'end': now.isoformat()}
        label = f'上次手机查看 {progress["at"]} 以来的新收取及未展开邮件（含延迟同步的旧来信）' if progress else f'首次查询：今天 00:00 至 {now:%H:%M}'
    candidates, counts, upper = briefing.mail_window(**query)
    rows = candidates[:10]
    _clear_task_view(state)
    state.update(ids=[r['id'] for r in rows], list_kind='新邮件', listed_at=time.time(), context_at=time.time())
    for field in ('selected', 'pending', 'awaiting_reply'):
        state.pop(field, None)
    if len(candidates) > 10:
        next_query = dict(query, upper=upper)
        state['phone_page'] = dict(query=next_query, after_id=rows[-1]['id'], label=label, explicit=explicit)
    else:
        state.pop('phone_page', None)
    if not explicit:
        state['_phone_checkpoint'] = dict(id=rows[-1]['id'] if len(candidates)>10 else upper,
                                         at=now.isoformat(timespec='seconds'))
    lines = [f'{user}\n小邮 · 新邮件\n范围：{label}', briefing.sync_hint(),
             f'本次范围共 {counts["total"]} 封：未读 {counts["unread"]} 封，高优先级 {counts["important"]} 封。']
    lines.append(briefing.render_mails(rows) if rows else '本机记录中没有符合范围的来信；这不代表服务器没有尚未同步的邮件。')
    if rows:
        lines.append('按新收取顺序显示；输入“查看第一封”“下一封”阅读，或“回复这封”。')
    if len(candidates) > 10:
        lines.append('本页显示 10 封，输入“更多新邮件”看下一页，未展示的邮件不会跳过。')
    if explicit:
        lines.append('指定时间查询不改变“有什么新邮件”的查看进度。')
    return '\n'.join(lines)


def _reading_hint(state):
    if state.get('todo_view'):
        return '这是当前待办的来源邮件。可说“回复这封”“总结这封”（AI），或“下一项”“返回待办”。'
    number = _current_number(state)
    position = f'当前第 {number} / {len(state.get("ids", []))} 封。' if number else ''
    return position + '可说“下一封”“上一封”“返回列表”；“回复这封”输入正文，或“总结这封”（AI）。'


def _context_hint(state):
    row = db.get_email(state['selected']) if state.get('selected') else None
    lines = []
    if state.get('selected_todo'):
        from . import remote_briefing
        task = remote_briefing.task(state['selected_todo'])
        if task:
            lines.append('当前待办：' + str(task['title'])[:140])
    if _usable(row):
        lines.append(f'当前邮件：{row.get("subject") or "（无主题）"}')
        number = _current_number(state)
        if number:
            lines.append(f'列表位置：第 {number} / {len(state.get("ids", []))} 封')
    if state.get('pending'):
        lines.append('回复预览待确认，输入“回复预览”查看。' if state['pending']['expires'] >= time.time() else '回复预览已过期，请重新回复。')
    elif state.get('awaiting_reply'):
        lines.append('正在等待回复正文；直接输入内容，或“取消回复”。')
    else:
        lines.append('输入“继续”回到刚才的邮件或列表。')
    return '\n'.join(lines)


def _preview(state, user):
    pending = state.get('pending')
    if not pending:
        return '暂无回复预览。先查看邮件，再输入“回复这封”。'
    if pending['expires'] < time.time():
        state.pop('pending', None)
        return '回复预览已过期，未发送。请重新输入“回复：你的正文”。'
    if pending.get('draft_id'):
        draft = db.get_draft(pending['draft_id'])
        from .remote_document_reply import draft_digest
        if not draft or not _usable(db.get_email(pending['email_id'])) or draft_digest(draft) != pending['digest']:
            state.pop('pending', None)
            return '填写后的草稿或原邮件已不可用，未发送。'
        body = html.unescape(re.sub(r'(?i)<br\s*/?>', '\n', re.sub(r'<[^>]+>', '', draft['body_html'])))
        return (f'回复预览（尚未发送）\n收件人：{draft["to_addr"]}\n主题：{draft["subject"]}\n'
                f'附件：{draft["attachments"][0].get("filename", "已填写文档")}\n\n正文：\n{body[:3000]}\n\n'
                f'发送“查看填写结果”核对附件；确认无误后发送：\n确认发送 {pending["token"]}')
    payload = pending['payload']
    if not _usable(db.get_email(payload['reply_to_email_id'])):
        state.pop('pending', None)
        return '原邮件已不可用，回复预览已取消。请重新查看列表。'
    body = pending.get('body')
    if body is None:  # Upgrade existing previews without copying entire chat history.
        body = html.unescape(payload['body_html'].removeprefix('<p>').removesuffix('</p>').replace('<br>', '\n'))
    signature_html = pending.get('signature_html') or ''
    signature_text = re.sub(r'(?i)<br\s*/?>|</(?:div|p|li|tr|section|h[1-6])\s*>', '\n', signature_html)
    signature_text = html.unescape(re.sub(r'<[^>]+>', '', signature_text))
    signature_text = '\n'.join(line.strip() for line in signature_text.splitlines() if line.strip())
    signature_preview = (f'\n\n【默认签名】\n{signature_text or "（含图片或富文本内容）"}'
                         if signature_html else '')
    minutes = max(1, int((pending['expires'] - time.time() + 59) // 60))
    return (f'回复预览（尚未发送）\n\n'
            f'收件人：{payload["to_addr"]}\n'
            f'主题：{payload["subject"]}\n'
            f'发件邮箱：{user}\n\n'
            f'【回复正文】\n{body}\n【正文结束】{signature_preview}\n\n'
            f'核对无误后，复制并发送这一整行：\n确认发送 {pending["token"]}\n\n'
            f'想修改：发送“修改回复：新正文”\n'
            f'不发送：发送“取消回复”\n'
            f'此预览约 {minutes} 分钟后失效；确认前不会发送。')


# Delivery contexts stay in memory only; network delivery never blocks a mail worker.
_SYNC_WATCHES = {}
_FEEDBACK_THREADS = set()
_FEEDBACK_SLOTS = threading.BoundedSemaphore(2)


def _watch_id(saved, conversation_id, message_id):
    identity = saved.get('bot_id') or saved.get('client_id') or ''
    return hashlib.sha256(json.dumps([identity, conversation_id, str(message_id)]).encode()).hexdigest()


def remember_sync(channel, message_id, saved, account_id, future, *, conversation_id=''):
    with LOCK:
        now = time.monotonic()
        for key in list(_SYNC_WATCHES):
            if now - _SYNC_WATCHES[key][0] > 600:
                _SYNC_WATCHES.pop(key, None)
        if len(_SYNC_WATCHES) < 64:
            _SYNC_WATCHES[(channel, _watch_id(saved, conversation_id, message_id))] = (now, saved.copy(), account_id, future)


def deliver_sync_feedback(channel, message_id, deliver, *, conversation_id=''):
    """Attach after the queued acknowledgement was delivered; platform replay attaches once."""
    with LOCK:
        watch = _SYNC_WATCHES.pop((channel, _watch_id(settings(channel), conversation_id, message_id)), None)
        if watch is None:
            return
    started, original, account_id, future = watch

    def send_result():
        try:
            current = settings(channel)
            identity_fields = ('bot_id', 'user_id', 'base_url') if channel == 'weixin' else ('client_id', 'corp_id', 'staff_id')
            if (not current['enabled'] or account_id not in _available(current)
                    or any(current.get(k) != original.get(k) for k in identity_fields)):
                return
            user = _available(current)[account_id]['user']
            try:
                result = future.result()
                healthy = result.get('ok') and not result.get('errors') and not result.get('canceled')
                count = result.get('fetched', 0)
                count = count if type(count) is int and count >= 0 else 0
                text = (f'{user}\n收取完成，本次新增 {count} 封。输入“最新邮件”查看。' if healthy else
                        f'{user}\n收取未完成，现有邮件仍可查看。请在电脑端检查邮箱连接与任务；输入“状态”核对最近成功时间。')
            except Exception:
                text = f'{user}\n收取未完成，请在电脑端检查邮箱连接；输入“状态”核对最近成功时间。'
            deliver(text)
        except Exception:
            # Contexts can expire; never re-run a mailbox job or SMTP to retry a notification.
            pass
        finally:
            with LOCK:
                _FEEDBACK_THREADS.discard(threading.current_thread())
            _FEEDBACK_SLOTS.release()

    def done(_):
        if time.monotonic() - started > 180 or not _FEEDBACK_SLOTS.acquire(blocking=False):
            return  # Old chat contexts are not suitable for deferred delivery.
        worker = threading.Thread(target=send_result, name='phone-feedback', daemon=True)
        with LOCK:
            _FEEDBACK_THREADS.add(worker)
        try:
            worker.start()
        except RuntimeError:
            with LOCK:
                _FEEDBACK_THREADS.discard(worker)
            _FEEDBACK_SLOTS.release()
    future.add_done_callback(done)
