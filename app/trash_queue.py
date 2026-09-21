"""Durable, account-scoped two-phase IMAP trash synchronization."""
import logging
import threading
from . import config
from collections import defaultdict

from . import db, pipeline
from .imap_client import MailClient

log = logging.getLogger(__name__)


def _groups(rows, *fields):
    result = defaultdict(list)
    for row in rows:
        result[tuple(row.get(field) for field in fields)].append(row)
    return result


def _still_pending(rows):
    # Purge deliberately does not wait for our network lock. Discard stale work
    # before the next remote command; tombstones cover commands already in flight.
    result = []
    for row in rows:
        current = db.get_email(row['id'])
        if current and current.get('pending_action') == row.get('pending_action'):
            result.append(current)
    return result


_locks = {}
_locks_guard = threading.Lock()


def mutation_lock():
    with _locks_guard:
        return _locks.setdefault(config.DB_PATH, threading.RLock())


def process_due(limit: int = 200) -> dict:
    with mutation_lock():
        return _process_due(limit)


def _process_due(limit: int = 200) -> dict:
    """Advance queued deletes without ever repeating a confirmed COPY phase."""
    rows = db.due_trash_actions(limit)
    if not rows:
        return {"processed": 0, "failed": 0}
    processed = failed = 0
    targets_to_sync = set()
    with MailClient() as mail:
        target = mail.ensure_trash_folder()

        for row in [item for item in rows if item['pending_action'] == 'trash_locating']:
            try:
                folder = row.get('pending_target') or target
                uid = mail.find_message_uid(folder, row.get('message_id') or '')
                if not uid:
                    raise RuntimeError('等待服务器确认已删除邮件的位置')
                db.finish_trash_action(row['id'], folder, uid)
                processed += 1
            except Exception as exc:
                db.retry_trash_action([row['id']], str(exc))
                failed += 1

        # An interrupted/uncertain COPY must be reconciled, never blindly replayed.
        for row in [item for item in rows if item['pending_action'] == 'trash_copying']:
            try:
                target_uid = mail.find_message_uid(row.get('pending_target') or target,
                                                   row.get('message_id') or '')
                if not target_uid:
                    raise RuntimeError("上次复制结果未知，等待服务器垃圾箱可见后继续")
                db.advance_trash_action(
                    [row['id']], action='trash_copied', target=row.get('pending_target') or target,
                    target_uids={row['id']: target_uid},
                )
            except Exception as exc:
                db.retry_trash_action([row['id']], str(exc))
                failed += 1

        pending = [item for item in rows if item['pending_action'] == 'trash']
        to_copy = []
        for row in pending:
            if row['folder'] == target:
                db.finish_trash_action(row['id'], target, row['uid'])
                processed += 1
                continue
            try:
                existing_uid = mail.find_message_uid(target, row.get('message_id') or '')
            except Exception as exc:
                db.retry_trash_action([row['id']], str(exc))
                failed += 1
                continue
            if existing_uid:
                # Reuse copies left by an older MailAI build or an interrupted
                # operation. This makes upgrading and retrying idempotent.
                db.advance_trash_action(
                    [row['id']], action='trash_copied', target=target,
                    target_uids={row['id']: existing_uid},
                )
            else:
                to_copy.append(row)
        for (source_folder,), group in _groups(to_copy, 'folder').items():
            group = _still_pending(group)
            if not group:
                continue
            ids = [row['id'] for row in group]
            source_uids = [int(row['uid']) for row in group]
            try:
                # Persist the ambiguous phase before the network command. A
                # process/network interruption can therefore never cause an
                # automatic second COPY of the same messages.
                db.advance_trash_action(ids, action='trash_copying', target=target)
                mapping = mail.copy_many(source_uids, source_folder, target)
                target_uids = {row['id']: mapping.get(int(row['uid'])) for row in group}
                db.advance_trash_action(ids, action='trash_copied', target=target,
                                        target_uids=target_uids)
            except Exception as exc:
                db.retry_trash_action(ids, str(exc))
                log.warning("后台复制到垃圾箱待核对 folder=%s count=%s: %s",
                            source_folder, len(group), exc)
                failed += len(group)

        # Re-read because successful copies above are now ready for phase two.
        copied = [row for row in db.due_trash_actions(limit)
                  if row['pending_action'] == 'trash_copied']
        for (source_folder, trash_target), group in _groups(copied, 'folder', 'pending_target').items():
            group = _still_pending(group)
            if not group:
                continue
            ids = [row['id'] for row in group]
            try:
                if source_folder != trash_target:
                    mail.delete_many([int(row['uid']) for row in group], source_folder)
                for row in group:
                    if not db.finish_trash_action(row['id'], trash_target,
                                                row.get('pending_target_uid')):
                        continue
                    db.add_audit_log(
                        row['id'], 'background_trash', actor='user', reason=trash_target,
                        meta={'source_folder': source_folder, 'source_uid': row['uid'],
                              'target_uid': row.get('pending_target_uid')},
                    )
                    processed += 1
                    if not row.get('pending_target_uid'):
                        targets_to_sync.add(trash_target)
            except Exception as exc:
                db.retry_trash_action(ids, str(exc))
                log.warning("后台删除源邮件待重试 folder=%s count=%s: %s",
                            source_folder, len(group), exc)
                failed += len(group)

    # Learn target UIDs outside the mutation connection. If another mailbox
    # sync owns the bounded pipeline lock, its next pass will reconcile them.
    for target in targets_to_sync:
        try:
            pipeline.sync_mail_folder(target)
        except Exception:
            log.info("垃圾箱将在下次常规同步时刷新: %s", target, exc_info=True)
    return {"processed": processed, "failed": failed}
