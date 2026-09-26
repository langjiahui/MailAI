"""Account-local, durable share uploads. Restart retries reuse the same COS object."""
import asyncio
import json
import os
from pathlib import Path
import re
import shutil
import threading
import uuid
import time
from datetime import datetime, timezone
from urllib.parse import unquote

from . import config, db, share_storage

_lock = threading.RLock()
_active = set()
_workers = set()


def _root():
    root = Path(str(Path(config.DB_PATH).resolve()) + '.share-uploads')
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    return root


def _path(token):
    if not re.fullmatch(r'[a-f0-9]{32}', token):
        raise ValueError('上传任务不存在')
    return _root() / token


def _write(path, row):
    temp = path / 'task.tmp'
    temp.write_text(json.dumps(row, ensure_ascii=False), encoding='utf-8')
    os.chmod(temp, 0o600)
    os.replace(temp, path / 'task.json')


def _read(path):
    try:
        return json.loads((path / 'task.json').read_text(encoding='utf-8'))
    except (OSError, ValueError) as exc:
        raise ValueError('上传任务不存在，请重新添加文件') from exc


def _public(row):
    return {key: row.get(key) for key in ('id', 'draft_id', 'name', 'size', 'days', 'state', 'error', 'result')}


def list_tasks(draft_id):
    rows = []
    with _lock:
        for path in _root().iterdir():
            if not (path / 'task.json').is_file():
                if path.is_dir() and time.time() - path.stat().st_mtime > 86400:
                    shutil.rmtree(path, ignore_errors=True)
                continue
            try:
                row = _read(path)
            except ValueError:
                continue
            if not db.get_draft(row['draft_id']) and str(path) not in _active:
                shutil.rmtree(path, ignore_errors=True)
                continue
            if row['draft_id'] != draft_id:
                continue
            if row['state'] == 'uploading' and str(path) not in _active:
                row.update(state='failed', error='上次上传中断，可继续上传')
                _write(path, row)
            rows.append(_public(row))
    return rows


async def stage(request, draft_id, days):
    if days not in (1, 3, 7) or not db.get_draft(draft_id):
        raise ValueError('请先保存有效草稿，再添加大附件')
    name = unquote(request.headers.get('x-mailai-filename', '')).strip()
    if not name or len(name) > 200:
        raise ValueError('文件名无效')
    length = int(request.headers.get('content-length', '0'))
    if not 0 < length <= share_storage._MAX_FILE_BYTES:
        raise ValueError('共享文件大小须在 1 字节到 2 GB 之间')
    root = _root()
    if shutil.disk_usage(root).free < length + 128 * 1024 * 1024:
        raise ValueError('本机空间不足，未保存文件，请释放空间后重试')
    if not share_storage._upload_slots.acquire(blocking=False):
        raise share_storage.UploadBusyError('已有文件正在处理，请稍后重试')
    token = uuid.uuid4().hex
    path = root / token
    path.mkdir(mode=0o700)
    committed = False
    try:
        size = 0
        with (path / 'file').open('wb') as stream:
            os.chmod(path / 'file', 0o600)
            async for chunk in request.stream():
                size += len(chunk)
                if size > length:
                    raise ValueError('文件大小与声明不一致')
                stream.write(chunk)
            stream.flush()
            os.fsync(stream.fileno())
        if size != length:
            raise ValueError('文件接收不完整，请重新添加')
        if not db.get_draft(draft_id):
            raise ValueError('草稿已删除')
        row = dict(id=token, draft_id=draft_id, name=name, size=size, days=days,
                   state='waiting', error='', result=None)
        with _lock:
            _write(path, row)
        committed = True
        return _public(row)
    finally:
        if not committed:
            shutil.rmtree(path, ignore_errors=True)
        share_storage._upload_slots.release()


def _execute(path):
    try:
        row = _read(path)
        result = share_storage._upload_file(str(path / 'file'), row['name'], row['size'], row['days'], object_id=row['id'])
        with _lock:
            row.update(state='done', result=result, error='')
            _write(path, row)
        return result
    except Exception:
        with _lock:
            row = _read(path)
            row.update(state='failed', error='上传未完成，文件已保存在本机，可稍后重试')
            _write(path, row)
        raise
    finally:
        with _lock:
            _active.discard(str(path))
        share_storage._upload_slots.release()


async def upload(token):
    path = _path(token)
    with _lock:
        row = _read(path)
        if not db.get_draft(row['draft_id']):
            raise ValueError('草稿已删除')
        if row['state'] == 'done':
            expiry = row.get('result', {}).get('expires_at', '')
            if expiry and datetime.fromisoformat(expiry.replace('Z', '+00:00')) > datetime.now(timezone.utc):
                return row['result']
        if str(path) in _active or not share_storage._upload_slots.acquire(blocking=False):
            raise share_storage.UploadBusyError('该文件或其他大附件正在上传，请稍后刷新')
        _active.add(str(path))
        try:
            row.update(state='uploading', error='')
            _write(path, row)
        except Exception:
            _active.discard(str(path)); share_storage._upload_slots.release()
            raise
    # Cancellation must not erase the persisted task or release the slot early.
    task = asyncio.create_task(asyncio.to_thread(_execute, path))
    _workers.add(task)
    def finished(done):
        _workers.discard(done)
        if not done.cancelled():
            done.exception()
    task.add_done_callback(finished)
    return await asyncio.shield(task)


def remove(token):
    path = _path(token)
    with _lock:
        if str(path) in _active:
            raise share_storage.UploadBusyError('文件仍在上传，请完成后再移除')
        shutil.rmtree(path, ignore_errors=True)


def remove_draft(draft_id):
    for row in list_tasks(draft_id):
        remove(row['id'])
