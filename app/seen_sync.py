"""Durable, coalescing background synchronization for IMAP read flags."""
import logging
from collections import defaultdict

from . import db
from .imap_client import MailClient

log = logging.getLogger(__name__)


def process_due(limit: int = 200) -> dict:
    rows = db.due_seen_sync_jobs(limit)
    if not rows:
        return {'processed': 0, 'failed': 0}

    groups = defaultdict(list)
    processed = failed = 0
    for row in rows:
        if row.get('uid') is None or row.get('remote_missing'):
            db.finish_seen_sync(row['email_id'], row['generation'])
            continue
        groups[(row['folder'], bool(row['desired_value']))].append(row)

    if not groups:
        return {'processed': 0, 'failed': 0}
    active = [row for group in groups.values() for row in group]
    try:
        with MailClient() as mail:
            for (folder, value), group in groups.items():
                try:
                    mail.set_seen_many([int(row['uid']) for row in group], folder, value)
                    for row in group:
                        db.finish_seen_sync(row['email_id'], row['generation'])
                        processed += 1
                except Exception as exc:
                    db.retry_seen_sync(
                        [(row['email_id'], row['generation']) for row in group], str(exc)
                    )
                    failed += len(group)
                    log.info('后台同步已读状态将在稍后重试 folder=%s count=%s: %s',
                             folder, len(group), exc)
    except Exception as exc:
        # Connection setup can fail before a folder group is entered. Persist
        # the same bounded backoff so an offline server never causes a tight loop.
        db.retry_seen_sync(
            [(row['email_id'], row['generation']) for row in active], str(exc)
        )
        failed = len(active)
        log.info('邮箱服务器暂不可用，已读状态将在稍后重试: %s', exc)
    return {'processed': processed, 'failed': failed}
