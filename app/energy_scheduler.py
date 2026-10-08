"""Wake local queues on committed changes and sleep until useful work is due.

Read-only deadline checks are bounded to one minute to recover external-process
changes, clock adjustments and sleep/resume. Never claims or sends a message.
"""
import sqlite3
import threading
import time
from contextlib import closing
from datetime import datetime
from pathlib import Path

outbox_changed = threading.Event()
reminders_changed = threading.Event()
STOP_CHECK_SECONDS = 60


def database_changed():
    # A worker's own commits must not keep it awake in an empty-queue loop.
    name = threading.current_thread().name
    if name != 'outbox':
        outbox_changed.set()
    if name != 'mailai-reminders':
        reminders_changed.set()


def _epoch(value):
    if isinstance(value, (int, float)):
        return float(value)
    if not value:
        return 0.0
    try:
        return datetime.fromisoformat(str(value)).timestamp()
    except (TypeError, ValueError):
        return float('inf')  # Invalid data must not turn an idle worker into a busy loop.


def _rows(connection, sql):
    try:
        return connection.execute(sql).fetchall()
    except sqlite3.OperationalError as exc:
        if 'no such table' in str(exc) or 'no such column' in str(exc):
            return []  # An older database can be migrated by its normal worker.
        raise


def next_delay(accounts, kind, *, now=None, retries=None):
    now = time.time() if now is None else now
    delay = float(STOP_CHECK_SECONDS)
    for key, account in accounts.items():
        if kind == 'reminders' and not account.get('visible', True):
            continue
        if retries and key in retries and retries[key][1] > time.monotonic():
            delay = min(delay, retries[key][1] - time.monotonic())
            continue
        path = Path(account.get('db_path') or '')
        if not path.is_file():
            continue
        try:
            with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=.5)) as c:
                if kind == 'outbox':
                    deadlines = [_epoch(row[0]) for row in _rows(c, "SELECT min(due_at) FROM outbox WHERE status='queued' HAVING count(*)>0")]
                    if _rows(c, "SELECT 1 FROM outbox WHERE status='sending' LIMIT 1"):
                        deadlines.append(now)
                    deadlines += [_epoch(row[0]) for row in _rows(c, "SELECT min(due_at) FROM seen_sync_jobs HAVING count(*)>0")]
                    deadlines += [_epoch(row[0]) for row in _rows(c, "SELECT min(pending_due_at) FROM emails WHERE pending_action IN ('trash','trash_copying','trash_copied','trash_locating') HAVING count(*)>0")]
                    # This separate remote-cleanup pool already throttles itself
                    # to 30 seconds. An overdue tombstone must not cause a spin.
                    purge_rows = _rows(c, "SELECT min(due_at) FROM trash_tombstones WHERE state='pending' OR raw_path<>'' HAVING count(*)>0")
                    if purge_rows:
                        from . import trash_purge
                        cooldown = max(0, trash_purge._next_run.get(str(path), 0) - time.monotonic())
                        deadlines += [max(_epoch(row[0]), now + cooldown) for row in purge_rows]
                else:
                    deadlines = [_epoch(row[0]) for row in _rows(c, "SELECT min(CASE WHEN n.remind_at=t.remind_at AND n.sent=0 AND n.retry_after>t.remind_at THEN n.retry_after ELSE t.remind_at END) FROM todos t LEFT JOIN task_notice_delivery n ON n.todo_id=t.id WHERE t.status='open' AND t.remind_at IS NOT NULL AND (n.todo_id IS NULL OR n.remind_at!=t.remind_at OR n.sent=0) HAVING count(*)>0")]
                    deadlines += [max(_epoch(row[0]), float(row[1] or 0)) for row in _rows(c, "SELECT at,retry_after FROM mail_workflow_notices WHERE sent=0")]
                    deadlines += [max(_epoch(row[0]), float(row[1] or 0)) for row in _rows(c, "SELECT f.at,f.retry_after FROM sent_followups f JOIN sent_messages s ON s.id=f.sent_id WHERE f.state='scheduled' AND f.sent=0 AND s.status='sent'")]
                for deadline in deadlines:
                    delay = min(delay, max(1.0, deadline - now))
        except (OSError, sqlite3.Error, ValueError, TypeError):
            delay = min(delay, 5.0)
    return max(1.0, delay)

def background_priority():
    """Mark only this maintenance/index worker as background on native macOS."""
    import sys
    if sys.platform != 'darwin':
        return
    try:
        import ctypes
        ctypes.CDLL(None).pthread_set_qos_class_self_np(0x09, 0)
    except (OSError, AttributeError):
        pass
