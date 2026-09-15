"""入口：初始化 → 启动定时拉取 → 启动 Web 面板。"""
import multiprocessing
import os

# PyInstaller workers must dispatch before loading configuration or starting UI.
if __name__ == "__main__":
    multiprocessing.freeze_support()

import sys
import threading
import time
import webbrowser

import uvicorn
from apscheduler.schedulers.background import BackgroundScheduler

from app.runtime_logging import configure_runtime_logging, mark_clean_shutdown

if __name__ != "__mp_main__":
    configure_runtime_logging()

import logging
logging.getLogger("run").info("启动阶段：正在加载应用模块")
from app import config, db, pipeline, system_settings
from app.web.server import app as web_app

log = logging.getLogger("run")


def _poll_if_configured():
    from app.mailbox_jobs import poll_all
    result = poll_all()
    if getattr(sys, "frozen", False) and sys.platform == "darwin":
        from app.desktop import notify_poll_result
        notify_poll_result(result)
    elif getattr(sys, "frozen", False) and sys.platform == "win32":
        from app.windows_desktop import notify_poll_result
        notify_poll_result(result)
    return result


def _open_browser():
    time.sleep(1.2)
    webbrowser.open(f"http://{config.WEB_HOST}:{config.WEB_PORT}")


def _start_scheduler():
    from app.mailbox_jobs import start_outbox
    start_outbox()
    scheduler = BackgroundScheduler()
    scheduler.add_job(
        _poll_if_configured, "interval", seconds=config.POLL_INTERVAL_SECONDS,
        id="poll", max_instances=1, coalesce=True,
    )
    if config.IMAP_PASSWORD:
        scheduler.add_job(_poll_if_configured, id="poll_now")
    scheduler.start()
    log.info("定时拉取服务已启动，间隔 %s 秒", config.POLL_INTERVAL_SECONDS)
    return scheduler


def _run_app():
    log.info("启动阶段：初始化数据库")
    db.init_db()
    log.info("启动阶段：恢复账号配置")
    system_settings.initialize_current_account()

    if not config.IMAP_PASSWORD:
        log.warning("未配置 IMAP_PASSWORD，邮件拉取将不可用（请先复制 .env.example 为 .env 并填写）")
    if not config.LLM_API_KEY:
        log.warning("未配置 LLM_API_KEY，将只使用规则引擎检测，无 AI 分析")

    log.info("启动阶段：启动后台调度")
    scheduler = _start_scheduler()
    try:
        if getattr(sys, "frozen", False) and sys.platform == "darwin":
            from app.desktop import run_macos_window
            run_macos_window(web_app, config.WEB_PORT, _poll_if_configured)
            return

        if getattr(sys, "frozen", False) and sys.platform == "win32":
            from app.windows_desktop import run_windows_window
            run_windows_window(web_app, config.WEB_PORT, _poll_if_configured)
            return

        log.info("Web 面板: http://%s:%s", config.WEB_HOST, config.WEB_PORT)
        if getattr(sys, "frozen", False) and config.AUTO_OPEN_BROWSER:
            threading.Thread(target=_open_browser, daemon=True).start()
        uvicorn.run(web_app, host=config.WEB_HOST, port=config.WEB_PORT, log_level="warning")
    finally:
        scheduler.shutdown(wait=False)
        from app.mailbox_jobs import stop_outbox
        if not stop_outbox(timeout=5):
            log.warning("发件后台任务未能在 5 秒内停止；当前发送结果将在下次启动时核对")


def main():
    from app.outbox import _process_lock
    ran = False
    try:
        with _process_lock(os.path.join(config.DATA_DIR, ".instance.lock")) as owns_instance:
            if not owns_instance:
                log.warning("MailAI 已在运行，本次启动已停止")
                return
            ran = True
            _run_app()
    except BaseException:
        log.critical("MailAI 主进程异常退出", exc_info=True)
        raise
    else:
        if not ran:
            return
        log.info("MailAI 已正常退出")
        mark_clean_shutdown()


if __name__ == "__main__":
    main()
