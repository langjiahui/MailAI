"""Local query interpretation shared by the search box and advanced search.

This handles explicit conditions, not arbitrary natural-language reasoning.
Unrecognised words remain keyword terms; quoted text is never rewritten.
"""
import re
import shlex
import json
from datetime import date, timedelta

_FIELDS = {
    '发件人': 'from', '发送人': 'from', '寄件人': 'from',
    '收件人': 'to', '接收人': 'to', '抄送': 'to',
    '主题': 'subject', '标题': 'subject',
    '附件名': 'filename', '附件名称': 'filename', '文件名': 'filename',
    '开始日期': 'after', '结束日期': 'before', '邮件范围':'in', '处理状态':'state', '分类':'category',
}
_VALUE_NAMES = {
    'in': {'all':'全部正常邮件','inbox':'收件箱','sent':'已发送','drafts':'草稿','trash':'已删除','spam':'垃圾邮件','quarantine':'隔离区'},
    'state': {'unhandled':'待处理','reply':'待回复','waiting':'等待反馈','later':'稍后处理','done':'已完成','due':'等待反馈已到期','focus':'重点邮件'},
}
_FIELD_NAMES = '|'.join(sorted(_FIELDS, key=len, reverse=True))
_DATES = r'(?:今天|昨天|前天|本周|这周|上周|本月|这个月|上个月|上月|今年|去年|(?:最近|过去|近)\s*\d{1,4}\s*天)'
_UNREAD = r'(?:未读|尚未阅读|还没读|没读过)'
_ATTACHMENT = r'(?:(?:带有|含有|包含|有|带|含)附件)'


def expand_natural_query(query, *, today=None):
    today = today or date.today()
    original = str(query or '').strip()
    prefix = re.match(r'^(?:请)?(?:帮我|给我)?(?:只|仅)?(?:查询一下|查找一下|搜索一下|查看一下|筛选一下|看一下|查一下|找一下|搜一下|看看|找到|找出|查到|查出|查看|显示|列出|筛选|筛出|查找|搜索|查询|检索|找|搜|看)\s*', original)
    if not prefix:
        prefix = re.match(r'^(?:please\s+)?(?:show|find|list|display|filter)(?:\s+me)?\s+', original, re.I)
    text = original[prefix.end():] if prefix else original
    source = text
    protected = []
    def hide(match):
        protected.append(match[0])
        return f'\ue000{len(protected)-1}\ue001'
    text = re.sub(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'', hide, text)
    # Separators count only before a recognised clause, never inside quotes.
    starts = '(?:' + _FIELD_NAMES + '|' + _DATES + '|' + _ATTACHMENT + '|' + _UNREAD + ')'
    text = re.sub(r'^(?:所有|全部)(?=\s*' + starts + ')', '', text).lstrip()
    # Split only adjacent, explicitly named conditions, not arbitrary prose.
    text = re.sub(r'(?<!\S)(' + _DATES + r')(?:的)?(?=' + _UNREAD + '|' + _ATTACHMENT + ')', r'\1 ', text)
    text = re.sub(r'(?<!\S)(' + _UNREAD + r')(?:的)?(?=' + _ATTACHMENT + ')', r'\1 ', text)
    text = re.sub(r'(?<!\S)(' + _ATTACHMENT + r')(?:的)?(?=' + _UNREAD + ')', r'\1 ', text)
    text = re.sub(r'(?:并且|而且|同时|以及|且)(?=\s*' + starts + ')', ' ', text)
    text = re.sub(r'[，；;,](?=\s*' + starts + ')', ' ', text)
    pattern = r'(?<!\S)(' + _FIELD_NAMES + r')\s*(?:是|为|包含|含有|[:：])\s*([^\s，；;,]+)'
    def replace(match):
        value = match[2].strip('，；;,')
        operator = _FIELDS[match[1]]
        # Mail is the object of the command, not part of a sender/recipient.
        # Quoted values were protected above and stay literal.
        if operator in {'from', 'to'} and value.endswith('的邮件'):
            value = value[:-3]
        value = {name:key for key,name in _VALUE_NAMES.get(operator,{}).items()}.get(value,value)
        return operator + ':' + shlex.quote(value)
    text = re.sub(pattern, replace, text)
    # These clauses name the role explicitly; an isolated name stays a keyword.
    text = re.sub(r'(?<!\S)(?:来自)([^\s，；;,]+?)(?:的邮件)?(?=\s|$)', lambda m:'from:'+shlex.quote(m[1]), text)
    text = re.sub(r'(?<!\S)([^\s，；;,]+?)(?:发来的|发的|发送的)(?:邮件)?(?=\s|$)', lambda m:'from:'+shlex.quote(m[1]), text)
    text = re.sub(r'(?<!\S)(?:发给|发送给|寄给)([^\s，；;,]+?)(?:的邮件)?(?=\s|$)', lambda m:'to:'+shlex.quote(m[1]), text)
    text = re.sub(r'(?<!\S)' + _ATTACHMENT + r'(?:的?(?:邮件|信件))?(?!\S)', 'has:attachment', text)
    text = re.sub(r'(?<!\S)' + _UNREAD + r'(?:的?(?:邮件|信件))?(?!\S)', 'is:unread', text)
    # English equivalents use the same hard filters, with no model request.
    text = re.sub(r'\band\s+(?=(?:unread|with\s+attachments)\b)', '', text, flags=re.I)
    text = re.sub(r'(?<!\S)(?:all\s+)?unread(?:\s+(?:e-?mails?|mails?|messages?))?(?!\S)', 'is:unread', text, flags=re.I)
    text = re.sub(r'(?<!\S)(?:e-?mails?\s+)?with\s+attachments(?!\S)', 'has:attachment', text, flags=re.I)
    def period(match):
        label = match[1]
        end = today
        if re.search(r'\d', label):
            days = int(re.search(r'\d+', label)[0])
            if not 1 <= days <= 3660:
                return match[0]
            start = today-timedelta(days=days-1)
        elif label in {'今天','昨天','前天'}:
            start = end = today-timedelta(days={'今天':0,'昨天':1,'前天':2}[label])
        elif label in {'本周','这周','上周'}:
            start = today-timedelta(days=today.weekday())
            if label == '上周':
                end, start = start-timedelta(days=1), start-timedelta(days=7)
        elif label in {'本月','这个月','上个月','上月'}:
            start = today.replace(day=1)
            if label in {'上个月','上月'}:
                end = start-timedelta(days=1)
                start = end.replace(day=1)
        else:
            start = today.replace(month=1,day=1)
            if label == '去年':
                end = start-timedelta(days=1)
                start = end.replace(month=1,day=1)
        return f'after:{start.isoformat()} before:{end.isoformat()}'
    text = re.sub(r'(?<!\S)(' + _DATES + r')(?:的邮件)?(?!\S)', period, text)
    for index, value in enumerate(protected):
        # A placeholder inserted into a field can acquire shell quoting; strip
        # just that wrapper before restoring the original query quotation.
        marker = f'\ue000{index}\ue001'
        text = text.replace(shlex.quote(marker), marker).replace(marker, value)
    return original if text == source else text


def interpret_query(query):
    from .productivity import normalize_search_criteria
    query = str(query or '')[:1000].strip()
    expanded = expand_natural_query(query)
    explicit = re.search(r'(?<!\S)(?:from|to|subject|filename|after|before|in|state|category|has|is):', query, re.I)
    # Ordinary prose, apostrophes and punctuation keep their keyword meaning.
    if expanded == query and not explicit and not re.search(r'(?:^|\s)["\']', query):
        criteria = {'query':query,'text':query,'terms':query.split()[:12]}
    else:
        criteria = normalize_search_criteria({'query':query})
    tokens = []
    names = {'sender':'from','recipient':'to','subject':'subject','filename':'filename',
             'after':'after','before':'before','mailbox':'in','state':'state','category':'category'}
    for field, operator in names.items():
        if criteria.get(field):
            tokens.append({'field':field,'value':criteria[field], 'canonical':operator+':'+shlex.quote(str(criteria[field]))})
    for field, canonical in [('has_attachment','has:attachment'),('unread','is:unread')]:
        if criteria.get(field):
            tokens.append({'field':field,'value':True,'canonical':canonical})
    structured = bool(tokens)
    if criteria.get('terms'):
        tokens.append({'field':'text','value':criteria['text'],'canonical':' '.join(shlex.quote(term) for term in criteria['terms'])})
    display_fields = {'sender':'发件人是','recipient':'收件人是','subject':'主题包含','filename':'附件名包含',
                      'after':'开始日期是','before':'结束日期是','mailbox':'邮件范围是','state':'处理状态是','category':'分类是'}
    for token in tokens:
        field, value = token['field'], token['value']
        if field in display_fields:
            operator = names[field]
            value = _VALUE_NAMES.get(operator,{}).get(value,value)
            text = str(value)
            if (re.search(r'''[\s，；;,:"'\\]''', text)
                    or (field in {'sender', 'recipient'} and text.endswith('的邮件'))):
                text = json.dumps(text,ensure_ascii=False)
            token['display'] = display_fields[field] + text
        elif field == 'text':
            token['display'] = ' '.join(json.dumps(term,ensure_ascii=False) for term in criteria['terms'])
        else:
            token['display'] = '有附件' if field == 'has_attachment' else '未读'
    return {'criteria':criteria,'tokens':tokens,'structured':structured,
            'canonical':' '.join(token['canonical'] for token in tokens),
            'display_query':' '.join(token['display'] for token in tokens)}
