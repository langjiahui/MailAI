"""延迟删除队列：本地先隐藏，远端分阶段提交，失败指数退避。"""
from datetime import datetime

from .core import conn


def queue_trash(email_ids: list[int], delay_seconds: int = 120) -> tuple[list[dict], list[dict]]:
    """Hide messages immediately and persist an idempotent server-trash operation."""
    ids = list(dict.fromkeys(int(value) for value in email_ids))
    if not ids:
        return [], []
    due = datetime.fromtimestamp(datetime.now().timestamp() + max(0, delay_seconds)).isoformat(timespec="seconds")
    before, after = [], []
    keys = ('id', 'folder', 'uid', 'status', 'is_read', 'is_starred', 'remote_missing',
            'pending_action', 'pending_target', 'pending_target_uid')
    with conn() as c:
        for email_id in ids:
            row = c.execute("SELECT * FROM emails WHERE id=?", (email_id,)).fetchone()
            if not row or row['is_local_archive'] or row['cleanup_hold'] or row['remote_missing'] or row['pending_action'] or row['status'] == 'trash':
                continue
            before.append({key: row[key] for key in keys})
            c.execute(
                "UPDATE emails SET remote_missing=1,pending_action='trash',pending_target='',"
                "pending_target_uid=NULL,pending_due_at=?,pending_attempts=0,pending_error='' WHERE id=?",
                (due, email_id),
            )
            updated = c.execute("SELECT * FROM emails WHERE id=?", (email_id,)).fetchone()
            after.append({key: updated[key] for key in keys})
    return before, after


def due_trash_actions(limit: int = 200) -> list[dict]:
    """Return due phases. Rows remain queued until their remote phase is committed."""
    with conn() as c:
        return [dict(row) for row in c.execute(
            "SELECT * FROM emails WHERE pending_action IN ('trash','trash_copying','trash_copied','trash_locating') "
            "AND COALESCE(pending_due_at,'')<=? ORDER BY pending_due_at,id LIMIT ?",
            (datetime.now().isoformat(timespec="seconds"), max(1, min(limit, 200))),
        ).fetchall()]


def advance_trash_action(email_ids: list[int], *, action: str, target: str = '',
                         target_uids: dict[int, int | None] | None = None):
    ids = list(dict.fromkeys(int(value) for value in email_ids))
    if not ids:
        return
    target_uids = target_uids or {}
    with conn() as c:
        for email_id in ids:
            c.execute(
                "UPDATE emails SET pending_action=?,pending_target=?,pending_target_uid=?,"
                "pending_due_at=?,pending_error='' WHERE id=?",
                (action, target, target_uids.get(email_id), datetime.now().isoformat(timespec="seconds"), email_id),
            )


def retry_trash_action(email_ids: list[int], error: str):
    """Back off persistent IMAP failures without exposing a deleted row again."""
    now = datetime.now()
    with conn() as c:
        for email_id in dict.fromkeys(int(value) for value in email_ids):
            row = c.execute("SELECT pending_attempts FROM emails WHERE id=?", (email_id,)).fetchone()
            if not row:
                continue
            attempts = int(row['pending_attempts'] or 0) + 1
            delay = min(300, 5 * (2 ** min(attempts - 1, 6)))
            due = datetime.fromtimestamp(now.timestamp() + delay).isoformat(timespec="seconds")
            c.execute(
                "UPDATE emails SET pending_attempts=?,pending_due_at=?,pending_error=? WHERE id=?",
                (attempts, due, str(error or '')[:300], email_id),
            )


def finish_trash_action(email_id: int, target: str, target_uid: int | None):
    """Commit the local result; unknown target UIDs are learned by the next folder sync."""
    with conn() as c:
        c.execute('BEGIN IMMEDIATE')
        active = c.execute("SELECT pending_action FROM emails WHERE id=?", (email_id,)).fetchone()
        if not active or not str(active['pending_action'] or '').startswith('trash'):
            return False  # Locally purged/restored while the IMAP request was running.
        if target_uid:
            canonical = c.execute(
                "SELECT id FROM emails WHERE folder=? AND uid=? AND id<>?",
                (target, int(target_uid), email_id),
            ).fetchone()
            if canonical:
                c.execute("UPDATE emails SET status='trash',remote_missing=0 WHERE id=?", (canonical['id'],))
                c.execute(
                    "UPDATE emails SET status='trash',remote_missing=1,pending_action='',pending_target='',"
                    "pending_target_uid=NULL,pending_due_at=NULL,pending_attempts=0,pending_error='' WHERE id=?",
                    (email_id,),
                )
            else:
                c.execute(
                    "UPDATE emails SET folder=?,uid=?,status='trash',remote_missing=0,pending_action='',"
                    "pending_target='',pending_target_uid=NULL,pending_due_at=NULL,pending_attempts=0,pending_error='' "
                    "WHERE id=?",
                    (target, int(target_uid), email_id),
                )
        else:
            c.execute(
                "UPDATE emails SET status='trash',remote_missing=1,pending_action='trash_locating',pending_target=?,"
                "pending_target_uid=NULL,pending_due_at=NULL,pending_attempts=0,pending_error='' WHERE id=?",
                (target, email_id),
            )
        return True


def cancel_pending_trash(email_id: int) -> bool:
    from ..trash_queue import mutation_lock
    with mutation_lock():
        return _cancel_pending_trash(email_id)


def _cancel_pending_trash(email_id: int) -> bool:
    """Cancel an operation only before the remote copy phase has started."""
    with conn() as c:
        c.execute(
            "UPDATE emails SET remote_missing=0,pending_action='',pending_target='',pending_target_uid=NULL,"
            "pending_due_at=NULL,pending_attempts=0,pending_error='' WHERE id=? AND pending_action='trash'",
            (email_id,),
        )
        return bool(c.execute("SELECT changes()").fetchone()[0])
