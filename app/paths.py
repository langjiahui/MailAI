"""运行路径：源码模式沿用项目目录，安装包使用用户专属可写目录。"""
import os
import sys
from pathlib import Path


FROZEN = bool(getattr(sys, "frozen", False))
APP_DIR = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))


def _default_user_dir() -> Path:
    override = os.getenv("MAILAI_HOME", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    if sys.platform == "win32":
        return Path(os.getenv("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "MailAI"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "MailAI"
    return Path(os.getenv("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "MailAI"


# Explicit override is also supported in source mode for isolated tests,
# parallel instances and managed enterprise deployments.
USER_DIR = _default_user_dir() if FROZEN or os.getenv("MAILAI_HOME", "").strip() else APP_DIR
CONFIG_PATH = USER_DIR / ("config.env" if FROZEN else ".env")
DATA_DIR = USER_DIR / "data"


def ensure_dirs():
    USER_DIR.mkdir(parents=True, exist_ok=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
