"""Account-local search snapshots for reliable, reversible UI refinements."""
import json
import uuid
from datetime import datetime
from . import db, config, productivity

ACTIONS = {'exclude_results','relax_dates','relax_keywords','set_sender','set_keywords','undo','retry'}
FIELDS = ('sender','recipient','subject','filename','after','before','mailbox','state','category','has_attachment','unread')


def checked_criteria(value):
    clean = productivity.normalize_search_criteria({key:value[key] for key in FIELDS if key in value})
    clean.update(terms=[str(word)[:80] for word in value.get('terms',[])[:12] if str(word).strip()],text=str(value.get('text') or '')[:1000],query='')
    return clean


def get(run_id, conversation_id=None):
    with db.conn() as c:
        row = c.execute('SELECT * FROM assistant_search_runs WHERE id=?',(str(run_id),)).fetchone()
    if not row or (conversation_id is not None and row['conversation_id'] != conversation_id):
        raise ValueError('这次检索已不可用，请重新检索')
    return {**dict(row),**json.loads(row['payload'])}


def prepare(run_id, conversation_id, action='', value=''):
    run = get(run_id,conversation_id)
    if run['status'] != 'complete' and not (run['status']=='error' and action=='retry'):
        raise ValueError('请等待检索完成后再调整条件')
    if action and action not in ACTIONS:
        raise ValueError('无效检索操作')
    context = {key:run.get(key) for key in ('criteria','exclude_ids','root_question')}
    context.update(previous_run_id=run['id'],action=action)
    criteria = dict(context['criteria'])
    if action == 'undo':
        if not run.get('previous_run_id'):
            raise ValueError('没有可以撤销的检索调整')
        old = get(run['previous_run_id'],conversation_id)
        context.update({key:old.get(key) for key in ('criteria','exclude_ids','root_question','previous_run_id')})
        criteria = dict(context['criteria'])
    elif action == 'exclude_results':
        if not run.get('source_ids') or len(context['exclude_ids']) >= 200:
            raise ValueError('请补充一个发件人或主题关键词继续查找')
        context['exclude_ids'] = list(dict.fromkeys([*context['exclude_ids'],*run['source_ids']]))[:200]
    elif action == 'relax_dates':
        criteria.pop('after',None); criteria.pop('before',None)
    elif action == 'relax_keywords':
        if criteria.get('subject'):
            words = list(dict.fromkeys([criteria.pop('subject'),*criteria.get('terms',[])]))
        else:
            words = criteria.get('terms',[])[:1]
        criteria.update(terms=words,text=' '.join(words))
    elif action in {'set_sender','set_keywords'}:
        value = str(value or '').strip()
        if not value or len(value)>250:
            raise ValueError('请输入姓名、邮箱或一个主题关键词（最多250字）')
        if action == 'set_sender':
            criteria['sender'] = value
        else:
            criteria.pop('subject',None)
            criteria.update(terms=[value],text=value)
    context['criteria'] = checked_criteria(criteria)
    return context


def create(conversation_id, snapshot):
    run_id = uuid.uuid4().hex
    payload = {**snapshot,'criteria':checked_criteria(snapshot['criteria']),'found_id':None}
    with db.conn() as c:
        c.execute('INSERT INTO assistant_search_runs(id,conversation_id,payload,created_at) VALUES(?,?,?,?)',
                  (run_id,conversation_id,json.dumps(payload,ensure_ascii=False),datetime.now().isoformat(timespec='seconds')))
    return get(run_id)


def finish(run_id,message_id,status='complete'):
    with db.conn() as c:
        c.execute('UPDATE assistant_search_runs SET status=?,message_id=? WHERE id=?',(status,message_id,run_id))
    return get(run_id)


def public(run):
    criteria = run['criteria']
    actions = []
    if run['status']=='complete' and not run.get('found_id'):
        if run.get('source_ids') and len(run.get('exclude_ids',[]))<200: actions.append('exclude_results')
        if criteria.get('after') or criteria.get('before'): actions.append('relax_dates')
        if len(criteria.get('terms',[]))>1 or criteria.get('subject'): actions.append('relax_keywords')
        if run.get('previous_run_id'): actions.append('undo')
    return {'id':run['id'],'conversation_id':run['conversation_id'],'status':run['status'],
            'account_user':config.IMAP_USER,'conditions':[{'field':key,'value':criteria[key]} for key in FIELDS if criteria.get(key)],
            'keywords':criteria.get('terms',[]),'source_ids':run.get('source_ids',[]),'excluded_count':len(run.get('exclude_ids',[])),
            'actions':actions,'found_id':run.get('found_id'),'question':run['root_question'],'adjustment':run.get('adjustment','')}


def confirm(run_id,email_id):
    run = get(run_id)
    if run['status']!='complete' or (email_id is not None and email_id not in run.get('source_ids',[])):
        raise ValueError('请从这次检索结果中选择邮件')
    row = db.get_email(email_id) if email_id is not None else None
    if email_id is not None and (not row or row.get('remote_missing')):
        raise ValueError('邮件已不可用，请继续检索')
    payload = json.loads(run['payload'])
    payload['found_id'] = email_id
    with db.conn() as c:
        c.execute('UPDATE assistant_search_runs SET payload=? WHERE id=?',(json.dumps(payload,ensure_ascii=False),run_id))
    return public(get(run_id))


def restore(messages,conversation_id):
    with db.conn() as c:
        runs = c.execute('SELECT * FROM assistant_search_runs WHERE conversation_id=? AND message_id IS NOT NULL',(conversation_id,)).fetchall()
    by_message = {row['message_id']:public({**dict(row),**json.loads(row['payload'])}) for row in runs}
    for message in messages:
        if message['id'] in by_message: message['search'] = by_message[message['id']]
    return messages
