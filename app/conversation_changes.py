"""Conservative date and amount change cues; quotes are evidence, never task mutations."""
import re
from html.parser import HTMLParser
from decimal import Decimal, localcontext

DATE = r'(?:20\d{2}年\d{1,2}月\d{1,2}[日号]|20\d{2}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}月\d{1,2}[日号]|(?:本|下|这)?(?:周|星期)[一二三四五六日天]|今天|明天|后天)'
CHANGE = re.compile(r'(?:从|由|原定(?:于)?|原计划(?:于)?)\s*(' + DATE + r')[^。！？!?\n]{0,16}?(?:调整为|调整到|改为|改到|推迟至|延期至|提前至|延至)\s*(' + DATE + r')')
SINGLE = re.compile(r'(?:调整为|调整到|改为|改到|推迟至|延期至|提前至|延至)\s*(' + DATE + r')')
TOPIC = re.compile(r'交付|交期|交货|截止|提交|验收|上线|发货')
UNCERTAIN = re.compile(r'能否|是否|可否|建议|拟|考虑|希望|计划|预计|暂定|如果|假如|待确认|请确认|[？?]')
NEGATED = re.compile(r'不(?:能|会|要|再|应|予|同意)?[^，,。；;]{0,8}(?:调整|改为|改到|推迟|延期|提前)|取消(?:调整|变更|延期)|无需(?:调整|变更)|未(?:确认|同意)|尚未')
CONFIRMED = re.compile(r'已确认|确认将|同意将|双方确认|双方同意|现确定')


NUMBER = r'(?:[0-9]{1,3}(?:,[0-9]{3}){1,5}|[0-9]{1,18})(?:\.[0-9]{1,4})?'
AMOUNT = r'(?:人民币|美元|港币|欧元|CNY|USD|HKD|EUR)?\s*' + NUMBER + r'\s*(?:万)?(?:元|美元|港元|欧元)?'
MONEY_CHANGE = re.compile(r'(?:从|由)\s*(' + AMOUNT + r')\s*(调整为|调整到|改为|改到)\s*(' + AMOUNT + r')(?![\d.,万亿千百元美港欧A-Za-z])', re.I)
MONEY_TOPIC = re.compile(r'报价|总价|单价|费用|金额|预算')


def money_change(sentence):
    if not MONEY_TOPIC.search(sentence):
        return None
    matches = list(MONEY_CHANGE.finditer(sentence))
    if len(matches) != 1:
        return None
    match = matches[0]
    before, after = match.group(1).strip(), match.group(3).strip()
    def parse(value):
        currencies = set()
        for pattern, currency in [(r'美元|USD', 'USD'), (r'港币|港元|HKD', 'HKD'), (r'欧元|EUR', 'EUR'), (r'人民币|CNY', 'CNY')]:
            if re.search(pattern, value, re.I):
                currencies.add(currency)
        if not currencies and '元' in value:
            currencies.add('CNY')
        number = re.search(NUMBER, value)
        amount = Decimal(number.group().replace(',', '')) * (10000 if '万' in value else 1)
        return amount, next(iter(currencies)) if len(currencies) == 1 else ''
    old, old_currency = parse(before)
    new, new_currency = parse(after)
    if before == after:
        return None
    # Only explicit total amounts with the same currency and tax basis are comparable.
    total = bool(re.search(r'总价|总金额|总费用|预算总额', sentence))
    # A shared tax phrase must never override units, shipping, discounts or approximations.
    basis_text = re.sub(r'均(?:不含税|含税|未税)', '', sentence)
    ambiguous = bool(re.search(r'单价|每|/|税|折扣|折后|优惠|不含|含运|运费|约|左右|起|另计|另加|分别|区间|至', basis_text))
    comparable = total and old_currency and old_currency == new_currency and not ambiguous
    result = dict(kind='amount', before=before, after=after,
                  comparison='币种或计价口径未明确一致，请核对原文。')
    if comparable:
        with localcontext() as context:
            context.prec = 40
            delta = new - old
        result['comparison'] = ('增加 ' if delta > 0 else '减少 ' if delta < 0 else '差额 ') + format(abs(delta), 'f') + ' ' + old_currency + '（按原文金额计算）'
    return result


class _OwnHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.depth = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in ('blockquote', 'script', 'style') or any(x in attrs.get('class', '').lower() for x in ('gmail_quote', 'yahoo_quoted')):
            self.depth += 1
        elif self.depth and tag not in ('br', 'img', 'hr', 'input', 'meta', 'link'):
            self.depth += 1
        if not self.depth and tag in ('p', 'div', 'br', 'li', 'tr'):
            self.parts.append('\n')

    def handle_endtag(self, tag):
        if self.depth:
            self.depth -= 1
        elif tag in ('p', 'div', 'li', 'tr'):
            self.parts.append('\n')

    def handle_data(self, data):
        if not self.depth:
            self.parts.append(data)


def own_text(row, sent=False):
    if sent or not row.get('body_text'):
        parser = _OwnHTML()
        parser.feed((row.get('body_html') or '')[:12000])
        text = ''.join(parser.parts)
    else:
        text = str(row.get('body_text') or '')[:6000]
    lines = []
    for line in text.splitlines():
        if re.match(r'\s*(>|On .+wrote:|在.+写道|[-_]{3,}\s*(Original Message|原始邮件|转发邮件)|(?:From|发件人)\s*[:：])', line, re.I):
            break
        lines.append(line)
    return '\n'.join(lines)


def detect(timeline, records):
    changes = []
    for item in timeline:
        row = records.get((item['source'], item['id']), {})
        for sentence in re.split(r'(?<=[。！？!?；;])|\n', own_text(row, item['source'] == 'sent')):
            sentence = sentence.strip()
            if not sentence or len(sentence) > 360 or NEGATED.search(sentence):
                continue
            amount = money_change(sentence)
            if not TOPIC.search(sentence) and not amount:
                continue
            match = CHANGE.search(sentence)
            candidates = list(SINGLE.finditer(sentence))
            if len(candidates) > 1:
                continue  # Multiple arrangements in one sentence need manual disambiguation.
            single = candidates[0] if candidates else None
            if not amount and not match and not single:
                continue
            old, new = (amount['before'], amount['after']) if amount else match.groups() if match else ('', single.group(1))
            if old == new:
                continue
            # Preserve the exact date wording; relative dates are not converted into guessed calendar dates.
            level = 'proposal' if UNCERTAIN.search(sentence) else 'stated' if CONFIRMED.search(sentence) else 'unverified'
            changes.append(dict(**(amount or dict(kind='date', before=old, after=new)), quote=sentence,
                state=level, label={'proposal':'提出调整，待确认','stated':'原文表示已确认','unverified':'发现调整表述，待核实'}[level],
                source=item['source'], id=item['id'], sender=item['sender'], date=item['date'], risky=item['risky'], current=item['current']))
            if len(changes) >= 8:
                return dict(items=changes, limited=True)
    return dict(items=changes, limited=False)
