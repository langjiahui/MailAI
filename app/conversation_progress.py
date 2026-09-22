"""Account-local, evidence-only progress. No model calls or inferred obligations."""
import re
from datetime import datetime, timezone
from email.utils import parseaddr

from . import config, db
from .mail_assistant import needs_risk_attention
from .conversation_changes import own_text, detect

MAX_MESSAGES = 100
MAX_KEYS = 256
MAX_ROUNDS = 12


def _keys(row):
    text = ' '.join(str(row.get(k) or '') for k in ('message_id', 'in_reply_to', 'references_header', 'thread_id'))
    return set(re.findall(r'<[^<>\s]+@[^<>\s]+>', text.lower()))


def _time(value):
    try:
        dt = datetime.fromisoformat(str(value or '').replace('Z', '+00:00'))
        return (dt if dt.tzinfo else dt.astimezone()).astimezone(timezone.utc).timestamp()
    except (ValueError, TypeError, OverflowError):
        return 0


def _excerpt(row, sent=False):
    return re.sub(r'\s+', ' ', own_text(row, sent)).strip()[:320]


def build(email_id):
    current = db.get_email(email_id)
    if not current or current.get('remote_missing') or current.get('status') in ('trash', 'spam', 'quarantine', 'draft'):
        raise ValueError('邮件不存在或不在可查看的会话范围内')
    emails = {current['id']: current}
    sent = {}
    keys = _keys(current)
    truncated = False
    with db.conn() as connection:
        for _ in range(MAX_ROUNDS):
            previous = (len(emails), len(sent), frozenset(keys))
            if len(keys) > MAX_KEYS:
                truncated = True
                keys = set(sorted(keys)[:MAX_KEYS])
            ids = sorted(emails)
            marks = ','.join('?' for _ in keys) or 'NULL'
            id_marks = ','.join('?' for _ in ids)
            params = sorted(keys)
            rows = connection.execute(f"""SELECT id,message_id,in_reply_to,references_header,thread_id,
                from_addr,from_name,to_addr,subject,date,status,substr(body_text,1,6000) AS body_text,
                snippet,verdict,score,reviewed,feedback,processing_complete,pending_action FROM emails WHERE remote_missing=0 AND status NOT IN ('trash','spam','quarantine','draft')
                AND (lower(message_id) IN ({marks}) OR lower(in_reply_to) IN ({marks}) OR lower(thread_id) IN ({marks}))
                ORDER BY date DESC,id DESC LIMIT ?""", params * 3 + [MAX_MESSAGES + 1]).fetchall()
            replies = connection.execute(f"""SELECT id,message_id,in_reply_to,references_header,
                from_addr,to_addr,subject,substr(body_html,1,12000) AS body_html,sent_at,created_at,status
                FROM sent_messages WHERE status='sent' AND (reply_to_email_id IN ({id_marks})
                OR lower(message_id) IN ({marks}) OR lower(in_reply_to) IN ({marks}))
                ORDER BY COALESCE(sent_at,created_at) DESC,id DESC LIMIT ?""", ids + params * 2 + [MAX_MESSAGES + 1]).fetchall()
            for kind, found, target in [('email', rows, emails), ('sent', replies, sent)]:
                for result in found:
                    row = dict(result)
                    if row['id'] not in target and len(emails) + len(sent) >= MAX_MESSAGES:
                        truncated = True
                        continue
                    target[row['id']] = row
                    keys.update(_keys(row))
            if previous == (len(emails), len(sent), frozenset(keys)):
                break
        else:
            truncated = True
        marks = ','.join('?' for _ in emails)
        tasks = [dict(row) for row in connection.execute(f"""SELECT id,email_id,title,deadline,status,
            stage,user_edited FROM todos WHERE email_id IN ({marks}) ORDER BY id DESC LIMIT 101""", list(emails))]
    owner = parseaddr(config.IMAP_USER or '')[1].casefold()
    timeline = []
    # Server-synced copies and the local send record represent one message.
    local_message_ids = {str(row.get('message_id') or '').lower() for row in sent.values()} - {''}
    seen_message_ids = set()
    for row in emails.values():
        mid = str(row.get('message_id') or '').lower()
        if mid and mid in seen_message_ids:
            continue
        if mid in local_message_ids and row['id'] != email_id:
            continue
        if mid:
            seen_message_ids.add(mid)
        timeline.append(dict(id=row['id'], source='email', date=row.get('date') or '',
            direction='outgoing' if row.get('status') == 'sent' or (owner and parseaddr(row.get('from_addr') or '')[1].casefold() == owner) else 'incoming',
            subject=row.get('subject') or '无主题', sender=row.get('from_name') or row.get('from_addr') or '未知发件人',
            excerpt=_excerpt(row), current=row['id'] == email_id,
            risky=needs_risk_attention(row)))
    current_mid = str(current.get('message_id') or '').lower()
    for row in sent.values():
        mid = str(row.get('message_id') or '').lower()
        if mid and (mid == current_mid or mid in seen_message_ids):
            continue
        if mid:
            seen_message_ids.add(mid)
        timeline.append(dict(id=row['id'], source='sent', date=row.get('sent_at') or row.get('created_at') or '',
            direction='outgoing', subject=row.get('subject') or '无主题', sender='我', excerpt=_excerpt(row, True), current=False, risky=False))
    timeline.sort(key=lambda item: (_time(item['date']), item['source'], item['id']), reverse=True)
    records = {('email', row['id']): row for row in emails.values()}
    records.update({('sent', row['id']): row for row in sent.values()})
    changes = detect(timeline, records)
    confirmed = [task for task in tasks if task.get('user_edited')]
    open_tasks = [task for task in confirmed if task['status'] != 'done']
    waiting = [task for task in open_tasks if task.get('stage') == 'waiting']
    if open_tasks:
        status = '已标记等待反馈' if len(waiting) == len(open_tasks) else '有待推进的任务'
        next_step = '核对最新往来，确认等待状态是否仍然适用。' if waiting else '核对最新往来，按已保存的任务继续推进。'
    elif confirmed:
        status = '已记录任务完成'
        next_step = '待办已完成；仍需核对后续来信，确认整个事项是否结束。'
    else:
        status = '处理状态待确认'
        next_step = '核对最新往来后，确认是否需要自己推进或等待反馈。'
    return dict(account_id=config.ACCOUNT_ID, account_user=config.IMAP_USER, email_id=email_id,
        status=status, next_step=next_step, timeline=timeline, tasks=tasks[:100], changes=changes,
        truncated=truncated or len(tasks) > 100, linked_count=len(timeline),
        basis='状态依据你保存的待办；来信或发信本身不代表事项完成。',
        scope='仅本邮箱已同步邮件及可关联的成功发件记录，按回复邮件头关联，不按主题猜测。旧发件记录缺少回复关系时可能未列入。')
