"""Non-secret UI preferences, independent of a WebView's changing HTTP port."""
import re
import sqlite3
from contextlib import closing
from .paths import USER_DIR

PREFERENCE_PATH = USER_DIR / "ui-preferences.sqlite3"
KEYS = {
    "mailai.preferences.theme.v1", "mailai.preferences.showServerFolders.v1",
    "mailai.attachments.view.v1",
    "mailai-language", "mailai-density", "mailai-font-scale",
    "mailai-companion-motion", "mailai-assistant-floating",
    "mailai-assistant-layout-v1", "mailai.workspace.paneSizes.v1",
    "mailai-browsing-account", "mailai.onboarding.v2",
}


def allowed(key):
    return isinstance(key, str) and len(key) <= 240 and (
        key in KEYS or re.fullmatch(r"(?:alias:|collapsed:|mailai-secretary-focus:)[\w.-]*", key)
    )


def connection():
    PREFERENCE_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(PREFERENCE_PATH, timeout=5)
    conn.execute("CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT)")
    return conn


def load():
    with closing(connection()) as conn:
        return dict(conn.execute("SELECT key,value FROM preferences"))


def save(key, value):
    if not allowed(key) or (value is not None and (not isinstance(value, str) or len(value) > 16384)):
        raise ValueError("不支持的界面偏好设置")
    with closing(connection()) as conn, conn:
        if conn.execute("SELECT count(*) FROM preferences").fetchone()[0] >= 512 and not conn.execute(
            "SELECT 1 FROM preferences WHERE key=?", (key,)
        ).fetchone():
            raise ValueError("界面偏好数量超出限制")
        # Null tombstones prevent an old origin's cache resurrecting a reset.
        conn.execute("INSERT OR REPLACE INTO preferences VALUES (?,?)", (key, value))
