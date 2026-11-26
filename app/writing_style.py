"""Extract reusable writing signals locally from bounded, authored text."""

from email.utils import getaddresses
import re
import unicodedata

from .conversation_changes import DATE, own_text

MAX_BODY = 3000
LANGUAGES = ('zh', 'en')
VALUES = {
    'language': LANGUAGES,
    'length': ('short', 'medium', 'long'),
    'opening': ('conclusion',),
    'subject': ('action',),
    'tone': ('formal', 'friendly'),
    'structure': ('list',),
}
FIELDS = (*VALUES, 'salutation')
_GREETING = re.compile(
    r'^(?:各位好|大家好|您好|你好|(?:hi|hello|dear)\s+[\w .’\'-]{1,28}|'
    r'[\u3400-\u9fff]{1,8}(?:您好|你好|老师|经理|主任|总|工|先生|女士)(?:您好|你好)?)\s*[,，:：!！]?$', re.I)
_SIGNOFF = re.compile(r'^(?:--\s*|此致(?:敬礼)?|顺颂商祺|敬礼|best regards|kind regards|regards|sincerely)[,，!！。\s]*$'
                      r'|^(?:sent from my |发自我的|来自我的|获取 Outlook)', re.I)
_CONCLUSION = re.compile(r'^(?:结论[：:]|经确认[，,：:]|已(?:确认|完成|同意)|可以[。！,.，]|'
                         r'[^，。；\n]{1,18}已(?:确认|完成|通过)|confirmed[.!,:]|approved[.!,:]|'
                         r'(?:the |our )?[\w -]{1,35} (?:is|has been) (?:confirmed|approved|complete)\b)', re.I)
_ACTION = re.compile(r'^(?:请|待确认|需确认|行动项|action required\b|please\b|request for\b)', re.I)
_LIST = re.compile(r'^\s*(?:[-•●]|\d+[.、)]|[一二三四五六七八九十]+、)\s*\S', re.M)
_FORWARD = re.compile(r'^\s*(?:fwd?|转发|转寄)\s*[:：]', re.I)
_FACTS = re.compile(DATE + r'|(?:mon|tues|wednes|thurs|fri|satur|sun)day\b|\d[\d.,:/-]*', re.I)
_IDENTIFIERS = re.compile(r'(?:\bhttps?://|\bwww\.)\S+|[^\s<>]+@[^\s<>]+', re.I)


def addresses(value):
    try:
        return sorted({addr.casefold() for _, addr in getaddresses([str(value or '')]) if '@' in addr})
    except ValueError:
        return []


def audience(row):
    seen, groups = set(), []
    for field in ('to_addr', 'cc_addr', 'bcc_addr'):
        group = set(addresses(row.get(field)))
        groups.append(sorted(group - seen))
        seen.update(group)
    return groups


def scene_for(row):
    if row.get('mode') == 'forward' or _FORWARD.search(row.get('subject') or ''):
        return ''
    return 'reply' if row.get('mode') in ('reply', 'reply_all') or row.get('reply_to_email_id') or row.get('in_reply_to') else 'compose'


def clean_text(text):
    text = unicodedata.normalize('NFKC', text).replace('\u200b', '').replace('\u00ad', '')
    lines = []
    for line in text.splitlines():
        line = re.sub(r'[^\S\n]+', ' ', line).strip()
        if _SIGNOFF.search(line) or re.match(r'^(?:>|-----\s*(?:原始邮件|转发邮件|Forwarded message)|On .+wrote:|在.+写道)', line, re.I):
            break
        if line:
            lines.append(line)
    return '\n'.join(lines)


def authored_text(row):
    # Use preserved HTML when it has recognizable quote/signature boundaries.
    return clean_text(own_text(row, bool(row.get('body_html')), exclude_signatures=True))


def language(text):
    han = len(re.findall(r'[\u3400-\u9fff]', text))
    latin = len(re.findall(r'\b[a-zA-Z]{2,}\b', text))
    if han >= 8 and han >= latin * 2:
        return 'zh'
    if latin >= 5 and han <= 2:
        return 'en'
    return ''


def features(text, subject=''):
    lines = text.splitlines()
    greeting = lines[0] if len(lines) >= 2 and _GREETING.fullmatch(lines[0]) else ''
    content = '\n'.join(lines[1:] if greeting else lines)
    lang = language(content)
    if not lang:
        return {}
    size = len(re.sub(r'\s+', '', content)) if lang == 'zh' else len(content.split())
    short, long = (100, 300) if lang == 'zh' else (65, 180)
    result = {'language': lang, 'length': 'short' if size <= short else 'long' if size >= long else 'medium'}
    if greeting:
        result['salutation'] = greeting.rstrip(',，:：!！ ')
        if re.match(r'^(?:dear\b|您好|[^ ]{1,12}您好)', greeting, re.I):
            result['tone'] = 'formal'
        elif re.match(r'^hi\b|^你好$', result['salutation'], re.I):
            result['tone'] = 'friendly'
    if _CONCLUSION.search(content):
        result['opening'] = 'conclusion'
    if len(_LIST.findall(content)) >= 2:
        result['structure'] = 'list'
    if _ACTION.search(subject):
        result['subject'] = 'action'
    return result


def valid_value(field, value):
    return isinstance(value, str) and (value in VALUES.get(field, ()) or
        field == 'salutation' and len(value) <= 40 and bool(_GREETING.fullmatch(value)))


def clean_baseline(sample):
    """Optional metadata must never make the underlying draft invalid."""
    if not isinstance(sample, dict):
        return {}
    fields = {}
    for field in ('body', 'subject'):
        item = sample.get(field)
        if not isinstance(item, dict):
            continue
        value, prefix, epoch, target = (item.get(key) for key in ('value', 'prefix', 'epoch', 'audience'))
        limit = MAX_BODY if field == 'body' else 300
        if not (isinstance(value, str) and 0 < len(value) <= limit and isinstance(prefix, str)
                and len(prefix) <= limit and (field == 'body' or not prefix)
                and isinstance(epoch, str) and re.fullmatch(r'[a-f0-9]{32}', epoch)
                and isinstance(target, list) and len(target) == 3
                and all(isinstance(group, list) and len(group) <= 10 and
                        all(isinstance(addr, str) and len(addr) <= 254 for addr in group) for group in target)):
            continue
        fields[field] = dict(value=value, prefix=prefix, epoch=epoch, audience=target)
    return fields


def edited_signals(baseline, text, subject, target, epoch):
    """Attribute supported style changes only to the parts the user adopted."""
    edits = {}
    for field, item in clean_baseline(baseline).items():
        if item['epoch'] != epoch or item['audience'] != target:
            continue
        before = clean_text(item['value'])
        after = text if field == 'body' else subject
        prefix = clean_text(item['prefix'])
        if prefix:
            if not after.startswith(prefix + '\n'):
                continue
            after = after[len(prefix) + 1:]
        if not before or not after or before == after:
            continue
        # Pure data corrections are not a reason to strengthen a style rule.
        if len(after) > MAX_BODY or _same_except_facts(before, after):
            continue
        if field == 'subject':
            old = {'subject': 'action'} if _ACTION.search(before) else {}
            new = {'subject': 'action'} if _ACTION.search(after) else {}
        else:
            old, new = features(before), features(after)
        for key, value in new.items():
            if value != old.get(key):
                edits[key] = dict(value=value, before=_evidence_text(before), after=_evidence_text(after))
    return edits


def _same_except_facts(before, after):
    return _FACTS.sub('…', before) == _FACTS.sub('…', after)


def _evidence_text(text):
    return _FACTS.sub('…', _IDENTIFIERS.sub('…', text))[:180]
