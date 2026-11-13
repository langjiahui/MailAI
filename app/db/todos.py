"""待办事项。"""
import calendar
from datetime import date, datetime, timedelta
import re
import unicodedata

from .core import conn


def _identity(title, deadline):
    title = unicodedata.normalize('NFKC', title).casefold()
    return (re.sub(r'\s+', ' ', title).strip().rstrip('。.!！;；'), deadline or '')


def _suggestions(todos):
    seen = set()
    for todo in todos:
        title = (todo.get('title') or '').strip()
        deadline = todo.get('deadline') or None
        key = _identity(title, deadline)
        if title and key not in seen:
            seen.add(key)
            yield title, deadline, key


def add_todos(email_id: int, todos: list, *, user_edited=False):
    with conn() as c:
        c.execute('BEGIN IMMEDIATE')
        existing = {_identity(row['title'], row['deadline']): row['id'] for row in c.execute(
            'SELECT id,title,deadline FROM todos WHERE email_id IS ?', (email_id,))}
        for title, deadline, key in _suggestions(todos):
            if key in existing:
                if user_edited:
                    c.execute('UPDATE todos SET user_edited=1 WHERE id=?', (existing[key],))
                continue
            cursor = c.execute(
                "INSERT INTO todos(email_id,title,deadline,status,created_at,user_edited) VALUES(?,?,?,?,?,?)",
                (email_id, title, deadline, "open",
                 datetime.now().isoformat(timespec="seconds"), int(user_edited)),
            )
            existing[key] = cursor.lastrowid


def list_todos(include_done=False):
    sql = (
        "SELECT t.*, e.subject AS email_subject, e.from_addr AS email_from, "
        "e.date AS email_date, e.created_at AS email_indexed_at, e.thread_id AS email_thread "
        "FROM todos t LEFT JOIN emails e ON e.id=t.email_id"
    )
    if not include_done:
        sql += " WHERE t.status='open'"
    # The todo center is a reading stream, not a deadline planner: keep active
    # work first, then show items from the most recently received mail first.
    # Falling back to todo creation time also keeps orphaned/legacy rows stable.
    sql += (
        " ORDER BY CASE WHEN t.status='open' THEN 0 ELSE 1 END, "
        "datetime(COALESCE(NULLIF(e.date,''),NULLIF(t.created_at,''))) DESC, t.id DESC"
    )
    with conn() as c:
        return [dict(r) for r in c.execute(sql).fetchall()]


def _next_cycle_date(date_str: str | None, recurrence: str, reference_date: date | None = None) -> str:
    ref = reference_date or date.today()
    base = ref
    if date_str:
        try:
            base = date.fromisoformat(str(date_str).strip()[:10])
        except ValueError:
            base = ref
    if recurrence == "weekly":
        return (base + timedelta(days=7)).isoformat()
    if recurrence == "monthly":
        year = base.year + (base.month // 12)
        month = (base.month % 12) + 1
        day = min(base.day, calendar.monthrange(year, month)[1])
        return date(year, month, day).isoformat()
    return base.isoformat()


def _next_cycle_remind_at(remind_at: str | None, next_deadline: str, recurrence: str, now: datetime) -> str | None:
    if not remind_at:
        return None
    try:
        rem = datetime.fromisoformat(str(remind_at).strip())
        if rem.tzinfo is not None:
            rem = rem.astimezone().replace(tzinfo=None)
    except ValueError:
        return None
    next_rem_date = date.fromisoformat(_next_cycle_date(rem.date().isoformat(), recurrence, reference_date=now.date()))
    candidate = datetime.combine(next_rem_date, rem.time())
    if candidate <= now:
        candidate = datetime.combine(date.fromisoformat(next_deadline), rem.time())
    if candidate <= now:
        return None
    return candidate.isoformat(timespec="seconds")


def _spawn_next_recurring_todos(c, ids: list[int], status: str, now: datetime) -> list[dict]:
    if status != "done" or not ids:
        return []
    slots = ",".join("?" for _ in ids)
    rows = c.execute(
        f"SELECT * FROM todos WHERE status='open' AND recurrence IN ('weekly','monthly') AND id IN ({slots}) "
        f"AND NOT EXISTS (SELECT 1 FROM todos child WHERE child.recurrence_source_id=todos.id)",
        ids,
    ).fetchall()
    spawned_ids = []
    now_iso = now.isoformat(timespec="seconds")
    for row in rows:
        recurrence = (row["recurrence"] or "").strip()
        next_deadline = _next_cycle_date(row["deadline"], recurrence, reference_date=now.date())
        next_remind = _next_cycle_remind_at(row["remind_at"], next_deadline, recurrence, now)
        cursor = c.execute(
            "INSERT INTO todos(email_id,title,deadline,status,created_at,user_edited,stage,kind,remind_at,recurrence,recurrence_source_id) "
            "VALUES(?,?,?,'open',?,1,?,?,?,?,?)",
            (
                row["email_id"],
                row["title"],
                next_deadline,
                now_iso,
                row["stage"] or "active",
                row["kind"] or "execution",
                next_remind,
                recurrence,
                row["id"],
            ),
        )
        spawned_ids.append(cursor.lastrowid)
    if not spawned_ids:
        return []
    s_slots = ",".join("?" for _ in spawned_ids)
    return [
        dict(r)
        for r in c.execute(
            "SELECT t.*, e.subject AS email_subject, e.from_addr AS email_from, "
            "e.date AS email_date, e.created_at AS email_indexed_at, e.thread_id AS email_thread "
            f"FROM todos t LEFT JOIN emails e ON e.id=t.email_id WHERE t.id IN ({s_slots})",
            spawned_ids,
        ).fetchall()
    ]


def set_todo_status(todo_id: int, status: str):
    now = datetime.now()
    completed_at = now.isoformat(timespec="seconds") if status == "done" else None
    with conn() as c:
        c.execute('BEGIN IMMEDIATE')
        _reward_completed(c, [todo_id], status)
        spawned = _spawn_next_recurring_todos(c, [todo_id], status, now)
        c.execute(
            "UPDATE todos SET status=?,user_edited=1,completed_at=CASE WHEN ?='done' THEN ? ELSE NULL END,"
            "remind_at=CASE WHEN ?='done' THEN NULL ELSE remind_at END WHERE id=?",
            (status, status, completed_at, status, todo_id),
        )
        return spawned


def set_todos_status_detailed(todo_ids: list[int], status: str) -> tuple[int, list[dict]]:
    ids = sorted({int(todo_id) for todo_id in todo_ids if int(todo_id) > 0})
    if not ids:
        return 0, []
    now = datetime.now()
    completed_at = now.isoformat(timespec="seconds") if status == "done" else None
    placeholders = ",".join("?" for _ in ids)
    with conn() as c:
        c.execute('BEGIN IMMEDIATE')
        _reward_completed(c, ids, status)
        spawned = _spawn_next_recurring_todos(c, ids, status, now)
        cursor = c.execute(
            f"UPDATE todos SET status=?,user_edited=1,completed_at=CASE WHEN ?='done' THEN ? ELSE NULL END,"
            f"remind_at=CASE WHEN ?='done' THEN NULL ELSE remind_at END WHERE id IN ({placeholders})",
            [status, status, completed_at, status, *ids],
        )
        return cursor.rowcount, spawned


def set_todos_status(todo_ids: list[int], status: str) -> int:
    updated, _ = set_todos_status_detailed(todo_ids, status)
    return updated


def _reward_completed(c, ids, status):
    if status != 'done':
        return
    from ..companion_growth import safe_record
    slots = ','.join('?' for _ in ids)
    for row in c.execute(f"SELECT id FROM todos WHERE status='open' AND id IN ({slots})", ids).fetchall():
        # The permanent hashed event key prevents reopen/complete reward farming.
        safe_record('task', key=f"completed-task:{row['id']}", connection=c)


def update_todo(todo_id: int, *, title: str | None = None, deadline: str | None = None):
    sets, values = [], []
    if title is not None:
        sets.append("title=?"); values.append(title.strip())
    if deadline is not None:
        sets.append("deadline=?"); values.append(deadline or None)
    if not sets:
        return
    values.append(todo_id)
    with conn() as c:
        c.execute(f"UPDATE todos SET user_edited=1,{', '.join(sets)} WHERE id=?", values)


def refresh_generated_todos(email_id: int, todos: list):
    """Refresh machine-only suggestions without racing a user's task edits."""
    with conn() as c:
        c.execute('BEGIN IMMEDIATE')
        if c.execute("SELECT 1 FROM todos WHERE email_id=? AND (user_edited=1 OR status='done' OR remind_at IS NOT NULL OR stage='waiting') LIMIT 1", (email_id,)).fetchone():
            return
        existing = {}
        for row in c.execute('SELECT * FROM todos WHERE email_id=? ORDER BY id', (email_id,)):
            existing.setdefault(_identity(row['title'], row['deadline']), row['id'])
        keep = []
        for title, deadline, key in _suggestions(todos):
            if key in existing:
                keep.append(existing[key])
            else:
                cursor = c.execute("INSERT INTO todos(email_id,title,deadline,status,created_at) VALUES(?,?,?,'open',?)",(email_id,title,deadline,datetime.now().isoformat(timespec='seconds')))
                keep.append(cursor.lastrowid)
        if keep:
            c.execute('DELETE FROM todos WHERE email_id=? AND id NOT IN (' + ','.join('?' for _ in keep) + ')', (email_id, *keep))
        else:
            c.execute('DELETE FROM todos WHERE email_id=?', (email_id,))


def delete_todos_of(email_id: int):
    with conn() as c:
        c.execute("DELETE FROM todos WHERE email_id=?", (email_id,))
