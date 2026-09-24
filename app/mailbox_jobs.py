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
_next_poll_at = {}
_poll_again = set()
_outbox_started = False
_outbox_thread = None
_outbox_stop = threading.Event()
_outbox_lock = threading.Lock()


@account_work
def _poll(values):
    # Refresh after acquiring the lease: queued work must not reuse a removed
    # account or credentials changed while another account occupied the pool.
    with use(snapshot(values['ACCOUNT_ID'])):
        account = system_settings._load_registry().get('accounts', {}).get(values['ACCOUNT_ID'], {})
        if account.get('auto_sync_paused', False) and not values.get('manual_sync', False):
            return {'ok': True, 'fetched': 0, 'canceled': True}
        db.init_db()
        from . import mail_assistant
        mail_assistant.alerts()  # Seed the notification baseline before importing.
        result = pipeline.poll_once()
        if result.get('fetched'):
            from . import semantic
            semantic.schedule_missing()
        if result.get('ok') and not result.get('errors') and not result.get('canceled'):
            db.set_runtime_setting('last_sync_success', __import__('datetime').datetime.now().isoformat(timespec='seconds'))
        result['account_user'] = config.IMAP_USER
        return result


def poll_all(force=True, account_id=None):
    import time
    accounts = system_settings._load_registry().get('accounts', {})
    if not accounts:
        if not config.IMAP_PASSWORD:
            return {'ok': False, 'msg': '邮箱尚未配置'}
        with _lock:
            if not force and time.monotonic() < _next_poll_at.get('', 0):
                return {'ok': True, 'fetched': 0, 'background': True}
            _next_poll_at[''] = time.monotonic() + config.POLL_INTERVAL_SECONDS
        try:
            result = pipeline.poll_once()
            if result.get('fetched'):
                from . import semantic
                semantic.schedule_missing()
        except Exception:
            with _lock:
                _next_poll_at[''] = 0
            raise
        if not result.get('ok') or result.get('errors'):
            with _lock:
                _next_poll_at[''] = 0
        return result
    queued = False
    with _lock:
        for finished_id in list(_pending):
            if _pending[finished_id].done():
                future = _pending.pop(finished_id)
                try:
                    result = future.result()
                    healthy = result.get('ok') and not result.get('errors') and not result.get('canceled')
                except Exception:
                    healthy = False
                if not healthy or finished_id in _poll_again:
                    _poll_again.discard(finished_id)
                    _next_poll_at[finished_id] = 0
        for key, account in accounts.items():
            if account_id is not None and key != account_id:
                continue
            if not account.get('visible', True):
                continue
            if not force and account.get('auto_sync_paused', False):
                continue
            if key in _pending:
                if force:
                    _poll_again.add(key)
                    queued = True
                continue
            if not force and time.monotonic() < _next_poll_at.get(key, 0):
                continue
            try:
                values = snapshot(key)
            except ValueError:
                continue
            values['manual_sync'] = force
            _next_poll_at[key] = time.monotonic() + config.POLL_INTERVAL_SECONDS
            _pending[key] = _executor.submit(_poll, values)
            _pending[key].add_done_callback(_notify)
    return {'ok': True, 'fetched': 0, 'background': True, 'queued': queued}


def notify_new_message(email_id):
    """Deliver once per completed new message, including manual/history-priority polls."""
    from . import mail_assistant
    email = db.get_email(email_id)
    if not email or not db.claim_mail_notification(email_id):
        return
    allowed = mail_assistant.notification_allowed(email)
    result = dict(ok=True, received=1, fetched=int(allowed),
                  quarantined=int(allowed and mail_assistant.needs_risk_attention(email)),
                  account_user=config.IMAP_USER, account_id=getattr(config, 'ACCOUNT_ID', ''))
    import sys
    if getattr(sys, 'frozen', False):
        if sys.platform == 'darwin':
            from .desktop import notify_poll_result
        elif sys.platform == 'win32':
            from .windows_desktop import notify_poll_result
        else:
            return
        notify_poll_result(result)


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
                from . import trash_purge
                try:
                    trash_purge.schedule()
                except Exception:
                    __import__('logging').getLogger(__name__).exception('远端删除调度暂不可用，不影响发件箱')
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
        if result.get('notifications_delivered'):
            return
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
