"""Application-owned native copy shares the web catalogue and saved language.

Call only with declared UI text. User mail, subjects and task titles are passed
as formatting parameters and are never looked up or translated.
"""
import json
import re
import sqlite3
from functools import lru_cache

from .paths import APP_DIR


def ui_language():
    from . import ui_preferences
    try:
        return 'en' if ui_preferences.load().get('mailai-language') == 'en' else 'zh-CN'
    except (OSError, sqlite3.Error):
        return 'zh-CN'


@lru_cache(maxsize=1)
def _english_copy():
    source = (APP_DIR / 'app/web/static/i18n-catalog.js').read_text(encoding='utf-8')
    entries = json.loads(source.split('const MAILAI_UI_COPY = ', 1)[1]
                         .split(';\nconst MAILAI_I18N_CHINESE', 1)[0])
    return {pair[0]: pair[1] for pair in entries.values()}


def ui_text(source):
    return _english_copy().get(source, source) if ui_language() == 'en' else source


def ui_format(source, *values):
    return re.sub(r'\{(\d+)\}', lambda match: str(values[int(match[1])])
                  if int(match[1]) < len(values) else match[0], ui_text(source))
