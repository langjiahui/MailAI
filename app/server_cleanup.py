"""Explicit, preview-bound server deletion with verified durable local archives.

No scheduler calls this module. A single-use account-local preview and a typed
confirmation are required. Never issue a mailbox-wide EXPUNGE.
"""
import hashlib
import json
import os
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path

from . import config, db, system_settings
from .imap_client import MailClient

MAX_ITEMS = 50
MAX_MESSAGE_BYTES = 50 * 1024 * 1024
MAX_BATCH_BYTES = 100 * 1024 * 1024


def _digest(raw):
    return hashlib.sha256(raw).hexdigest()


def _raw(row):
    path = os.path.realpath(row.get('raw_path') or '')
    root = os.path.realpath(config.RAW_DIR)
    if os.path.commonpath([root, path]) != root or not os.path.isfile(path):
        raise ValueError('本地原文缺失，请先同步并保存邮件原文')
    size = os.path.getsize(path)
    if not 0 < size <= MAX_MESSAGE_BYTES:
        raise ValueError('原文为空或超过单封 50 MB 的清理限制')
    return Path(path).read_bytes()


def _select(mail, folder, readonly=True, expected=None):
    if not mail.client.has_capability('UIDPLUS'):
        raise ValueError('此服务器不支持精确清除指定邮件（UIDPLUS），已禁用清理以免影响其他邮件')
    info = mail.client.select_folder(folder, readonly=readonly)
    validity = int(info.get(b'UIDVALIDITY', 0))
    if not validity or (expected is not None and validity != expected):
        raise ValueError('服务器邮件编号已变化，请重新同步并预览')
    return validity


def _verify_remote(mail, row, raw, include_favorites):
    uid = row['uid']
    metadata = mail.client.fetch([uid], ['RFC822.SIZE', 'FLAGS']).get(uid)
    if not metadata:
        raise ValueError('服务器中已无此邮件')
    flags = {flag.decode() if isinstance(flag, bytes) else str(flag) for flag in metadata.get(b'FLAGS', [])}
    if '\\Deleted' in flags:
        raise ValueError('邮件已被其他客户端标记删除')
    if not include_favorites and ('\\Flagged' in flags or row.get('is_favorite') or row.get('is_starred')):
        raise ValueError('收藏或星标邮件已排除')
    if int(metadata.get(b'RFC822.SIZE', -1)) != len(raw):
        raise ValueError('本地原文与服务器大小不一致，请重新同步')
    remote = mail.client.fetch([uid], ['BODY.PEEK[]']).get(uid, {}).get(b'BODY[]')
    if not isinstance(remote, bytes) or _digest(remote) != _digest(raw):
        raise ValueError('本地原文与服务器内容不一致，已停止清理')


def preview(folder, before_date, include_favorites=False, offset=0):
    if not config.IMAP_USER or not isinstance(offset, int) or not 0 <= offset <= 10000000:
        raise ValueError('邮箱或分页参数无效')
    try:
        cutoff = date.fromisoformat(before_date)
        if cutoff >= date.today():
            raise ValueError()
    except (TypeError, ValueError):
        raise ValueError('请选择今天之前的截止日期')
    if not folder or folder.startswith('__MAILAI_LOCAL__'):
        raise ValueError('请选择服务器文件夹')
    with db.conn() as c:
        rows = [dict(row) for row in c.execute(
            "SELECT * FROM emails WHERE folder=? AND remote_missing=0 AND is_local_archive=0 "
            "AND COALESCE(pending_action,'')='' AND COALESCE(cleanup_hold,'')='' "
            "AND substr(COALESCE(NULLIF(date,''),created_at),1,10)<? ORDER BY date,id LIMIT ? OFFSET ?",
            (folder, cutoff.isoformat(), MAX_ITEMS + 1, offset))]
    items, skipped, total_bytes = [], [], 0
    with MailClient() as mail:
        names = {item['name'] for item in mail.list_mailboxes() if item.get('selectable', True)}
        if folder not in names:
            raise ValueError('服务器文件夹不存在')
        validity = _select(mail, folder)
        for row in rows[:MAX_ITEMS]:
            try:
                raw = _raw(row)
                if total_bytes + len(raw) > MAX_BATCH_BYTES:
                    raise ValueError('超过单次 100 MB 限制，请分批清理')
                _verify_remote(mail, row, raw, include_favorites)
                total_bytes += len(raw)
                items.append({'id': row['id'], 'uid': row['uid'], 'subject': row['subject'] or '（无主题）',
                              'date': row['date'], 'from_addr': row['from_addr'], 'size': len(raw), 'hash': _digest(raw)})
            except (ValueError, OSError) as exc:
                skipped.append({'id': row['id'], 'subject': row['subject'] or '（无主题）', 'reason': str(exc)})
    now = datetime.now()
    token = uuid.uuid4().hex
    payload = {'account': config.IMAP_USER, 'host': config.IMAP_HOST, 'folder': folder,
               'before_date': cutoff.isoformat(), 'include_favorites': include_favorites,
               'uidvalidity': validity, 'items': items}
    with db.conn() as c:
        c.execute("DELETE FROM server_cleanup_jobs WHERE status='preview' AND expires_at<?", (now.isoformat(),))
        c.execute('INSERT INTO server_cleanup_jobs(token,payload,status,created_at,expires_at) VALUES(?,?,?,?,?)',
                  (token, json.dumps(payload, ensure_ascii=False), 'preview', now.isoformat(), (now + timedelta(minutes=10)).isoformat()))
    return {**payload, 'token': token, 'count': len(items), 'bytes': total_bytes, 'skipped': skipped,
            'more': len(rows) > MAX_ITEMS, 'offset': offset, 'expires_at': (now + timedelta(minutes=10)).isoformat()}


def _preserve_local(row, raw, token):
    # Keep the same record, folder, status and links. Only detach its server UID.
    # A private raw path prevents a future reused server UID overwriting the file.
    directory = Path(config.RAW_DIR) / 'local-retained' / token
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / (str(row['id']) + '.eml')
    with open(path, 'wb') as output:
        output.write(raw)
        output.flush()
        os.fsync(output.fileno())
    if _digest(path.read_bytes()) != _digest(raw):
        raise ValueError('本地原文写入校验失败，未清理服务器')
    with db.conn() as c:
        c.execute('UPDATE emails SET uid=-id,is_local_archive=1,cleanup_hold=?,remote_missing=0,raw_path=? WHERE id=?',
                  (token, str(path), row['id']))
        c.execute('DELETE FROM seen_sync_jobs WHERE email_id=?', (row['id'],))
    return row['id']


def _save_result(token, result):
    with db.conn() as c:
        c.execute('UPDATE server_cleanup_jobs SET status=?,result=? WHERE token=?',
                  (result['status'], json.dumps(result, ensure_ascii=False), token))


def execute(token, confirmation, acknowledge):
    if not config.IMAP_USER or acknowledge is not True or confirmation.strip().lower() != config.IMAP_USER.strip().lower():
        raise ValueError('请勾选风险确认，并输入当前邮箱地址')
    with db.conn() as c:
        job = c.execute('SELECT * FROM server_cleanup_jobs WHERE token=?', (token,)).fetchone()
        if not job:
            raise ValueError('预览不存在，请重新预览')
        if job['status'] != 'preview':
            return {**json.loads(job['result'] or '{}'), 'status': job['status'], 'already_used': True}
        payload = json.loads(job['payload'])
        if payload['account'] != config.IMAP_USER or payload['host'] != config.IMAP_HOST or job['expires_at'] < datetime.now().isoformat():
            raise ValueError('预览已过期或邮箱已变化，请重新预览')
        if not payload['items']:
            raise ValueError('没有符合条件的邮件')
        updated = c.execute("UPDATE server_cleanup_jobs SET status='running' WHERE token=? AND status='preview'", (token,))
        if updated.rowcount != 1:
            raise ValueError('此清理已开始，请勿重复操作')
    result = {'status': 'running', 'completed': 0, 'preserved': 0, 'backup': '', 'errors': [], 'items': []}
    prepared = []
    try:
        with MailClient() as mail:
            _select(mail, payload['folder'], expected=payload['uidvalidity'])
            # Revalidate every previewed message before archiving or deleting any.
            for item in payload['items']:
                row = db.get_email(item['id'])
                if (not row or row['folder'] != payload['folder'] or row['uid'] != item['uid']
                        or row.get('date') != item['date'] or row.get('is_local_archive') or row.get('cleanup_hold') or row.get('pending_action') or row.get('remote_missing')):
                    raise ValueError('邮件状态已变化，请重新预览')
                raw = _raw(row)
                if _digest(raw) != item['hash']:
                    raise ValueError('本地邮件在预览后发生变化，请重新预览')
                _verify_remote(mail, row, raw, payload['include_favorites'])
                prepared.append((row, raw))
            for row, raw in prepared:
                local_id = _preserve_local(row, raw, token)
                result['items'].append({'id': row['id'], 'local_id': local_id, 'original_uid': row['uid'], 'status': 'preserved'})
                result['preserved'] += 1
                _save_result(token, result)
            # A full recoverable snapshot exists before the very first DELETE.
            result['backup'] = system_settings.create_backup(include_raw=True)['filename']
            _save_result(token, result)
            for (row, raw), state in zip(prepared, result['items']):
                _select(mail, payload['folder'], readonly=False, expected=payload['uidvalidity'])
                _verify_remote(mail, row, raw, payload['include_favorites'])
                state['status'] = 'uncertain'
                _save_result(token, result)  # Crash/network ambiguity must not cause auto-retry.
                mail.client.add_flags([row['uid']], ['\\Deleted'], silent=True)
                mail.client.expunge([row['uid']])
                if mail.client.search(['UID', str(row['uid'])]):
                    raise RuntimeError('服务器仍有此邮件，请核对后再处理')
                # The local record remains visible in its original mailbox.
                state['status'] = 'deleted'
                result['completed'] += 1
                db.add_audit_log(row['id'], 'server_cleanup', actor='user', reason='用户确认清理服务器，本地邮件原位保留', meta={'local_id': state['local_id'], 'backup': result['backup'], 'token': token})
                _save_result(token, result)
        result['status'] = 'completed'
    except Exception as exc:
        result['errors'].append(str(exc))
        result['status'] = 'attention' if any(item['status'] == 'uncertain' for item in result['items']) else 'failed'
        # Only never-attempted items may return to normal server operations.
        with db.conn() as c:
            for item in result['items']:
                if item['status'] == 'preserved':
                    c.execute("UPDATE emails SET cleanup_hold='',is_local_archive=0,uid=? WHERE id=? AND cleanup_hold=?", (item['original_uid'], item['id'], token))
    _save_result(token, result)
    return result


def history():
    with db.conn() as c:
        rows = c.execute("SELECT * FROM server_cleanup_jobs WHERE status<>'preview' ORDER BY created_at DESC LIMIT 10").fetchall()
        return [{**json.loads(row['result'] or '{}'), 'token': row['token'], 'status': row['status'],
                 'created_at': row['created_at'], 'folder': json.loads(row['payload'])['folder']} for row in rows]
