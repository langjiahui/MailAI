"""持久化同步任务与文件夹同步状态（last_uid / UIDVALIDITY）。"""
from datetime import datetime

from .core import conn


# ---------- durable sync jobs ----------

def save_sync_job(operation: str, *, status: str, total: int = 0, processed: int = 0,
                  message: str = "", error: str = ""):
    now = datetime.now().isoformat(timespec="seconds")
    with conn() as c:
        c.execute(
            "INSERT INTO sync_jobs(job_key,operation,status,total,processed,message,error,updated_at) "
            "VALUES('mailbox',?,?,?,?,?,?,?) ON CONFLICT(job_key) DO UPDATE SET "
            "operation=excluded.operation,status=excluded.status,total=excluded.total,"
            "processed=excluded.processed,message=excluded.message,error=excluded.error,updated_at=excluded.updated_at",
            (operation or "fetch_all", status, total, processed, message, error, now),
        )


def get_sync_job() -> dict | None:
    with conn() as c:
        row = c.execute("SELECT * FROM sync_jobs WHERE job_key='mailbox'").fetchone()
        return dict(row) if row else None


# ---------- sync_state ----------

def get_last_uid(folder: str) -> int:
    with conn() as c:
        row = c.execute("SELECT last_uid FROM sync_state WHERE folder=?", (folder,)).fetchone()
        return row["last_uid"] if row else 0


def get_uid_validity(folder: str) -> int:
    with conn() as c:
        row = c.execute("SELECT uid_validity FROM sync_state WHERE folder=?", (folder,)).fetchone()
        return int(row["uid_validity"] or 0) if row else 0


def observe_uid_validity(folder: str, value: int, *, reset: bool = False) -> bool:
    """Record a mailbox generation; detach stale UID identities on an approved resync."""
    value = int(value or 0)
    if value <= 0:
        return False
    with conn() as c:
        row = c.execute("SELECT uid_validity FROM sync_state WHERE folder=?", (folder,)).fetchone()
        old = int(row["uid_validity"] or 0) if row else 0
        if old and old != value:
            if not reset:
                raise RuntimeError("服务器邮件编号已变化，请先重新同步文件夹")
            c.execute("DELETE FROM seen_sync_jobs WHERE email_id IN (SELECT id FROM emails WHERE folder=?)", (folder,))
            c.execute(
                "UPDATE emails SET uid=-id,is_local_archive=1,remote_missing=0,"
                "pending_action='',pending_target='',pending_target_uid=NULL,pending_due_at=NULL,"
                "pending_attempts=0,pending_error='' WHERE folder=? AND is_local_archive=0",
                (folder,),
            )
            c.execute(
                "INSERT INTO sync_state(folder,last_uid,uid_validity) VALUES(?,0,?) "
                "ON CONFLICT(folder) DO UPDATE SET last_uid=0,uid_validity=excluded.uid_validity",
                (folder, value),
            )
            return True
        c.execute(
            "INSERT INTO sync_state(folder,last_uid,uid_validity) VALUES(?,0,?) "
            "ON CONFLICT(folder) DO UPDATE SET uid_validity=excluded.uid_validity",
            (folder, value),
        )
    return False


def get_first_uid(folder: str) -> int:
    """当前已处理的最小 UID，用于翻页拉取更早邮件。"""
    with conn() as c:
        row = c.execute(
            "SELECT MIN(uid) AS uid FROM emails WHERE folder=? AND uid>0 AND is_local_archive=0", (folder,)
        ).fetchone()
        return row["uid"] if row and row["uid"] else 0


def set_last_uid(folder: str, uid: int):
    with conn() as c:
        c.execute(
            "INSERT INTO sync_state(folder,last_uid) VALUES(?,?) "
            "ON CONFLICT(folder) DO UPDATE SET last_uid=excluded.last_uid",
            (folder, uid),
        )
