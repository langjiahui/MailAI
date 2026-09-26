"""Persistent task reminders, independent of mailbox polling and visible pages."""
import logging
import subprocess
import sys
import threading
from datetime import datetime, timedelta
from pathlib import Path

from . import db, system_settings
from .account_context import use

log = logging.getLogger(__name__)
_lock = threading.Lock()


def deliver(title, body, target):
    if sys.platform == 'darwin':
        from . import desktop
        if desktop._runtime is not None:
            return desktop._runtime._deliver_notification(title, body, target)
        if getattr(sys, 'frozen', False):
            return False  # Desktop is still starting; retry next tick.
        # Pass text as arguments, never interpolate user text into AppleScript.
        script = 'on run argv\n display notification (item 2 of argv) with title (item 1 of argv)\nend run'
        subprocess.run(['osascript', '-e', script, title, body], check=True, timeout=5,
                       capture_output=True)
        return True
    if sys.platform == 'win32':
        from . import windows_desktop
        runtime = windows_desktop._runtime
        if runtime is not None and runtime.tray is not None:
            return runtime.notify_task_reminder(title, body)
    return False


def ensure_delivery_table(c):
    c.execute("""CREATE TABLE IF NOT EXISTS task_notice_delivery (
        todo_id INTEGER PRIMARY KEY, remind_at TEXT NOT NULL,
        sent INTEGER NOT NULL DEFAULT 0, retry_after TEXT NOT NULL,
        error TEXT NOT NULL DEFAULT '')""")
    if 'error' not in {r[1] for r in c.execute('PRAGMA table_info(task_notice_delivery)')}:
        c.execute("ALTER TABLE task_notice_delivery ADD COLUMN error TEXT NOT NULL DEFAULT ''")


def capability():
    if sys.platform == 'darwin':
        from .desktop import _runtime
        return {'supported': True, 'mode': 'mac-desktop' if _runtime else 'mac-source',
                'hint': '请在 macOS 系统设置 → 通知中允许通知，并检查专注模式。源码版通知可能归属脚本程序。'}
    if sys.platform == 'win32':
        from .windows_desktop import _runtime
        supported = bool(_runtime and _runtime.tray)
        return {'supported': supported, 'mode':'windows-desktop' if supported else 'browser',
                'hint': '请在 Windows 设置 → 系统 → 通知中检查通知和勿扰模式。' if supported else '当前浏览器启动方式仅保留应用内提醒；Windows 安装版支持后台系统通知。'}
    return {'supported':False, 'mode':'browser', 'hint':'当前平台仅提供应用内提醒。'}


def reminder_records():
    now = datetime.now().isoformat()
    result = []
    for account_id, account in system_settings._load_registry().get('accounts', {}).items():
        if not account.get('visible', True) or not Path(account['db_path']).is_file():
            continue
        with use({'ACCOUNT_ID':account_id, 'DB_PATH':account['db_path']}):
            with db.conn() as c:
                ensure_delivery_table(c)
                rows = c.execute("""SELECT t.id,t.email_id,t.title,t.status,t.remind_at,
                    n.remind_at AS last_reminder,n.sent,n.error FROM todos t
                    LEFT JOIN task_notice_delivery n ON n.todo_id=t.id
                    WHERE t.remind_at IS NOT NULL OR n.todo_id IS NOT NULL
                    ORDER BY COALESCE(t.remind_at,n.remind_at) DESC LIMIT 200""").fetchall()
            for r in rows:
                item = dict(r)
                if item['status']=='done': state='done'
                elif not item['remind_at']: state='canceled'
                elif item['remind_at']>now: state='scheduled'
                elif item['last_reminder']==item['remind_at'] and item['sent']: state='submitted'
                elif item['last_reminder']==item['remind_at'] and item['error']: state='retry'
                else: state='due'
                result.append({**item,'state':state,'account_id':account_id,'account_user':account['user']})
    return result


def dispatch_account(account_id, account, now=None, send=None):
    now = now or datetime.now()
    send = send or deliver
    with use({'ACCOUNT_ID': account_id, 'DB_PATH': account['db_path']}):
        # A lease prevents duplicate delivery and expires if the process crashes.
        with db.conn() as c:
            ensure_delivery_table(c)
            c.execute('BEGIN IMMEDIATE')
            rows = c.execute('''SELECT t.id,t.title,t.email_id,t.remind_at FROM todos t
                LEFT JOIN task_notice_delivery n ON n.todo_id=t.id
                WHERE t.status='open' AND t.remind_at IS NOT NULL
                AND datetime(t.remind_at)<=datetime(?)
                AND (n.todo_id IS NULL OR n.remind_at!=t.remind_at
                     OR (n.sent=0 AND n.retry_after<=?))
                ORDER BY t.remind_at,t.id LIMIT 50''', (now.isoformat(), now.isoformat())).fetchall()
            if not rows:
                return 0
            for row in rows:
                c.execute('INSERT OR REPLACE INTO task_notice_delivery(todo_id,remind_at,sent,retry_after) VALUES(?,?,0,?)',
                          (row['id'], row['remind_at'], (now + timedelta(seconds=60)).isoformat()))
        title = 'MailAI · 待办到时间了' if len(rows) == 1 else f'MailAI · {len(rows)} 项待办到时间了'
        body = rows[0]['title'][:160] + (f' 等 {len(rows)} 项' if len(rows) > 1 else '')
        body += '\n' + account.get('user', '')
        target = {'accountId': account_id, 'todoId': rows[0]['id'], 'remindAt': rows[0]['remind_at']}
        try:
            accepted = send(title, body, target)
        except Exception:
            log.warning('系统待办通知暂未送达，将重试', exc_info=True)
            accepted = False
        if accepted:
            with db.conn() as c:
                for row in rows:
                    c.execute('UPDATE task_notice_delivery SET sent=1 WHERE todo_id=? AND remind_at=?',
                              (row['id'], row['remind_at']))
            return len(rows)
        with db.conn() as c:
            for row in rows:
                c.execute("UPDATE task_notice_delivery SET error=? WHERE todo_id=? AND remind_at=?",
                          ('系统通知暂未提交，请检查通知设置；待办仍保留', row['id'], row['remind_at']))
        return 0


def check_due_tasks():
    if not _lock.acquire(blocking=False):
        return
    try:
        for account_id, account in system_settings._load_registry().get('accounts', {}).items():
            if not account.get('visible', True) or not Path(account['db_path']).is_file():
                continue
            try:
                # Local tasks remain available even when mailbox login has expired.
                dispatch_account(account_id, account)
            except Exception:
                log.warning('检查待办提醒失败', exc_info=True)
    finally:
        _lock.release()
