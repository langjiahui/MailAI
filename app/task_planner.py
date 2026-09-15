"""One task identity shared by work briefing, task center and reminders."""
from datetime import datetime
from . import db


def save(email_id=None, todo_id=None, **fields):
    allowed = {'title', 'deadline', 'stage', 'kind', 'remind_at'}
    fields = {k: v for k, v in fields.items() if k in allowed and v is not None}
    if 'title' in fields:
        fields['title'] = fields['title'].strip()
        if not fields['title'] or len(fields['title']) > 500:
            raise ValueError('任务名称需为 1–500 个字')
    if fields.get('stage', 'active') not in ('active', 'waiting'):
        raise ValueError('无效任务阶段')
    if fields.get('kind', 'execution') not in ('execution', 'decision'):
        raise ValueError('无效任务类型')
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
        else:
            email = c.execute('SELECT * FROM emails WHERE id=? AND remote_missing=0',(email_id,)).fetchone()
            if not email: raise ValueError('来源邮件不存在')
            task = c.execute("SELECT * FROM todos WHERE email_id=? ORDER BY CASE WHEN status='open' THEN 0 ELSE 1 END,id LIMIT 1",(email_id,)).fetchone()
            if task:
                # Concurrent creation must not overwrite the winner's task edits.
                return dict(task)
            cursor = c.execute("INSERT INTO todos(email_id,title,status,created_at,user_edited) VALUES(?,?,'open',?,1)",(email_id,fields.get('title') or email['subject'] or '处理邮件',datetime.now().isoformat(timespec='seconds')))
            todo_id = cursor.lastrowid
            task = c.execute('SELECT * FROM todos WHERE id=?',(todo_id,)).fetchone()
        if task['status'] == 'done' and fields.get('remind_at'):
            raise ValueError('请先恢复已完成的待办，再设置提醒')
        if fields:
            c.execute('UPDATE todos SET user_edited=1,' + ','.join(f'{k}=?' for k in fields) + ' WHERE id=?', [*fields.values(), task['id']])
        return dict(c.execute('SELECT * FROM todos WHERE id=?',(task['id'],)).fetchone())
