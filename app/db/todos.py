"""待办事项。"""
from datetime import datetime
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


def set_todo_status(todo_id: int, status: str):
    with conn() as c:
        c.execute("UPDATE todos SET status=?,user_edited=1,remind_at=CASE WHEN ?='done' THEN NULL ELSE remind_at END WHERE id=?", (status, status, todo_id))


def set_todos_status(todo_ids: list[int], status: str) -> int:
    ids = sorted({int(todo_id) for todo_id in todo_ids if int(todo_id) > 0})
    if not ids:
        return 0
    placeholders = ",".join("?" for _ in ids)
    with conn() as c:
        cursor = c.execute(
            f"UPDATE todos SET status=?,user_edited=1,remind_at=CASE WHEN ?='done' THEN NULL ELSE remind_at END WHERE id IN ({placeholders})",
            [status, status, *ids],
        )
        return cursor.rowcount


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
