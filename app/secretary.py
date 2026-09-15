"""Read-only work briefing: suggestions are evidence, never inferred obligations."""
import re
from datetime import date, datetime, timedelta
from . import config, db, mail_assistant


def question_sources(question):
    """Only unqualified work-brief requests; keep named/date-filtered search intact."""
    normalized = re.sub(r'[\s，。！？?!、]', '', question)
    normalized = re.sub(r'^(请帮我|帮我|请)', '', normalized)
    if normalized in ('给我工作简报', '工作简报', '我先处理什么', '梳理下一步工作'):
        focus = 'execution'
    elif normalized in ('有哪些需要我决策的邮件', '需要我决策的邮件', '梳理待决策的事'):
        focus = 'decision'
    else:
        return None
    result = briefing(focus)
    ids = list(dict.fromkeys(item['email_id'] for group in result['groups'] if group['key'] != 'history' for item in group['items']))[:20]
    return [row for email_id in ids if (row := db.get_email(email_id)) and not row.get('remote_missing')]


def briefing(focus='execution'):
    if focus not in ('execution', 'decision'):
        raise ValueError('不支持的简报视角')
    candidates = db.list_emails(status='inbox', days=7, limit=301)
    emails = candidates[:300]
    todos = db.list_todos(include_done=False)
    todo_sources = {item.get('email_id') for item in db.list_todos(include_done=True)}
    with db.conn() as c:
        dismissed = {row[0] for row in c.execute('SELECT email_id FROM briefing_dismissed')}
    groups = {key: [] for key in ('tasks', 'waiting', 'attention', 'safety', 'history')}
    today = date.today().isoformat()
    recent = (date.today() - timedelta(days=7)).isoformat()

    def card(row, reason, evidence='', **extra):
        return dict(email_id=row['id'], subject=row.get('subject') or '（无主题）',
                    sender=row.get('from_name') or row.get('from_addr') or '',
                    date=row.get('date') or '', reason=reason, evidence=evidence,
                    has_todo=row['id'] in todo_sources,
                    risky=mail_assistant.needs_risk_attention(row), **extra)

    for todo in todos:
        row = db.get_email(todo.get('email_id')) if todo.get('email_id') else None
        if not row or row.get('remote_missing'):
            continue
        try:
            deadline = date.fromisoformat(str(todo.get('deadline') or '')[:10]).isoformat()
        except ValueError:
            deadline = ''
        try:
            reminder = datetime.fromisoformat(str(todo.get('remind_at') or ''))
            if reminder.tzinfo:
                reminder = reminder.astimezone()
            remind_today = reminder.date().isoformat() == today
        except ValueError:
            remind_today = False
        waiting = todo.get('stage') == 'waiting'
        if remind_today or deadline == today:
            key = 'tasks'
            reason = '今天提醒' if remind_today else '今天跟进' if waiting else '今天截止'
        elif deadline and recent <= deadline < today:
            key = 'tasks'
            reason = ('跟进已逾期 · ' if waiting else '近期逾期 · ') + deadline
        elif deadline and deadline < recent:
            key = 'history'
            reason = '历史逾期 · ' + deadline
        elif waiting:
            key = 'waiting'
            reason = '等待反馈 · ' + ('跟进 ' + deadline if deadline else '未设跟进日期')
        else:
            # Undated and future tasks stay in the task center, not today's agenda.
            continue
        groups[key].append(card(row, reason, todo.get('title') or '', todo_id=todo['id'], deadline=deadline, stage=todo.get('stage'), kind=todo.get('kind'), remind_at=todo.get('remind_at')))
    groups['tasks'].sort(key=lambda item: (not item['reason'].startswith('今天'), item['deadline'], item['todo_id']))
    groups['waiting'].sort(key=lambda item: (not bool(item['deadline']), item['deadline'], item['todo_id']))
    groups['history'].sort(key=lambda item: (item['deadline'], item['todo_id']), reverse=True)

    pattern = r'请.{0,8}(?:审批|批示|决策|审定|批准|确认)|待.{0,4}(?:审批|决策)|需要.{0,6}(?:决策|批准)' if focus == 'decision' else r'请.{0,8}(?:反馈|回复|确认|提交|提供|安排|处理)|需要.{0,6}(?:反馈|回复|确认)'
    for row in emails:
        if mail_assistant.needs_risk_attention(row):
            groups['safety'].append(card(row, '高风险，先核实来源' if mail_assistant.risk_alert_level(row) == 'high' else '可疑，建议先核实', '来自本地安全检测，不等同于工作优先级。'))
            continue
        if row['id'] in todo_sources or row['id'] in dismissed:
            continue
        subject = row.get('subject') or ''
        summary = row.get('summary') or row.get('snippet') or ''
        text = re.sub(r'\s+', ' ', subject + '。' + summary)
        match = re.search(pattern, text)
        if match:
            groups['attention'].append(card(row, '可能需要决策或确认' if focus == 'decision' else '可能需要反馈或协作', text[max(0, match.start()-20):match.end()+65]))
        elif row.get('priority') == '高':
            groups['attention'].append(card(row, '被标为高重要程度', summary[:120] or subject))
    return dict(focus=focus, account_user=config.IMAP_USER, generated_at=datetime.now().isoformat(timespec='seconds'),
                days=7, scanned=len(emails), truncated=len(candidates)>300,
                scope='邮件线索来自近 7 天收件箱（最多 300 封）；今天先做按任务日期和提醒筛选，不按邮件新旧。',
                note='协作线索来自主题与摘要，不代表尚未回复、本人负责或尚未完成；请核对原邮件。',
                groups=[dict(key=key, title=title, count=len(groups[key]), items=groups[key][:8]) for key, title in (
                    ('tasks', '今天先做'), ('waiting', '等待反馈'), ('attention', '待你确认'), ('safety', '先核实再行动'), ('history', '历史待整理'))])
