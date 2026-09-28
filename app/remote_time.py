"""Explicit local time ranges for phone mail queries; no model inference."""
import re
from datetime import datetime, timedelta

PATTERN = re.compile(r'(?:查看|看看|查一下)?\s*(今天|昨天)?\s*(凌晨|上午|中午|下午|晚上)?\s*([0-9０-９一二两三四五六七八九十零〇]+)(?:[:：]([0-9０-９]{1,2})|点(?:([0-9０-９一二两三四五六七八九十零〇]+)分?|半)?)(?:钟)?\s*(?:之后|以后|后)(?:的)?\s*(?:邮件|新邮件|收到什么|收到哪些邮件|有什么邮件)')


def recognized(text):
    return text.startswith('时间邮件 ') or bool(PATTERN.fullmatch(text.rstrip('。！？!?').strip()))


def parse(text, now=None):
    from .remote_commands import ordinal
    now = now or datetime.now()
    text = text.removeprefix('时间邮件 ').rstrip('。！？!?').strip()
    match = PATTERN.fullmatch(text)
    if not match:
        raise ValueError('请用明确时间，例如“今天下午两点之后的邮件”或“昨天09:30之后的邮件”。')
    day, period, hour, minute, chinese_minute = match.groups()
    def number(value):
        result = int(ordinal(value))
        if result == 0 and value not in ('0', '00', '０', '００', '零', '〇'):
            raise ValueError('时间数字无法识别，请用“14:30”这样的明确时间。')
        return result
    hour = number(hour)
    minute = number(minute or chinese_minute) if minute or chinese_minute else (30 if '半' in match[0] else 0)
    if period:
        if not 1 <= hour <= 12:
            raise ValueError('上午、下午请使用 1 到 12 点，例如“下午两点”；24 小时制请直接说“14:00”。')
        if period == '晚上' and hour == 12:
            raise ValueError('请明确午夜的日期，例如“今天00:00之后的邮件”或“昨天00:00之后的邮件”。')
        if period in ('下午', '晚上'):
            hour = hour % 12 + 12
        elif period == '凌晨':
            hour %= 12
        elif period == '中午' and hour != 12:
            raise ValueError('请明确中午时间，例如“中午十二点”或“13:00”。')
    if hour > 23 or minute > 59:
        raise ValueError('时间无效，请使用 00:00 到 23:59。')
    start = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if day == '昨天':
        start -= timedelta(days=1)
    if start > now:
        raise ValueError('这个时间还没到，请指定已经过去的时间。')
    return start, now
