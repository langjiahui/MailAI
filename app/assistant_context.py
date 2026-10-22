"""Resolve conversational mail references against account-local saved sources.

Only the user's current question controls routing. Client history, quoted mail
text and model-generated citation strings never authorize a new source scope.
"""
import json
import re

from . import db


def normalized(question):
    text = re.sub(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|“[^”]*”|‘[^’]*’', '\ue000', str(question or ''))
    text = re.sub(r'[\s，,。！？?!、；;：:]', '', text.lower())
    text = re.sub(r'^(?:你好|您好|小邮)', '', text)
    return re.sub(r'^(?:(?:请问|请|麻烦|你帮我|你给我|帮我|给我|能不能|可不可以|能否|可以|能)(?:你)?)+', '', text)


def references_open(question):
    text = normalized(question)
    return bool(re.search(r'(?:这|此|本|当前|正在看|刚打开)(?:的)?(?:一封|封)?邮件|这封|这封信|thisemail|currentemail|^它(?:说|讲|写|提到|要求|主要|内容|重点|风险)', text))


def references_group(question):
    return bool(re.search(r'这些(?:邮件)?|这几封|刚才(?:找到|查到|那几封|那些|的邮件)|它们|thoseemails|theseemails|thesemessages', normalized(question)))


def is_task_analysis(question):
    text = normalized(question)
    return bool(re.search(r'待办|待处理|负责人|谁负责|截止|下一步|需要我|我需要|要我做|该做|要做什么|要做啥|跟进什么|行动项', text))


def is_global_tasks(question):
    text = re.sub(r'^(?:查看|列出|看一下|查一下|看看|看下|查下|查询|显示)', '', normalized(question))
    text = re.sub(r'^(?:梳理一下|整理一下|梳理|整理)(?=我的|今天|今日|当前|全部)', '', text)
    return bool(re.fullmatch(
        r'(?:查看|列出|看看|查询|显示|有哪些|哪些|我的|当前|全部|今天|今日|已经|已|未完成|未处理|过期|逾期|的|有什么)*'
        r'(?:待办|任务|事项)(?:清单|列表|有哪些|是什么|已过期|已经过期|过期了|逾期了|需要处理|要处理|已逾期)?'
        r'|(?:我)?(?:今天|今日)(?:我)?(?:有什么|有哪些|有啥|需要|要|该)(?:要处理|处理|做|完成|忙|干)(?:的事|什么|些什么|事项|啥|什么事|的)?', text))


def is_content_request(question):
    return bool(re.search(r'总结|概括|提炼|归纳|梳理|解释|分析|重点|要点|负责人|截止|下一步|要我做|需要我|我需要|待办|行动项|summari[sz]e', normalized(question)))


def is_bare_followup(question):
    clauses = [part for part in re.split(r'[，,。！？?!、；;\n]+', str(question or '')) if part.strip()]
    if len(clauses)>1:
        return all(is_bare_followup(part) for part in clauses)
    text = normalized(question)
    text = re.sub(r'^(?:那么|那|然后|接着|接下来|再|顺便|先)+', '', text)
    return bool(re.fullmatch(
        r'(?:总结|概括|提炼|归纳|梳理|分析|解释|说)(?:一下|下)?(?:重点|内容|要点|大意|待办|待办事项|行动项)?(?:一下|吧)?'
        r'|(?:我)?(?:需要|应该|要|该)(?:做|处理|跟进)(?:什么|哪些|啥)(?:呢)?'
        r'|(?:需要|要)(?:我)?(?:做|处理|跟进)(?:什么|哪些|啥)(?:呢)?'
        r'|(?:我)?(?:应该|该|要|需要)(?:怎么|如何)(?:做|处理|推进|跟进|回复)(?:呢)?'
        r'|(?:列成|整理成|梳理成|列出)(?:待办|待办清单|任务清单|行动项)'
        r'|(?:说)?(?:简单|简短|简洁|详细)(?:一点|一些|点)|说人话|谁负责|什么时候截止|有截止时间吗'
        r'|(?:需要|需不需要|要不要|该不该|应该)(?:我)?(?:回复|跟进)(?:吗)?|为什么(?:有风险|可疑|危险)|安全吗|靠谱吗'
        r'|用[一两三四五\d]+(?:句|句话|点)(?:总结|概括|说清楚)'
        r'|(?:它的|这个的)?(?:负责人|截止时间|截止日期)(?:呢|是谁|是什么|有写吗)?'
        r'|(?:具体)?(?:怎么做|怎么推进)|(?:还有)?什么(?:要|需要)注意(?:的)?'
        r'|(?:继续|展开说说|详细说说|还有呢|接下来呢)(?:吧|吗)?'
        r'|(?:列成|列个|整理成)(?:清单|列表)(?:吧)?'
        r'|summari[sz]e(?:that|them)?|whatshouldido(?:next)?', text))


def _recent_ids(conversation_id):
    if not conversation_id:
        return []
    with db.conn() as c:
        row = c.execute("SELECT sources FROM assistant_messages WHERE conversation_id=? AND role='assistant' ORDER BY id DESC LIMIT 1",
                        (conversation_id,)).fetchone()
    try:
        sources = json.loads(row['sources'] or '[]') if row else []
        return [source['id'] for source in sources if isinstance(source, dict) and isinstance(source.get('id'), int)][:20]
    except (ValueError, TypeError):
        return []


def _valid_ids(values):
    result = []
    for value in dict.fromkeys(values or []):
        row = db.get_email(value)
        if row and not row.get('remote_missing'):
            result.append(value)
    return result[:20]


def remember_open_email(conversation_id, email_id):
    """Track the reading pane independently of the last analysis/search scope."""
    valid = _valid_ids([email_id]) if email_id else []
    with db.conn() as c:
        c.execute('UPDATE assistant_conversations SET open_email_id=? WHERE id=?',
                  (valid[0] if valid else None, conversation_id))


def _open_changed(payload):
    if not payload.open_email_id or not payload.conversation_id:
        return False
    with db.conn() as c:
        row = c.execute('SELECT open_email_id FROM assistant_conversations WHERE id=?',
                        (payload.conversation_id,)).fetchone()
    return bool(row and row['open_email_id'] != payload.open_email_id)


def _scoped_history(conversation_id, ids):
    """Keep only consecutive, completed turns about exactly this source scope.

    Saved source metadata is authoritative. Old assistant prose and client-sent
    history must not reintroduce another mail's facts after a scope change.
    """
    if not conversation_id or not ids:
        return []
    with db.conn() as c:
        rows = c.execute('SELECT role,content,sources FROM assistant_messages WHERE conversation_id=? '
                         'ORDER BY id DESC LIMIT 12', (conversation_id,)).fetchall()
    history, waiting_user = [], False
    for row in rows:
        if row['role'] == 'assistant':
            if waiting_user:
                break
            try:
                source_ids = {s['id'] for s in json.loads(row['sources'] or '[]') if isinstance(s, dict) and isinstance(s.get('id'), int)}
            except (ValueError, TypeError):
                break
            if source_ids != set(ids):
                break
            waiting_user = True
        elif row['role'] == 'user':
            if not waiting_user:
                continue
            waiting_user = False
        else:
            break
        history.append({'role': row['role'], 'content': str(row['content'])[:1000]})
        if len(history) >= 6 and not waiting_user:
            break
    if waiting_user:
        history.pop()
    return list(reversed(history))


def resolve(payload):
    """Return a request with an explicit scope and optional UI routing metadata."""
    from .mail_assistant import _direct_answer
    if payload.images or payload.attachments or payload.alert_context or payload.search_action:
        return payload, None
    if _direct_answer(payload.question):
        return payload.model_copy(update={'search_mode':False, 'search_run_id':'', 'history':[]}), None
    text = normalized(payload.question)
    fresh_topic = bool(re.match(r'^(?:换个话题|换一个话题|另一个问题|不说这个了|先不说这个|说点别的|另外|重新)', text))
    if fresh_topic:
        text = re.sub(r'^(?:换个话题|换一个话题|另一个问题|不说这个了|先不说这个|说点别的|另外|重新)', '', text)
        text = normalized(text)
        payload = payload.model_copy(update={'email_ids':None, 'history':[], 'search_mode':False,
                                              'search_run_id':'', 'search_action':'', 'search_value':''})
    opened, group = references_open(text), references_group(text)
    ordinal = re.search(r'第([一二三四五六七八九十]|1[0-9]|20|[1-9])封', text)
    bare = is_bare_followup(text if fresh_topic else payload.question)
    content = is_content_request(text)
    # A plain task-list question refers to saved tasks, rather than the last mail.
    global_tasks = is_global_tasks(text)
    update = {'search_mode': False, 'search_run_id': '', 'search_action': '', 'search_value': ''}
    # The explicit search handoff is read-only, even if its query quotes or
    # contains an imperative mail action. Analysis follow-ups can leave search.
    if payload.search_mode and not (content or bare) and re.search(
            r'(?:帮我|替我|请)(?:回复|转发|发送|删除|移动|标记|创建|填写)|(?:回复|转发|删除|标记)这封', text):
        return payload, None
    if global_tasks and not (opened or group):
        return payload.model_copy(update={**update, 'email_ids': None, 'history':[]}), {'intent': 'mailbox', 'email_ids': None}
    if opened or group or ordinal or bare:
        previous = _recent_ids(payload.conversation_id)
        if ordinal:
            number = ordinal[1]
            index = int(number) if number.isdigit() else '一二三四五六七八九十'.index(number)+1
            ids = previous[index-1:index]
        elif opened:
            ids = [payload.open_email_id] if payload.open_email_id else payload.email_ids if len(payload.email_ids or [])==1 else previous if len(previous)==1 else []
        elif group:
            ids = payload.email_ids if payload.email_ids is not None else previous
        else:
            if _open_changed(payload):
                ids = [payload.open_email_id]
            elif payload.email_ids is not None:
                ids = payload.email_ids
            else:
                ids = previous or ([payload.open_email_id] if payload.open_email_id else [])
        ids = _valid_ids(ids)
        return payload.model_copy(update={**update, 'email_ids': ids,
                                          'history':[] if fresh_topic else _scoped_history(payload.conversation_id, ids)}), {'intent': 'context', 'email_ids': ids}
    # A named summary starts a new analysis, never a refinement of an old search.
    if content:
        return payload.model_copy(update={**update, 'email_ids': None, 'history':[]}), {'intent': 'mailbox', 'email_ids': None}
    # Keep the existing risk/priority logic instead of searching for those words
    # inside message bodies. A risk question is not a literal keyword query.
    if re.search(r'重要邮件|紧急邮件|高优先级|优先级高|最高优先级|风险|钓鱼|可疑|危险', text):
        return payload.model_copy(update={**update, 'email_ids': None, 'history':[]}), {'intent': 'mailbox', 'email_ids': None}
    if re.match(r'^(?:再)?(?:查找|搜索|查询|查一下|查下|找一下|找出|找到|找|筛选|筛出|查看|看看|只看|仅看)', text):
        update = {'search_mode': True, 'email_ids': None}
        if fresh_topic or not re.match(r'^(?:再|只看|仅看)', text):
            update.update(search_run_id='', search_action='', search_value='', history=[])
        return payload.model_copy(update=update), {'intent': 'search', 'email_ids': None}
    if fresh_topic:
        return payload.model_copy(update={**update, 'email_ids':None}), {'intent':'mailbox', 'email_ids':None}
    return payload, None
