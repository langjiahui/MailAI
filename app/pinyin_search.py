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


def body_aliases(value: str) -> str:
    """Index Chinese runs in mail bodies without caching entire message bodies."""
    text = str(value or '')
    runs = re.findall(r'[\u3400-\u9fff]{2,}', text)
    parts = []
    for run in runs:
        syllables = lazy_pinyin(run, style=Style.NORMAL)
        initials = lazy_pinyin(run, style=Style.FIRST_LETTER)
        parts.extend((''.join(syllables), ''.join(initials)))
    return ' '.join(parts)


def body_match_span(value: str, terms: list[str]) -> tuple[int, int] | None:
    """Find the Chinese phrase behind a pinyin match for list previews."""
    text = str(value or '')
    for match in re.finditer(r'[\u3400-\u9fff]{2,}', text):
        run = match.group()
        for style in (Style.NORMAL, Style.FIRST_LETTER):
            syllables = lazy_pinyin(run, style=style)
            compact = ''.join(syllables).lower()
            for term in terms:
                offset = compact.find(term)
                if offset >= 0:
                    consumed = 0
                    start = None
                    for index, syllable in enumerate(syllables):
                        if start is None and consumed + len(syllable) > offset:
                            start = index
                        consumed += len(syllable)
                        if consumed >= offset + len(term):
                            return match.start() + (start or 0), match.start() + index + 1
    return None


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
