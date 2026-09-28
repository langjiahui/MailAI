"""Read-only phone briefings from the same local evidence as the desktop assistant."""
from datetime import date, datetime
from . import db, mail_assistant


def phone_time(value):
    """Show stored mail timestamps in the computer's local time, without ISO offsets."""
    if not value or value == '尚无成功同步记录':
        return '尚无成功同步记录' if value == '尚无成功同步记录' else '时间未知'
    try:
        moment = datetime.fromisoformat(str(value or '').strip().replace('Z', '+00:00'))
        if moment.tzinfo:
            moment = moment.astimezone()
    except (TypeError, ValueError):
        return '时间未知'
    return moment.strftime('%m月%d日 %H:%M' if moment.year == datetime.now().year else '%Y年%m月%d日 %H:%M')


def _single_line(value, fallback, limit):
    return ' '.join(str(value or '').split())[:limit] or fallback


def mail_window(*, after_id=None, start=None, end=None, upper=None, important_only=False):
    """Bounded metadata pages and counts in one SQLite snapshot. ID cursor catches late syncs."""
    with db.conn() as c:
        c.execute('BEGIN')
        upper = upper if upper is not None else c.execute('SELECT COALESCE(MAX(id),0) FROM emails').fetchone()[0]
        clauses = ["status='inbox'", 'remote_missing=0', "COALESCE(pending_action,'') NOT LIKE 'trash%'", 'id<=?']
        params = [upper]
        if after_id is not None:
            clauses.append('id>?'); params.append(after_id)
        if start is not None:
            clauses.append("datetime(COALESCE(NULLIF(date,''),created_at)) >= datetime(?)")
            params.append(start)
        if end is not None:
            clauses.append("datetime(COALESCE(NULLIF(date,''),created_at)) <= datetime(?)")
            params.append(end)
        if important_only:
            clauses.append("priority='高'")
        where = ' AND '.join(clauses)
        counts = dict(c.execute(f"SELECT COUNT(*) AS total,COALESCE(SUM(is_read=0),0) AS unread,COALESCE(SUM(priority='高'),0) AS important FROM emails WHERE {where}", params).fetchone())
        rows = [dict(r) for r in c.execute(f'SELECT id,subject,from_name,from_addr,date,summary,snippet,priority,created_at FROM emails WHERE {where} ORDER BY id ASC LIMIT 11', params)]
    return rows, counts, upper


def sync_hint():
    synced = db.get_runtime_settings().get('last_sync_success') or '尚无成功同步记录'
    return f'最近成功同步：{phone_time(synced)}\n读取本机已同步记录；可用“查收邮件”更新。'


def render_mails(rows, *, include_summary=True, include_priority=True):
    lines = []
    for n, row in enumerate(rows, 1):
        priority = ' · 高优先级' if include_priority and row.get('priority') == '高' else ''
        subject = _single_line(row.get('subject'), '无主题', 140)
        sender = _single_line(row.get('from_name') or row.get('from_addr'), '未知发件人', 55)
        entry = f'{n}. {subject}{priority}\n{sender} · {phone_time(row.get("date"))}'
        if include_summary:
            summary = _single_line(row.get('summary') or row.get('snippet'), '暂无摘要，可查看原邮件', 120)
            entry += f'\n摘要：{summary}'
        lines.append(entry)
    return '\n\n'.join(lines)


def important():
    # Filter in SQLite; don't load mail bodies or walk the whole inbox in Python.
    with db.conn() as c:
        rows = c.execute("""SELECT id,subject,from_name,from_addr,date,summary,snippet,priority,verdict,score
            FROM emails WHERE status='inbox' AND remote_missing=0 AND priority='高'
            AND COALESCE(pending_action,'') NOT LIKE 'trash%'
            AND datetime(COALESCE(NULLIF(date,''),created_at)) >= datetime('now','localtime','-30 days')
            ORDER BY date DESC,id DESC LIMIT 11""").fetchall()
    return [dict(row) for row in rows]


def today_tasks():
    # Task dates follow the assistant, not the age of the originating mail.
    with db.conn() as c:
        rows = [dict(row) for row in c.execute("""SELECT t.*,e.subject AS email_subject,
            e.from_addr AS email_from,e.date AS email_date FROM todos t JOIN emails e ON e.id=t.email_id
            WHERE t.status='open' AND e.remote_missing=0 AND e.status NOT IN ('trash','quarantine')
            AND COALESCE(e.pending_action,'') NOT LIKE 'trash%'
            ORDER BY datetime(COALESCE(NULLIF(e.date,''),NULLIF(t.created_at,''))) DESC,t.id DESC""")]
    _, rows = mail_assistant.todo_query_rows('今天有什么要处理？', rows)
    today = date.today().isoformat()
    def rank(row):
        deadline = str(row.get('deadline') or '')[:10]
        return (0 if deadline and deadline < today else 1 if deadline == today else 2 if reminder_today(row) else 3,
                deadline, -row['id'])
    return sorted(rows, key=rank)


def reminder_today(row):
    try:
        when = datetime.fromisoformat(str(row.get('remind_at') or ''))
        return (when.astimezone() if when.tzinfo else when).date() == date.today()
    except ValueError:
        return False


def task(todo_id):
    with db.conn() as c:
        row = c.execute("""SELECT t.*,e.subject AS email_subject,e.from_addr AS email_from,e.date AS email_date
            FROM todos t JOIN emails e ON e.id=t.email_id WHERE t.id=? AND e.remote_missing=0
            AND e.status NOT IN ('trash','quarantine') AND COALESCE(e.pending_action,'') NOT LIKE 'trash%'""",
            (todo_id,)).fetchone()
    return dict(row) if row else None


def task_label(row):
    deadline = str(row.get('deadline') or '')[:10]
    today = date.today().isoformat()
    label = '等待反馈' if row.get('stage') == 'waiting' else '待处理'
    if deadline:
        label += ' · ' + ('已逾期' if deadline < today else '今天到期' if deadline == today else '截止') + ' ' + deadline
    else:
        label += ' · 未设截止日期'
    if reminder_today(row):
        label += ' · 今天有提醒'
    return label


def render_tasks(rows, user, total=None):
    lines = [f'{user}\n小邮 · 今天待办（含逾期、无截止日期和今天提醒的事项）']
    if not rows:
        return '\n'.join(lines) + '\n当前没有符合条件的未完成待办。本次读取本机记录，可用“查收邮件”更新邮件。'
    lines.append(f'共 {total if total is not None else len(rows)} 项，以下显示 {len(rows)} 项：')
    for n, row in enumerate(rows, 1):
        if not row:
            lines.append(f'{n}. （待办已不可用）')
            continue
        label = '已完成' if row['status'] == 'done' else task_label(row)
        lines.append(f'{n}. {str(row.get("title") or "未命名待办")[:140]}\n   {label}\n   来源：{str(row.get("email_subject") or "无主题")[:100]}')
    if total and total > len(rows):
        lines.append('其余事项可在电脑待办中心查看。')
    return '\n'.join(lines) + '\n输入“查看第一项待办”看详情，或“查看第一项原邮件”；可说“下一项”“返回待办”。'
