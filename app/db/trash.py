"""本地优先删除：远端失败后最多重试两次，随后结束同步。"""
from datetime import datetime

from .core import conn

MAX_TRASH_ATTEMPTS = 3  # Initial attempt plus two retries, across all phases.
_ACTIVE_PHASES = ('trash', 'trash_copying', 'trash_copied', 'trash_locating')


def discard_exhausted_trash_actions():
    """End old/exhausted jobs while retaining a durable local deletion marker."""
    with conn() as c:
        c.execute(
            "UPDATE emails SET pending_action='trash_local',remote_missing=1,pending_due_at=NULL "
            "WHERE pending_action IN ('trash','trash_copying','trash_copied','trash_locating') "
            "AND pending_attempts>=?", (MAX_TRASH_ATTEMPTS,),
        )


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
            if not row or row['cleanup_hold'] or row['remote_missing'] or row['pending_action'] or row['status'] == 'trash':
                continue
            before.append({key: row[key] for key in keys})
            c.execute(
                "UPDATE emails SET remote_missing=1,pending_action=?,pending_target='',"
                "pending_target_uid=NULL,pending_due_at=?,pending_attempts=0,pending_error='' WHERE id=?",
                ('trash_local' if row['is_local_archive'] else 'trash', due, email_id),
            )
            updated = c.execute("SELECT * FROM emails WHERE id=?", (email_id,)).fetchone()
            after.append({key: updated[key] for key in keys})
    return before, after


def due_trash_actions(limit: int = 200) -> list[dict]:
    """Return due phases. Rows remain queued until their remote phase is committed."""
    discard_exhausted_trash_actions()
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
                "pending_due_at=?,pending_error='' WHERE id=? "
                "AND pending_action IN ('trash','trash_copying','trash_copied','trash_locating')",
                (action, target, target_uids.get(email_id), datetime.now().isoformat(timespec="seconds"), email_id),
            )


def retry_trash_action(email_ids: list[int], error: str):
    """Retry twice, then retain only local deletion; never resurrect the message."""
    now = datetime.now()
    with conn() as c:
        for email_id in dict.fromkeys(int(value) for value in email_ids):
            row = c.execute("SELECT pending_attempts,pending_action FROM emails WHERE id=?", (email_id,)).fetchone()
            if not row or row['pending_action'] not in _ACTIVE_PHASES:
                continue
            attempts = int(row['pending_attempts'] or 0) + 1
            delay = min(300, 5 * (2 ** min(attempts - 1, 6)))
            due = datetime.fromtimestamp(now.timestamp() + delay).isoformat(timespec="seconds")
            c.execute(
                "UPDATE emails SET pending_attempts=?,pending_due_at=?,pending_error=?,pending_action=? WHERE id=?",
                (attempts, None if attempts >= MAX_TRASH_ATTEMPTS else due, str(error or '')[:300],
                 'trash_local' if attempts >= MAX_TRASH_ATTEMPTS else row['pending_action'], email_id),
            )


def finish_trash_action(email_id: int, target: str, target_uid: int | None):
    """Commit the local result; unknown target UIDs are learned by the next folder sync."""
    with conn() as c:
        c.execute('BEGIN IMMEDIATE')
        active = c.execute("SELECT pending_action FROM emails WHERE id=?", (email_id,)).fetchone()
        if not active or active['pending_action'] not in _ACTIVE_PHASES:
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
                "pending_target_uid=NULL,pending_due_at=NULL,pending_error='' WHERE id=?",
                (target, email_id),
            )
        return True


def cancel_pending_trash(email_id: int) -> bool:
    from ..trash_queue import mutation_lock
    with mutation_lock():
        return _cancel_pending_trash(email_id)


def _cancel_pending_trash(email_id: int) -> bool:
    """Restore locally before remote work starts or after its retry budget ends."""
    with conn() as c:
        # A discarded sync has no remaining remote work. Restore its local copy
        # without guessing whether the server's move completed.
        changed = c.execute(
            "UPDATE emails SET remote_missing=0,is_local_archive=1,pending_action='',pending_target='',"
            "pending_target_uid=NULL,pending_due_at=NULL,pending_attempts=0,pending_error='',"
            "status=CASE WHEN status='trash' THEN 'inbox' ELSE status END "
            "WHERE id=? AND pending_action='trash_local'", (email_id,),
        ).rowcount
        if changed:
            return True
        c.execute(
            "UPDATE emails SET remote_missing=0,pending_action='',pending_target='',pending_target_uid=NULL,"
            "pending_due_at=NULL,pending_attempts=0,pending_error='' WHERE id=? AND pending_action='trash'",
            (email_id,),
        )
        return bool(c.execute("SELECT changes()").fetchone()[0])
