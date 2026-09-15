"""Background synchronization for every connected account."""
from concurrent.futures import ThreadPoolExecutor
import threading
from . import config, db, pipeline, system_settings
from .account_context import snapshot, use
from .account_guard import account_work, guard

# Two concurrent mailboxes keep multi-account sync responsive without letting MIME,
# attachment and rule analysis saturate the desktop process on Windows laptops.
_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix='mailbox')
_pending = {}
_lock = threading.Lock()
_outbox_started = False
_outbox_thread = None
_outbox_stop = threading.Event()
_outbox_lock = threading.Lock()


@account_work
def _poll(values):
    # Refresh after acquiring the lease: queued work must not reuse a removed
    # account or credentials changed while another account occupied the pool.
    with use(snapshot(values['ACCOUNT_ID'])):
        db.init_db()
        from . import mail_assistant
        mail_assistant.alerts()  # Seed the notification baseline before importing.
        before = db.mailbox_revision()['latest_id']
        result = pipeline.poll_once()
        if result.get('ok'):
            db.set_runtime_setting('last_sync_success', __import__('datetime').datetime.now().isoformat(timespec='seconds'))
        prefs = mail_assistant.preferences()
        favorites = {c['email'].lower() for c in db.search_contacts('', 300, True)} if prefs['notifications'] == 'important' else set()
        muted = set(prefs.get('muted_threads', []))
        fetched = quarantined = 0
        if prefs['notifications'] != 'off':
            for email in db.notification_candidates(before):
                if email.get('thread_id') in muted:
                    continue
                high = mail_assistant.risk_alert_level(email) == 'high'
                if prefs['notifications'] == 'high_risk' and not high:
                    continue
                if prefs['notifications'] == 'important' and not (high or email.get('priority') == '高' or (email.get('from_addr') or '').lower() in favorites):
                    continue
                fetched += 1
                quarantined += email.get('status') == 'quarantine'
        result['fetched'] = fetched
        result['quarantined'] = quarantined
        result['account_user'] = config.IMAP_USER
        return result


def poll_all():
    accounts = system_settings._load_registry().get('accounts', {})
    if not accounts:
        return pipeline.poll_once() if config.IMAP_PASSWORD else {'ok': False, 'msg': '邮箱尚未配置'}
    with _lock:
        for account_id in list(_pending):
            if _pending[account_id].done():
                del _pending[account_id]
        for account_id, account in accounts.items():
            if not account.get('visible', True) or (account_id in _pending and not _pending[account_id].done()):
                continue
            try:
                values = snapshot(account_id)
            except ValueError:
                continue
            _pending[account_id] = _executor.submit(_poll, values)
            _pending[account_id].add_done_callback(_notify)
    return {'ok': True, 'fetched': 0, 'background': True}


def _check_outboxes(initialized, retries, now, send):
    """One bounded pass; a broken account must not spin or starve other accounts."""
    from . import outbox
    accounts = system_settings._load_registry().get('accounts', {})
    for cache in (initialized, retries):
        for account_id in list(cache):
            if account_id not in accounts:
                del cache[account_id]
    for account_id in accounts:
        failures, due = retries.get(account_id, (0, 0))
        if now < due:
            continue
        guard.acquire_work()
        try:
            with use(snapshot(account_id)):
                if initialized.get(account_id) != config.DB_PATH:
                    db.init_db()
                    initialized[account_id] = config.DB_PATH
                outbox.process(send)
                from . import trash_queue
                try:
                    trash_queue.process_due()
                except Exception:
                    # Mail deletion retries are independently persisted. A
                    # provider-specific failure must not pause the send queue
                    # or prevent another account from being serviced.
                    __import__('logging').getLogger(__name__).exception(
                        '后台垃圾箱同步暂不可用，将稍后重试'
                    )
                from . import seen_sync
                try:
                    seen_sync.process_due()
                except Exception:
                    # Read markers are optimistic and durable. Connectivity
                    # failures must not pause outgoing mail or trash retries.
                    __import__('logging').getLogger(__name__).exception(
                        '后台已读状态同步暂不可用，将稍后重试'
                    )
            retries.pop(account_id, None)
        except Exception:
            retries[account_id] = (min(failures + 1, 7), now + min(300, 5 * 2 ** min(failures, 6)))
            __import__('logging').getLogger(__name__).exception('检查发件箱失败，将稍后重试')
        finally:
            guard.release()


def start_outbox():
    global _outbox_started, _outbox_thread
    def run():
        global _outbox_started
        import time
        initialized, retries = {}, {}
        try:
            from .web.server import api_send_mail, SendMailRequest
            while not _outbox_stop.is_set():
                delay = 3
                try:
                    _check_outboxes(initialized, retries, time.monotonic(), lambda data: api_send_mail(SendMailRequest(**data)))
                except Exception:
                    delay = 30
                    __import__('logging').getLogger(__name__).exception('发件箱检查暂不可用，将稍后重试')
                _outbox_stop.wait(delay)
        finally:
            with _outbox_lock:
                _outbox_started = False
    with _outbox_lock:
        if _outbox_started:
            return
        _outbox_started = True
        _outbox_stop.clear()
        _outbox_thread = threading.Thread(target=run, daemon=True, name='outbox')
        _outbox_thread.start()


def stop_outbox(timeout=5):
    """Interrupt the idle wait; never replay an interrupted SMTP send."""
    with _outbox_lock:
        _outbox_stop.set()
        worker = _outbox_thread
    if worker and worker is not threading.current_thread():
        worker.join(timeout=timeout)
    return not (worker and worker.is_alive())


def _notify(future):
    try:
        result = future.result()
        import sys
        if getattr(sys, 'frozen', False):
            if sys.platform == 'darwin':
                from .desktop import notify_poll_result
            elif sys.platform == 'win32':
                from .windows_desktop import notify_poll_result
            else:
                return
            notify_poll_result(result)
    except Exception:
        __import__('logging').getLogger(__name__).exception('邮箱后台同步失败')
