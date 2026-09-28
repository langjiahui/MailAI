"""Deterministic chat wording. Only command targets are normalized, never reply text."""
import re

_NUM = r'[0-9０-９一二两三四五六七八九十零〇]+'
_DIGITS = dict(zip('零〇一二两三四五六七八九', (0, 0, 1, 2, 2, 3, 4, 5, 6, 7, 8, 9)))


def ordinal(value):
    value = value.translate(str.maketrans('０１２３４５６７８９', '0123456789'))
    if value.isascii() and value.isdigit():
        return str(int(value)) if len(value) <= 3 else '0'
    if value in _DIGITS:
        return str(_DIGITS[value])
    match = re.fullmatch(r'([一二两三四五六七八九]?)十([一二三四五六七八九]?)', value)
    if match:
        return str(_DIGITS.get(match[1], 1) * 10 + _DIGITS.get(match[2], 0))
    return '0'  # Malformed ordinals must fail explicitly rather than select another mail.


def canonicalize(text):
    """Return a known command, or None. Colons delimit verbatim user-authored text."""
    from .remote_time import recognized
    time_text = re.sub(r'^(?:请|帮我|麻烦)(?:你)?\s*', '', text).strip()
    if recognized(time_text):
        return time_text if time_text.startswith('时间邮件 ') else '时间邮件 ' + time_text
    prefix, separator, body = re.split(r'([：:])', text, maxsplit=1) if re.search(r'[：:]', text) else (text, '', '')
    prefix = prefix.strip()
    # Account addresses and confirmation codes are intentionally never rewritten.
    if re.match(r'^(确认发送|切换(?:到)?邮箱|连接(?:到)?邮箱)', prefix):
        return text
    head = re.sub(r'^(?:请|帮我|麻烦)(?:你)?\s*', '', prefix)
    if not separator:
        head = head.rstrip('。！？!?').strip()
        help_topic = re.fullmatch(r'(?:帮助|help|怎么用)\s+(邮件|待办|回复|附件|设置|更多)', head, re.I)
        if help_topic:
            return '帮助 ' + help_topic[1]
    aliases = {'帮助': '帮助', 'help': '帮助', '开始': '帮助', '怎么用': '帮助', '有什么指令': '帮助',
               '邮箱列表': '邮箱列表', '查看邮箱': '邮箱列表', '连接邮箱': '邮箱列表',
               '收一下邮件': '查收邮件', '收邮件': '查收邮件', '查收邮件': '查收邮件', '收取最新邮件': '查收邮件',
               '同步邮件': '查收邮件', '刷新邮件': '查收邮件', '看看最新邮件': '最新邮件', '查看最新邮件': '最新邮件',
               '最新邮件': '最新邮件', '未读邮件': '未读邮件', '看看未读邮件': '未读邮件',
               '有什么新邮件': '新邮件', '有新邮件吗': '新邮件', '新邮件': '新邮件',
               '看看新邮件': '新邮件', '上次之后有什么新邮件': '新邮件', '更多新邮件': '更多新邮件',
               '今天有什么重要的': '今日简报', '今日简报': '今日简报', '今天简报': '今日简报',
               '今天重要邮件': '今日简报', '看看今日简报': '今日简报',
               '梳理重要邮件': '重要邮件', '总结最近的重要邮件': '重要邮件', '重要邮件': '重要邮件',
               '看看重要邮件': '重要邮件', '总结重要邮件': '重要邮件',
               '看看今天待办': '今天待办', '今天待办': '今天待办', '今日待办': '今天待办',
               '今天有什么要处理': '今天待办', '今天有什么要处理？': '今天待办',
               '下一项': '下一项', '下一项待办': '下一项', '上一项': '上一项', '上一项待办': '上一项',
               '返回待办': '返回待办', '返回待办列表': '返回待办',
               '查看原邮件': '查看当前邮件', '当前待办': '查看当前待办', '查看当前待办': '查看当前待办',
               '状态': '状态', '上下文': '状态', '当前状态': '状态',
               '下一封': '下一封', '下一封邮件': '下一封', '上一封': '上一封', '上一封邮件': '上一封', '前一封': '上一封',
               '返回列表': '返回列表', '返回邮件列表': '返回列表', '继续': '继续', '继续刚才': '继续',
               '当前邮件': '查看当前邮件', '查看这封': '查看当前邮件', '查看当前邮件': '查看当前邮件',
               '预览回复': '回复预览', '查看回复': '回复预览', '回复预览': '回复预览',
               '发送': '确认发送', '发出去': '确认发送', '确认': '确认发送',
               '取消': '取消回复', '取消回复': '取消回复', '取消发送': '取消回复'}
    if re.match(r'^(切换(?:到)?邮箱|连接(?:到)?邮箱)\s+', head):
        return head + (separator + body if separator else '')
    if not separator and head in aliases:
        return aliases[head]
    if separator and head in ('修改回复', '修改正文'):
        return '修改回复：' + body
    if not separator and head.startswith('回复'):
        inline = re.fullmatch(r'回复(?:第)?\s*(' + _NUM + r')\s*封(?:邮件)?[，,、。\s]+(.+)', head, re.S)
        if inline:
            return '回复第 ' + ordinal(inline[1]) + ' 封：' + inline[2].strip()
        inline = re.fullmatch(r'回复(?:这封(?:邮件)?|当前邮件)[，,、。\s]+(.+)', head, re.S)
        if inline:
            return '回复：' + inline[1].strip()
        inline = head[2:].strip()
        if (inline and not re.match(r'^(?:第)?\s*' + _NUM + r'\s*封', inline)
                and not re.match(r'^(?:这封|当前邮件|全部|所有人|预览|列表)', inline)):
            return '回复：' + inline
    if not separator:
        if re.fullmatch(r'(?:附件列表|查看附件|看看附件|这封的附件|查看这封的附件)', head):
            return '附件列表'
        atts = re.fullmatch(r'(?:查看|看看|列出)(?:第)?\s*(' + _NUM + r')\s*封(?:邮件)?(?:的)?附件', head)
        if atts:
            return '附件列表第 ' + ordinal(atts[1]) + ' 封'
        if re.fullmatch(r'附件列表第\s*\d+\s*封', head):
            return head
        media = re.fullmatch(r'(发送|预览)附件第\s*(' + _NUM + r')\s*个', head)
        if not media:
            media = re.fullmatch(r'(把|发送|发|下载|预览|看看)(?:第)?\s*(' + _NUM + r')\s*个附件(?:发给我|发送给我|给我)?', head)
        if media:
            action = '预览' if media[1] in ('预览', '看看') else '发送'
            return action + '附件第 ' + ordinal(media[2]) + ' 个'
    if not separator and re.fullmatch(r'查看待办(?:原邮件)?第\s*\d+\s*项', head):
        return head
    todo = re.fullmatch(r'(?:查看|打开|看看|看)(?:第)?\s*(' + _NUM + r')\s*项(?:待办|任务|原邮件)?', head)
    if not separator and todo:
        action = '查看待办原邮件' if head.endswith('原邮件') else '查看待办'
        return action + '第 ' + ordinal(todo[1]) + ' 项'
    match = re.fullmatch(r'(查看|打开|看一下|看看|看|总结|概括|起草回复|回复)\s*(.*)', head)
    if match:
        action, target = match.groups()
        action = {'打开': '查看', '看一下': '查看', '看看': '查看', '看': '查看', '概括': '总结'}.get(action, action)
        if action in ('查看', '总结'):
            target = re.sub(r'(?:的)?(?:正文|内容)$', '', target).strip()
        number = re.fullmatch(r'(?:第)?\s*(' + _NUM + r')\s*封(?:邮件|来信)?', target)
        current = target in ('', '这封', '这封邮件', '当前邮件', '当前这封', '它')
        if number or current:
            if action == '查看':
                if separator:
                    return None
                return '查看第 ' + ordinal(number[1]) + ' 封' if number else '查看当前邮件'
            if action == '回复' and separator and not body.strip():
                separator = ''
            suffix = '第 ' + ordinal(number[1]) + ' 封' if number else ''
            return action + suffix + ('：' + body if separator else '')
    if not separator:
        number = re.fullmatch(r'(?:第)?\s*(' + _NUM + r')\s*封(?:邮件|来信)?', head)
        if number:
            return '查看第 ' + ordinal(number[1]) + ' 封'
    return None
