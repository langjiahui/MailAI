"""已读状态回写服务器的持久队列（带代际防旧值覆盖）。"""
from datetime import datetime

from .core import conn


def queue_seen_sync(email_ids: list[int], value: bool) -> tuple[list[dict], list[dict]]:
    """Apply the read state locally and persist only the latest remote intent."""
    ids = list(dict.fromkeys(int(item) for item in email_ids))
    if not ids:
        return [], []
    now = datetime.now().isoformat(timespec="seconds")
    keys = ('id', 'folder', 'uid', 'status', 'is_read', 'is_starred')
    before, after = [], []
    with conn() as c:
        for email_id in ids:
            row = c.execute("SELECT * FROM emails WHERE id=?", (email_id,)).fetchone()
            if not row or row['remote_missing']:
                continue
            before.append({key: row[key] for key in keys})
            c.execute("UPDATE emails SET is_read=? WHERE id=?", (int(bool(value)), email_id))
            if row['is_local_archive']:
                after.append({key: (int(bool(value)) if key == 'is_read' else row[key]) for key in keys})
                continue
            c.execute(
                "INSERT INTO seen_sync_jobs(email_id,desired_value,generation,attempts,due_at,last_error,updated_at) "
                "VALUES(?,?,1,0,?,'',?) ON CONFLICT(email_id) DO UPDATE SET "
                "desired_value=excluded.desired_value,generation=seen_sync_jobs.generation+1,"
                "attempts=0,due_at=excluded.due_at,last_error='',updated_at=excluded.updated_at",
                (email_id, int(bool(value)), now, now),
            )
            updated = c.execute("SELECT * FROM emails WHERE id=?", (email_id,)).fetchone()
            after.append({key: updated[key] for key in keys})
    return before, after


def due_seen_sync_jobs(limit: int = 200) -> list[dict]:
    """Return due read-state writes with their current server identity."""
    with conn() as c:
        return [dict(row) for row in c.execute(
            "SELECT j.*,e.folder,e.uid,e.remote_missing FROM seen_sync_jobs j "
            "LEFT JOIN emails e ON e.id=j.email_id WHERE j.due_at<=? "
            "ORDER BY j.due_at,j.email_id LIMIT ?",
            (datetime.now().isoformat(timespec="seconds"), max(1, min(limit, 500))),
        ).fetchall()]


def finish_seen_sync(email_id: int, generation: int):
    """A newer local toggle must survive completion of an older network write."""
    with conn() as c:
        c.execute("DELETE FROM seen_sync_jobs WHERE email_id=? AND generation=?",
                  (int(email_id), int(generation)))


def retry_seen_sync(email_ids: list[tuple[int, int]], error: str):
    now = datetime.now()
    with conn() as c:
        for email_id, generation in email_ids:
            row = c.execute(
                "SELECT attempts FROM seen_sync_jobs WHERE email_id=? AND generation=?",
                (int(email_id), int(generation)),
            ).fetchone()
            if not row:
                continue
            attempts = int(row['attempts'] or 0) + 1
            delay = min(300, 5 * (2 ** min(attempts - 1, 6)))
            due = datetime.fromtimestamp(now.timestamp() + delay).isoformat(timespec="seconds")
            c.execute(
                "UPDATE seen_sync_jobs SET attempts=?,due_at=?,last_error=?,updated_at=? "
                "WHERE email_id=? AND generation=?",
                (attempts, due, str(error or '')[:300], now.isoformat(timespec="seconds"),
                 int(email_id), int(generation)),
            )
