"""Small, bounded weekly snapshots for unattended local recovery."""
import logging
import os
import shutil
import threading
import time
from pathlib import Path

from . import config, system_settings
from .account_context import busy, use
from .account_guard import guard

log = logging.getLogger(__name__)
_lock = threading.Lock()
INTERVAL_SECONDS = 7 * 24 * 60 * 60
MAX_SOURCE_BYTES = 2 * 1024 ** 3
MIN_FREE_BYTES = 256 * 1024 ** 2
KEEP_AUTOMATIC = 3


def _automatic_files(account_id):
    root = Path(config.DATA_DIR) / 'backups'
    prefix = f'MailAI-{account_id}-'
    if not root.is_dir():
        return []
    return sorted((entry for entry in root.iterdir()
                   if entry.is_file() and entry.name.startswith(prefix)
                   and entry.name.endswith('-auto.zip')),
                  key=lambda entry: entry.stat().st_mtime, reverse=True)


def _source_bytes(db_path, raw_dir):
    total = os.path.getsize(db_path)
    for root, dirs, files in os.walk(raw_dir):
        if os.path.islink(root):
            raise ValueError('原始邮件目录包含符号链接')
        if any(os.path.islink(os.path.join(root, name)) for name in dirs):
            raise ValueError('原始邮件目录包含符号链接')
        for name in files:
            path = os.path.join(root, name)
            if os.path.islink(path):
                raise ValueError('原始邮件目录包含符号链接')
            total += os.path.getsize(path)
            if total > MAX_SOURCE_BYTES:
                return total
    return total


def run_due():
    """Back up idle accounts; never fill the disk or delete manual snapshots."""
    if not _lock.acquire(blocking=False):
        return
    try:
        accounts = system_settings._load_registry().get('accounts', {})
        for account_id, account in accounts.items():
            if not account.get('visible', True) or busy(account_id):
                continue
            db_path, raw_dir = account.get('db_path'), account.get('raw_dir')
            if not db_path or not os.path.isfile(db_path) or not raw_dir or not os.path.isdir(raw_dir):
                continue
            backup_id = system_settings._account_key(account.get('host', ''), account.get('user', ''))
            previous = _automatic_files(backup_id)
            if previous and time.time() - previous[0].stat().st_mtime < INTERVAL_SECONDS:
                continue
            try:
                source_bytes = _source_bytes(db_path, raw_dir)
                if source_bytes > MAX_SOURCE_BYTES:
                    log.warning('自动备份跳过：邮箱数据超过 2 GiB，请手动备份或清理空间')
                    continue
                if shutil.disk_usage(config.DATA_DIR).free < source_bytes * 2 + MIN_FREE_BYTES:
                    log.warning('自动备份跳过：可用磁盘空间不足')
                    continue
                values = dict(ACCOUNT_ID=account_id, DB_PATH=db_path, RAW_DIR=raw_dir,
                              IMAP_HOST=account.get('host', ''), IMAP_USER=account.get('user', ''))
                guard.acquire_work()
                try:
                    with use(values):
                        system_settings.create_backup(include_raw=True, automatic=True)
                finally:
                    guard.release()
                for old in _automatic_files(backup_id)[KEEP_AUTOMATIC:]:
                    old.unlink()
            except Exception:
                log.exception('自动备份未完成；现有备份已保留')
    finally:
        _lock.release()
