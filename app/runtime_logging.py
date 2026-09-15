"""Crash-resilient logging for windowed desktop builds."""
from __future__ import annotations

import faulthandler
import logging
from logging.handlers import RotatingFileHandler
import os
import platform
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path

from .paths import USER_DIR


_FAULT_STREAM = None
_SESSION_MARKER: Path | None = None
_CONFIGURED = False


def runtime_log_dir() -> Path:
    """Return a user-writable log directory without touching application data."""
    configured = os.getenv("MAILAI_LOG_DIR", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    if os.getenv("MAILAI_HOME", "").strip():
        return USER_DIR / "logs"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Logs" / "MailAI"
    if sys.platform == "win32":
        base = Path(os.getenv("LOCALAPPDATA") or USER_DIR)
        return base / "MailAI" / "logs"
    return USER_DIR / "logs"


def configure_runtime_logging() -> Path:
    """Persist Python exceptions and fatal interpreter faults for GUI builds."""
    global _CONFIGURED, _FAULT_STREAM, _SESSION_MARKER
    log_dir = runtime_log_dir()
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "mailai.log"
    if _CONFIGURED:
        return log_path

    formatter = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(threadName)s %(name)s: %(message)s"
    )
    file_handler = RotatingFileHandler(
        log_path, maxBytes=5 * 1024 * 1024, backupCount=4,
        encoding="utf-8", delay=True,
    )
    file_handler.setFormatter(formatter)
    handlers: list[logging.Handler] = [file_handler]
    if sys.stdout is not None:
        stream_handler = logging.StreamHandler(sys.stdout)
        stream_handler.setFormatter(formatter)
        handlers.append(stream_handler)

    root = logging.getLogger()
    root.setLevel(logging.INFO)
    for handler in list(root.handlers):
        root.removeHandler(handler)
    for handler in handlers:
        root.addHandler(handler)

    fault_path = log_dir / "fatal.log"
    try:
        _FAULT_STREAM = fault_path.open("a", encoding="utf-8", buffering=1)
        faulthandler.enable(_FAULT_STREAM, all_threads=True)
    except (OSError, RuntimeError):
        logging.getLogger(__name__).exception("无法启用原生故障日志")

    previous_sys_hook = sys.excepthook

    def report_unhandled(exc_type, exc_value, exc_traceback):
        logging.getLogger("mailai.crash").critical(
            "未捕获的主线程异常", exc_info=(exc_type, exc_value, exc_traceback)
        )
        if previous_sys_hook is not sys.__excepthook__:
            previous_sys_hook(exc_type, exc_value, exc_traceback)

    def report_thread(args):
        logging.getLogger("mailai.crash").critical(
            "未捕获的后台线程异常: %s", args.thread.name if args.thread else "unknown",
            exc_info=(args.exc_type, args.exc_value, args.exc_traceback),
        )

    sys.excepthook = report_unhandled
    threading.excepthook = report_thread

    _SESSION_MARKER = log_dir / "running.json"
    if _SESSION_MARKER.exists():
        try:
            previous = _SESSION_MARKER.read_text(encoding="utf-8").strip()
        except OSError:
            previous = "无法读取"
        logging.getLogger("mailai.crash").warning(
            "检测到上次运行未正常结束: %s", previous
        )
    try:
        _SESSION_MARKER.write_text(
            '{"pid": %d, "started_at": "%s", "python": "%s", "platform": "%s"}'
            % (
                os.getpid(), datetime.now(timezone.utc).isoformat(),
                platform.python_version(), platform.platform(),
            ),
            encoding="utf-8",
        )
    except OSError:
        logging.getLogger(__name__).exception("无法写入运行状态标记")

    _CONFIGURED = True
    logging.getLogger(__name__).info(
        "运行日志已启用: %s (Python %s)", log_path, platform.python_version()
    )
    return log_path


def mark_clean_shutdown() -> None:
    """Remove the running marker only after an orderly application shutdown."""
    if _SESSION_MARKER is not None:
        try:
            _SESSION_MARKER.unlink(missing_ok=True)
        except OSError:
            logging.getLogger(__name__).exception("无法清理运行状态标记")
    logging.shutdown()
