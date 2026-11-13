"""One task identity shared by work briefing, task center and reminders."""
from datetime import date, datetime, timedelta
from . import db


def save_group_reminder(todo_ids, remind_at):
    """Atomically schedule the selected open subtasks in the current account."""
    ids = sorted(set(todo_ids))
    if not ids or len(ids) > 200 or any(type(value) is not int or value <= 0 for value in ids):
        raise ValueError('请选择 1–200 项待办')
    if remind_at:
        try:
            when = datetime.fromisoformat(remind_at)
            if when.tzinfo:
                when = when.astimezone().replace(tzinfo=None)
            if when <= datetime.now():
                raise ValueError()
            remind_at = when.isoformat(timespec='seconds')
        except ValueError:
            raise ValueError('请选择将来的提醒时间')
    with db.conn() as c:
        c.execute('BEGIN IMMEDIATE')
        slots = ','.join('?' for _ in ids)
        rows = c.execute(f'SELECT id,status FROM todos WHERE id IN ({slots})', ids).fetchall()
        if len(rows) != len(ids) or any(row['status'] != 'open' for row in rows):
            raise ValueError('待办状态已变化，请刷新后重新选择')
        c.execute(f'UPDATE todos SET remind_at=?,user_edited=1 WHERE id IN ({slots})', (remind_at or None, *ids))
        if remind_at:
            from .task_notifications import ensure_delivery_table
            ensure_delivery_table(c)
            c.executemany('INSERT OR REPLACE INTO task_notice_delivery(todo_id,remind_at,sent,retry_after) VALUES(?,?,0,?)',
                          [(value, remind_at, datetime.now().isoformat()) for value in ids])
    return len(ids)


def save(email_id=None, todo_id=None, **fields):
    allowed = {'title', 'deadline', 'stage', 'kind', 'remind_at', 'recurrence'}
    fields = {k: v for k, v in fields.items() if k in allowed and v is not None}
    if 'title' in fields:
        fields['title'] = fields['title'].strip()
        if not fields['title'] or len(fields['title']) > 500:
            raise ValueError('任务名称需为 1–500 个字')
    if fields.get('stage', 'active') not in ('active', 'waiting'):
        raise ValueError('无效任务阶段')
    if fields.get('kind', 'execution') not in ('execution', 'decision'):
        raise ValueError('无效任务类型')
    if 'recurrence' in fields:
        rec = str(fields['recurrence']).strip().lower()
        if rec == 'none':
            rec = ''
        if rec not in ('', 'weekly', 'monthly'):
            raise ValueError('重复周期仅支持不重复、每周或每月')
        fields['recurrence'] = rec
    if fields.get('deadline'):
        try: datetime.strptime(fields['deadline'], '%Y-%m-%d')
        except ValueError: raise ValueError('日期格式应为 YYYY-MM-DD')
    if fields.get('remind_at'):
        try:
            when = datetime.fromisoformat(fields['remind_at'])
            if when.tzinfo: when = when.astimezone().replace(tzinfo=None)
            if when <= datetime.now(): raise ValueError()
            fields['remind_at'] = when.isoformat(timespec='seconds')
        except ValueError: raise ValueError('请选择将来的提醒时间')
    with db.conn() as c:
        c.execute('BEGIN IMMEDIATE')
        if todo_id:
            task = c.execute('SELECT * FROM todos WHERE id=?',(todo_id,)).fetchone()
            if not task: raise ValueError('待办不存在')
        elif email_id is not None:
            email = c.execute('SELECT * FROM emails WHERE id=? AND remote_missing=0',(email_id,)).fetchone()
            if not email: raise ValueError('来源邮件不存在')
            task = c.execute("SELECT * FROM todos WHERE email_id=? ORDER BY CASE WHEN status='open' THEN 0 ELSE 1 END,id LIMIT 1",(email_id,)).fetchone()
            if task:
                # Concurrent creation must not overwrite the winner's task edits.
                return dict(task)
            cursor = c.execute("INSERT INTO todos(email_id,title,status,created_at,user_edited) VALUES(?,?,'open',?,1)",(email_id,fields.get('title') or email['subject'] or '处理邮件',datetime.now().isoformat(timespec='seconds')))
            todo_id = cursor.lastrowid
            task = c.execute('SELECT * FROM todos WHERE id=?',(todo_id,)).fetchone()
        else:
            if not fields.get('title'):
                raise ValueError('请填写待办标题')
            cursor = c.execute(
                "INSERT INTO todos(email_id,title,status,created_at,user_edited) VALUES(NULL,?,'open',?,1)",
                (fields['title'], datetime.now().isoformat(timespec='seconds')),
            )
            todo_id = cursor.lastrowid
            task = c.execute('SELECT * FROM todos WHERE id=?',(todo_id,)).fetchone()
        if task['status'] == 'done' and fields.get('remind_at'):
            raise ValueError('请先恢复已完成的待办，再设置提醒')
        if fields:
            c.execute('UPDATE todos SET user_edited=1,' + ','.join(f'{k}=?' for k in fields) + ' WHERE id=?', [*fields.values(), task['id']])
        if fields.get('remind_at') and fields['remind_at'] != task['remind_at']:
            from .task_notifications import ensure_delivery_table
            ensure_delivery_table(c)
            c.execute("INSERT OR REPLACE INTO task_notice_delivery(todo_id,remind_at,sent,retry_after) VALUES(?,?,0,?)",
                      (task['id'], fields['remind_at'], datetime.now().isoformat()))
        return _fetch_enriched_todo(c, task['id'])


def _fetch_enriched_todo(c, todo_id: int) -> dict:
    row = c.execute(
        "SELECT t.*, e.subject AS email_subject, e.from_addr AS email_from, "
        "e.date AS email_date, e.created_at AS email_indexed_at, e.thread_id AS email_thread "
        "FROM todos t LEFT JOIN emails e ON e.id=t.email_id WHERE t.id=?",
        (todo_id,),
    ).fetchone()
    return dict(row)


def _snooze_target_date(preset: str | None, deadline: str | None, ref: date) -> str:
    if preset == 'tomorrow':
        return (ref + timedelta(days=1)).isoformat()
    if preset == 'next_monday':
        delta = (7 - ref.weekday()) % 7 or 7
        return (ref + timedelta(days=delta)).isoformat()
    if preset == 'plus_3d':
        return (ref + timedelta(days=3)).isoformat()
    if deadline:
        try:
            datetime.strptime(deadline, '%Y-%m-%d')
            return deadline
        except ValueError:
            raise ValueError('日期格式应为 YYYY-MM-DD')
    raise ValueError('请选择推迟时间')


def _shift_reminder_to_date(old_remind: str | None, target_day: date, now: datetime) -> str | None:
    if not old_remind:
        return None
    try:
        when = datetime.fromisoformat(str(old_remind))
        if when.tzinfo:
            when = when.astimezone().replace(tzinfo=None)
    except ValueError:
        return None
    shifted = datetime.combine(target_day, when.time())
    if shifted <= now:
        return None
    return shifted.isoformat(timespec='seconds')


def snooze_many(todo_ids: list[int], *, preset: str | None = None, deadline: str | None = None, remind_at: str | None = None, reference_date: date | None = None) -> list[dict]:
    ids = sorted({int(value) for value in todo_ids if isinstance(value, int) and value > 0})
    if not ids or len(ids) > 200:
        raise ValueError('请选择 1–200 项待办')
    now = datetime.now()
    ref = reference_date or now.date()
    explicit_remind = None
    if remind_at is not None and remind_at != '':
        try:
            when = datetime.fromisoformat(remind_at)
            if when.tzinfo:
                when = when.astimezone().replace(tzinfo=None)
            if when <= now:
                raise ValueError()
            explicit_remind = when.isoformat(timespec='seconds')
        except ValueError:
            raise ValueError('请选择将来的提醒时间')
    target_deadline = _snooze_target_date(preset, deadline or (explicit_remind[:10] if explicit_remind else None), ref)
    target_day = date.fromisoformat(target_deadline)
    updated = []
    with db.conn() as c:
        c.execute('BEGIN IMMEDIATE')
        slots = ','.join('?' for _ in ids)
        rows = c.execute(f'SELECT * FROM todos WHERE id IN ({slots})', ids).fetchall()
        if len(rows) != len(ids):
            raise ValueError('待办不存在')
        if any(row['status'] == 'done' for row in rows):
            raise ValueError('请先恢复已完成的待办，再推迟')
        from .task_notifications import ensure_delivery_table
        delivery_ready = False
        for row in rows:
            next_remind = explicit_remind if explicit_remind is not None else (None if remind_at == '' else _shift_reminder_to_date(row['remind_at'], target_day, now))
            if explicit_remind is None and remind_at is None and row['remind_at'] and next_remind is None:
                # Preserve the original alarm time only when it remains in the future; otherwise keep as cleared/date-only.
                next_remind = None
            c.execute(
                'UPDATE todos SET deadline=?, remind_at=?, user_edited=1 WHERE id=?',
                (target_deadline, next_remind, row['id']),
            )
            if next_remind and next_remind != row['remind_at']:
                if not delivery_ready:
                    ensure_delivery_table(c)
                    delivery_ready = True
                c.execute(
                    'INSERT OR REPLACE INTO task_notice_delivery(todo_id,remind_at,sent,retry_after) VALUES(?,?,0,?)',
                    (row['id'], next_remind, now.isoformat()),
                )
            updated.append(_fetch_enriched_todo(c, row['id']))
    return updated


def snooze(todo_id: int, **kwargs) -> dict:
    rows = snooze_many([todo_id], **kwargs)
    return rows[0]
