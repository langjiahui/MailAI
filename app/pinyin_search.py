"""Local Chinese pinyin aliases used by mail and contact search."""
import re
from functools import lru_cache

from pypinyin import Style, lazy_pinyin


@lru_cache(maxsize=8192)
def aliases(value: str) -> str:
    """Return spaced/full pinyin and initials without sending text off-device."""
    text = str(value or '').strip()
    if not text or not re.search(r'[\u3400-\u9fff]', text):
        return ''
    syllables = lazy_pinyin(text, style=Style.NORMAL, errors='ignore')
    initials = lazy_pinyin(text, style=Style.FIRST_LETTER, errors='ignore')
    if not syllables:
        return ''
    return ' '.join(syllables) + ' ' + ''.join(syllables) + ' ' + ''.join(initials)


def matches(query: str, *values: object) -> bool:
    """Match original text, full pinyin (spaced or compact), or initials."""
    needle = str(query or '').strip().casefold()
    if not needle:
        return True
    compact = re.sub(r'\s+', '', needle)
    for value in values:
        text = str(value or '').casefold()
        alias = aliases(text)
        if needle in text or needle in alias or (compact and compact in alias.replace(' ', '')):
            return True
    return False
