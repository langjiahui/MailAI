"""待办事项。"""
from datetime import datetime

from .core import conn


def add_todos(email_id: int, todos: list):
    with conn() as c:
        for t in todos:
            title = (t.get("title") or "").strip()
            if not title:
                continue
            c.execute(
                "INSERT INTO todos(email_id,title,deadline,status,created_at) VALUES(?,?,?,?,?)",
                (email_id, title, t.get("deadline"), "open",
                 datetime.now().isoformat(timespec="seconds")),
            )


def list_todos(include_done=False):
    sql = (
        "SELECT t.*, e.subject AS email_subject, e.from_addr AS email_from, "
        "e.date AS email_date, e.created_at AS email_indexed_at "
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
        c.execute('DELETE FROM todos WHERE email_id=?', (email_id,))
        for todo in todos:
            title = (todo.get('title') or '').strip()
            if title:
                c.execute("INSERT INTO todos(email_id,title,deadline,status,created_at) VALUES(?,?,?,'open',?)",(email_id,title,todo.get('deadline'),datetime.now().isoformat(timespec='seconds')))


def delete_todos_of(email_id: int):
    with conn() as c:
        c.execute("DELETE FROM todos WHERE email_id=?", (email_id,))
