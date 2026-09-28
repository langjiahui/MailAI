"""Explicit, account-scoped attachment requests; detached bounded delivery jobs."""
import base64
import hashlib
import json
import re
import threading
import time
from contextlib import closing
from pathlib import Path

from . import db, remote_control as remote
from .account_context import snapshot, use
from .account_guard import guard

MAX_BYTES = 20 * 1024 * 1024
MAX_RAW_BYTES = 40 * 1024 * 1024
_slot = threading.BoundedSemaphore(1)


class MediaValidationError(ValueError):
    pass


def _usable(row):
    return remote._usable(row) and not str(row.get('pending_action') or '').startswith('trash')


def _connection():
    c = remote.connection()
    c.execute('CREATE TABLE IF NOT EXISTS media_delivery (id TEXT PRIMARY KEY, value TEXT NOT NULL, status TEXT NOT NULL, created REAL NOT NULL)')
    c.commit()
    return c


def _fingerprint(item):
    return hashlib.sha256(json.dumps([item.get('name'), item.get('content_type'), item.get('size')], ensure_ascii=False).encode()).hexdigest()


def _attachments(row):
    try:
        items = row.get('attachments') or []
        items = json.loads(items) if isinstance(items, str) else items
        return items if isinstance(items, list) and all(isinstance(a, dict) for a in items) else []
    except (ValueError, TypeError):
        return []


def command(state, text, user, channel):
    listing = re.fullmatch(r'附件列表(?:第\s*(\d+)\s*封)?', text)
    transfer = re.fullmatch(r'(发送|预览)附件第\s*(\d+)\s*个', text)
    if not listing and not transfer:
        return None
    if channel != 'weixin':
        return '附件传输目前接入微信；请在微信单聊或电脑附件中心操作。'
    if listing:
        email_id = state.get('selected')
        if listing[1]:
            n = int(listing[1])
            ids = state.get('ids', [])
            if not 1 <= n <= len(ids):
                return '邮件序号无效，请先输入“最新邮件”。'
            email_id = ids[n - 1]
        row = db.get_email(email_id) if email_id else None
        if not _usable(row):
            return '请先查看一封可用邮件，再输入“查看附件”。'
        items = _attachments(row)
        if not items:
            return '这封邮件没有可用的附件记录。请在电脑查看，或“查收邮件”后重试。'
        if state.get('selected') != row['id']:
            state.pop('pending', None)
            state.pop('awaiting_reply', None)
        state.update(selected=row['id'], context_at=time.time(),
                     attachment_list=dict(email_id=row['id'], fingerprints=[_fingerprint(a) for a in items[:50]]))
        lines = [f'{user}\n附件：{str(row.get("subject") or "无主题")[:180]}']
        for n, a in enumerate(items[:50], 1):
            size = a.get('size')
            label = f'{size / 1024:.1f} KB' if isinstance(size, (int, float)) and size >= 0 else '大小未知'
            lines.append(f'{n}. {str(a.get("name") or "未命名")[:160]} · {label}')
        if len(items) > 50:
            lines.append('仅列出前 50 个附件，其余请在电脑查看。')
        return '\n'.join(lines) + '\n输入“把第二个附件发给我”获取文件，或“预览第一个附件”查看图片。单个不超过 20 MB，内容会经过微信。'
    saved_list = state.get('attachment_list') or {}
    if not saved_list or saved_list.get('email_id') != state.get('selected'):
        return '请先输入“查看附件”获取当前邮件的附件序号。'
    row = db.get_email(state.get('selected'))
    if not _usable(row):
        return '来源邮件已不可用，未发送附件。'
    n = int(transfer[2])
    items, fingerprints = _attachments(row), saved_list.get('fingerprints', [])
    if not 1 <= n <= min(len(items), len(fingerprints)):
        return '附件序号无效，请输入“查看附件”重新核对。'
    if fingerprints[n - 1] != _fingerprint(items[n - 1]):
        return '附件记录已变化，请重新“查看附件”后选择。'
    item = items[n - 1]
    if isinstance(item.get('size'), (int, float)) and item['size'] > MAX_BYTES:
        return '附件超过 20 MB，请在电脑下载；未上传微信。'
    if transfer[1] == '预览' and Path(str(item.get('name') or '')).suffix.lower() not in {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'}:
        return '当前微信图片预览支持 PNG、JPEG、GIF、WebP、BMP；其他附件可用“把第一个附件发给我”下载。'
    state['_media_request'] = dict(account_id=state['account_id'], email_id=row['id'], index=n - 1,
                                   fingerprint=fingerprints[n - 1], mode='image' if transfer[1] == '预览' else 'file')
    state['context_at'] = time.time()
    return f'正在准备{ "图片预览" if transfer[1] == "预览" else "附件" }：{str(item.get("name") or "未命名")[:160]}。完成后会在微信反馈。'


def queue(receipt, descriptor):
    with closing(_connection()) as c, c:
        c.execute('INSERT OR IGNORE INTO media_delivery VALUES(?,?,?,?)', (receipt, json.dumps(descriptor), 'queued', time.time()))


def _allowed(saved, descriptor):
    current = remote.settings('weixin')
    return (current.get('enabled') and all(current.get(k) == saved.get(k) for k in ('bot_id', 'user_id', 'base_url'))
            and descriptor['account_id'] in remote._available(current))


def load_attachment(descriptor):
    row = db.get_email(descriptor['email_id'])
    if not _usable(row):
        raise MediaValidationError('来源邮件已移除或隔离，未上传附件。')
    items, index = _attachments(row), descriptor['index']
    if not 0 <= index < len(items) or _fingerprint(items[index]) != descriptor['fingerprint']:
        raise MediaValidationError('附件记录已变化，请重新查看附件。')
    # Never accept a path from chat or follow raw-message paths outside this mailbox.
    from . import config, parser
    path = Path(row.get('raw_path') or '').resolve()
    if not path.is_relative_to(Path(config.RAW_DIR).resolve()) or not path.is_file():
        raise MediaValidationError('附件原文件不在当前邮箱本机记录中，请在电脑核对。')
    if path.stat().st_size > MAX_RAW_BYTES:
        raise MediaValidationError('原始邮件过大，请在电脑下载附件。')
    att = parser.extract_attachment(str(path), index)
    if not att or _fingerprint(att) != descriptor['fingerprint']:
        raise MediaValidationError('附件原文件不可用或记录已变化，请在电脑核对。')
    if len(att['payload']) > MAX_BYTES:
        raise MediaValidationError('附件超过 20 MB，请在电脑下载；未上传微信。')
    return att


def prepare_preview(att):
    from .attachment_preview import preview_attachment
    rendered = preview_attachment(att)
    if rendered.get('kind') != 'image':
        raise MediaValidationError('图片无法安全预览，请在电脑查看。')
    att = {**att, 'payload': base64.b64decode(rendered['data'], validate=True), 'name': '预览.png', 'content_type': 'image/png'}
    if len(att['payload']) > MAX_BYTES:
        raise MediaValidationError('图片预览过大，请下载原附件查看。')
    return att


def deliver(saved, user, message_id, send, feedback):
    """Claim once before transmission. Restart/replayed messages never reupload files."""
    if user != saved.get('user_id'):
        return
    key = 'weixin:' + hashlib.sha256(f'{saved["bot_id"]}::{user}:{user}'.encode()).hexdigest()
    receipt = hashlib.sha256(f'{key}:{message_id}'.encode()).hexdigest()
    with closing(_connection()) as c, c:
        job = c.execute('SELECT * FROM media_delivery WHERE id=?', (receipt,)).fetchone()
        if not job or job['status'] != 'queued':
            return
        if time.time() - job['created'] > 300:
            c.execute("UPDATE media_delivery SET status='expired' WHERE id=?", (receipt,))
            return
        claimed = c.execute("UPDATE media_delivery SET status='sending' WHERE id=? AND status='queued'", (receipt,)).rowcount
    if not claimed:
        return
    descriptor = json.loads(job['value'])
    if not _slot.acquire(blocking=False):
        _finish(receipt, 'busy')
        feedback('另一个附件正在传输，请稍后重新发送附件指令。')
        return
    def worker():
        status = 'failed'
        try:
            guard.acquire_work()
            try:
                with remote.LOCK:
                    if not _allowed(saved, descriptor):
                        return
                    values = snapshot(descriptor['account_id'])
                with use(values):
                    att = load_attachment(descriptor)
            finally:
                guard.release()
            if not _allowed(saved, descriptor):
                return
            if descriptor['mode'] == 'image':
                att = prepare_preview(att)
            send(att, descriptor['mode'], lambda: _allowed(saved, descriptor))
            status = 'done'
            feedback('微信已接受图片预览。' if descriptor['mode'] == 'image' else '微信已接受附件，请查看文件消息。')
        except MediaValidationError as exc:
            # Only our local validation errors are exposed; transport errors are generic.
            try:
                if _allowed(saved, descriptor):
                    feedback(str(exc))
            except Exception:
                pass
        except Exception:
            try:
                if _allowed(saved, descriptor):
                    feedback('附件传输未完成或结果未确认，请先检查微信是否已收到，再重新选择附件；不会自动重复传输。')
            except Exception:
                pass
        finally:
            try:
                _finish(receipt, status)
            finally:
                _slot.release()
    threading.Thread(target=worker, daemon=True, name='weixin-attachment').start()


def _finish(receipt, status):
    with closing(_connection()) as c, c:
        c.execute('UPDATE media_delivery SET status=? WHERE id=?', (status, receipt))
