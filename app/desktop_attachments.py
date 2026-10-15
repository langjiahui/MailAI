"""Open attachment copies with the operating system's file associations."""
from __future__ import annotations

import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading

_storage = None
_lock = threading.Lock()
_OPENABLE = {
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.rtf',
    '.wps', '.wpt', '.et', '.ett', '.dps', '.dpt', '.odt', '.ods', '.odp',
    '.txt', '.csv', '.tsv', '.md', '.log', '.json', '.xml', '.html', '.htm',
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.svg',
    '.mp3', '.wav', '.m4a', '.ogg', '.mp4', '.mov', '.avi', '.mkv', '.webm',
    '.zip', '.rar', '.7z', '.tar', '.gz', '.eml', '.ics', '.vcf',
}


def load_attachment(record_id, index, account_id='', source='email'):
    from contextlib import nullcontext
    from .account_context import snapshot, use
    from . import db
    from .parser import extract_attachment

    record_id, index = int(record_id), int(index)
    if record_id <= 0 or index < 0:
        raise ValueError('附件编号无效')
    with use(snapshot(account_id)) if account_id else nullcontext():
        if source in ('sent', 'draft'):
            attachment = db.get_sent_attachment(record_id, index, draft=source == 'draft')
        elif source == 'email':
            row = db.get_email(record_id)
            if not row:
                raise ValueError('邮件不存在')
            attachment = extract_attachment(row.get('raw_path'), index)
        else:
            raise ValueError('不支持的附件来源')
    if not attachment:
        raise ValueError('附件不存在或原始邮件文件已丢失')
    return attachment


def open_attachment_copy(attachment):
    global _storage
    # Use the stored filename, never a path or extension supplied by the UI.
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]', '_',
                  str(attachment.get('name') or '附件')).strip(' .')
    suffix = Path(name).suffix.lower()
    payload = attachment['payload']
    from .security.attachments import _has_macro
    executable = payload.startswith((b'MZ', b'\x7fELF', b'#!', b'\xcf\xfa\xed\xfe', b'\xfe\xed\xfa\xcf'))
    declared_type = 'wordprocessingml' if suffix in {'.docx', '.xlsx', '.pptx'} else attachment.get('content_type', '')
    if suffix not in _OPENABLE or executable or _has_macro(payload, suffix, declared_type):
        raise ValueError('此附件不支持直接打开，请下载原文件后查看')
    # Avoid Windows device names and overlong UTF-8 path components.
    stem = Path(name).stem.encode('utf-8')[:160].decode('utf-8', errors='ignore')
    if re.fullmatch(r'(?i:con|prn|aux|nul|com[0-9]|lpt[0-9])', stem.split('.')[0]):
        stem = '_' + stem
    name = (stem or '附件') + suffix
    with _lock:
        if _storage is None:
            _storage = tempfile.TemporaryDirectory(prefix='mailai-open-', ignore_cleanup_errors=True)
        directory = Path(tempfile.mkdtemp(dir=_storage.name))
    target = directory / name
    try:
        with target.open('xb') as stream:
            stream.write(payload)
        target.chmod(0o600)
        if sys.platform == 'win32':
            os.startfile(str(target))
        else:
            command = ['/usr/bin/open', str(target)] if sys.platform == 'darwin' else ['xdg-open', str(target)]
            subprocess.run(command, check=True, timeout=15, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError) as exc:
        target.unlink(missing_ok=True)
        directory.rmdir()
        raise ValueError('无法打开附件，请检查是否安装了支持此格式的应用，或下载原文件') from exc
    # Keep each copy until process exit: external applications may read it later.
    return {'ok': True, 'filename': name}
