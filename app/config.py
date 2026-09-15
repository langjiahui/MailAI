"""全局配置，从 .env 加载。"""
import json
import os
import sys
import types

from dotenv import load_dotenv
from .paths import APP_DIR, CONFIG_PATH, DATA_DIR as USER_DATA_DIR, FROZEN, ensure_dirs
from .account_context import current as _account_context


class _AccountConfiguration(types.ModuleType):
    def __getattribute__(self, name):
        scoped = _account_context.get()
        if scoped is not None and name in scoped:
            return scoped[name]
        return super().__getattribute__(name)


sys.modules[__name__].__class__ = _AccountConfiguration

ensure_dirs()
_PROCESS_ENV = dict(os.environ)
# 安装包先加载通用默认配置，再加载用户本地邮箱配置。
if FROZEN:
    load_dotenv(APP_DIR / "mailai.defaults.env", override=False)
load_dotenv(CONFIG_PATH, override=True)
# Command-line/service environment is the highest-priority configuration.
# This makes port overrides and isolated MAILAI_HOME instances dependable.
os.environ.update(_PROCESS_ENV)


def _b(key: str, default: bool = False) -> bool:
    return os.getenv(key, str(default)).strip().lower() in ("1", "true", "yes", "on")


def _i(key: str, default: int) -> int:
    try:
        return int(os.getenv(key, default))
    except (TypeError, ValueError):
        return default


# ===== IMAP =====
IMAP_HOST = os.getenv("IMAP_HOST", "")
IMAP_PORT = _i("IMAP_PORT", 993)
IMAP_USER = os.getenv("IMAP_USER", "")
IMAP_PASSWORD = os.getenv("IMAP_PASSWORD", "")
IMAP_SSL = _b("IMAP_SSL", True)
IMAP_VERIFY_SSL = _b("IMAP_VERIFY_SSL", True)
INBOX_FOLDER = os.getenv("INBOX_FOLDER", "INBOX")
QUARANTINE_FOLDER = os.getenv("QUARANTINE_FOLDER", "隔离区")
SPAM_FOLDER = os.getenv("SPAM_FOLDER", "垃圾邮件")

# ===== SMTP（可与收件账号分离，便于测试） =====
SMTP_HOST = os.getenv("SMTP_HOST", "")
SMTP_PORT = _i("SMTP_PORT", 465)
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
SMTP_USE_IMAP_CREDENTIALS = _b("SMTP_USE_IMAP_CREDENTIALS", False)
SMTP_SSL = _b("SMTP_SSL", True)
SMTP_STARTTLS = _b("SMTP_STARTTLS", False)
SMTP_VERIFY_SSL = _b("SMTP_VERIFY_SSL", True)
SMTP_SENT_IMAP_HOST = os.getenv("SMTP_SENT_IMAP_HOST", "")
SMTP_SENT_FOLDER = os.getenv("SMTP_SENT_FOLDER", "")
SMTP_MAX_RECIPIENTS = _i("SMTP_MAX_RECIPIENTS", 100)

COMPANY_DOMAIN = os.getenv("COMPANY_DOMAIN", "").lower()
BUILTIN_TRUSTED_DOMAINS = set()
TRUSTED_DOMAINS = sorted(BUILTIN_TRUSTED_DOMAINS | {
    d.strip().lower()
    for d in os.getenv("TRUSTED_DOMAINS", "").split(",")
    if d.strip()
})
TRUSTED_SENDERS = {
    addr.strip().lower()
    for addr in os.getenv("TRUSTED_SENDERS", "").split(",")
    if addr.strip()
}

# ===== 拉取策略 =====
# Guard against accidental 0/very-small intervals causing a tight background loop.
POLL_INTERVAL_SECONDS = max(30, _i("POLL_INTERVAL_SECONDS", 300))
INITIAL_FETCH_LIMIT = _i("INITIAL_FETCH_LIMIT", 20)
# Historical mail is imported newest-first. Only a bounded recent window gets
# productivity AI enrichment; local security rules still inspect every message.
HISTORY_AI_DAYS = max(0, _i("HISTORY_AI_DAYS", 30))
HISTORY_AI_LIMIT = max(0, _i("HISTORY_AI_LIMIT", 200))
HISTORY_DEEP_SCAN_LIMIT = max(0, _i("HISTORY_DEEP_SCAN_LIMIT", 500))

# ===== LLM =====
LLM_PROVIDER = os.getenv("LLM_PROVIDER", "custom")
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "https://api.deepseek.com")
LLM_API_KEY = os.getenv("LLM_API_KEY", "")
LLM_MODEL = os.getenv("LLM_MODEL", "deepseek-chat")
LLM_TIMEOUT = _i("LLM_TIMEOUT", 60)
LLM_DIGEST_TIMEOUT = _i("LLM_DIGEST_TIMEOUT", 45)
LLM_DIGEST_MAX_TOKENS = _i("LLM_DIGEST_MAX_TOKENS", 1400)
LLM_VERIFY_SSL = _b("LLM_VERIFY_SSL", True)
LLM_ANALYZE_ALL = _b("LLM_ANALYZE_ALL", False)
LLM_MAX_BODY_CHARS = _i("LLM_MAX_BODY_CHARS", 6000)
REDACT_BEFORE_LLM = _b("REDACT_BEFORE_LLM", False)

# ===== 图片/二维码多模态复核 =====
MULTIMODAL_ENABLED = _b("MULTIMODAL_ENABLED", True)
MULTIMODAL_MODEL = os.getenv("MULTIMODAL_MODEL", "").strip() or LLM_MODEL
MULTIMODAL_MAX_IMAGES = _i("MULTIMODAL_MAX_IMAGES", 2)
MULTIMODAL_MAX_IMAGE_BYTES = _i("MULTIMODAL_MAX_IMAGE_BYTES", 2 * 1024 * 1024)

# ===== 应用更新 =====
UPDATE_MANIFEST_URL = os.getenv(
    "MAILAI_UPDATE_MANIFEST_URL",
    "https://github.com/langjiahui/MailAI/releases/latest/download/latest.json",
)

# ===== 自动处置策略 =====
# observe: 仅记录建议；review: 高风险进入待人工确认；auto: 满足条件时自动移动
ACTION_MODE = os.getenv("ACTION_MODE", "auto").strip().lower()
if ACTION_MODE not in ("observe", "review", "auto"):
    ACTION_MODE = "observe"
AUTO_ACTION_MAX_PER_RUN = _i("AUTO_ACTION_MAX_PER_RUN", 10)

try:
    LLM_EXTRA_PARAMS = json.loads(os.getenv("LLM_EXTRA_PARAMS", "{}")) if os.getenv("LLM_EXTRA_PARAMS") else {}
except json.JSONDecodeError:
    LLM_EXTRA_PARAMS = {}

# ===== 安全阈值 =====
QUARANTINE_SCORE = _i("QUARANTINE_SCORE", 70)
LLM_REVIEW_SCORE = _i("LLM_REVIEW_SCORE", 35)

# ===== Web =====
WEB_HOST = os.getenv("WEB_HOST", "127.0.0.1")
WEB_PORT = _i("WEB_PORT", 8787)
AUTO_OPEN_BROWSER = _b("AUTO_OPEN_BROWSER", True)

# ===== 路径 =====
BASE_DIR = str(APP_DIR)
CONFIG_PATH = str(CONFIG_PATH)
DATA_DIR = str(USER_DATA_DIR)
DB_PATH = os.path.join(DATA_DIR, "mailai.db")
RAW_DIR = os.path.join(DATA_DIR, "raw")
URL_BLOCKLIST = os.path.join(DATA_DIR, "url_blocklist.txt")
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(RAW_DIR, exist_ok=True)
