"""Bounded IMAP IDLE listeners. Polling remains the durable source of truth."""

import logging
import threading
import time
from . import config, system_settings
from .account_context import current, snapshot

log = logging.getLogger(__name__)
_lock = threading.Lock()
_listeners = {}
_stopping = False
MAX_LISTENERS = 8


class Listener:
    def __init__(self, account_id):
        self.account_id = account_id
        self.stop_event = threading.Event()
        self.client = None
        self.state = "connecting"
        self.last_check = 0
        self.thread = threading.Thread(target=self.run, name="mailai-idle", daemon=True)

    def stop(self):
        self.stop_event.set()
        client = self.client
        if client:
            try:
                client._imap.shutdown()
            except Exception:
                pass

    def run(self):
        failures = 0
        while not self.stop_event.is_set():
            token = None
            try:
                from .imap_client import MailClient

                values = snapshot(self.account_id)
                # Listening never owns a long-lived account lease: logout and
                # account settings can interrupt it without blocking the UI.
                token = current.set(values)
                with MailClient() as mail:
                    self.client = mail.client
                    if (
                        b"IDLE" not in self.client.capabilities()
                        and "IDLE" not in self.client.capabilities()
                    ):
                        self.state = "polling"
                        self.stop_event.wait(300)
                        continue
                    self.client.select_folder(config.INBOX_FOLDER, readonly=True)
                    self.state = "listening"
                    self.last_check = time.monotonic()
                    failures = 0
                    started = time.monotonic()
                    last_notification = 0
                    self.client.idle()
                    try:
                        while (
                            not self.stop_event.is_set()
                            and time.monotonic() - started < 1200
                        ):
                            events = self.client.idle_check(timeout=60)
                            self.last_check = time.monotonic()
                            account = (
                                system_settings._load_registry()
                                .get("accounts", {})
                                .get(self.account_id, {})
                            )
                            if not account.get("visible", True) or account.get(
                                "auto_sync_paused"
                            ):
                                self.stop_event.set()
                                break
                            if events and time.monotonic() - last_notification > 2:
                                from .mailbox_jobs import poll_all

                                last_notification = time.monotonic()
                                poll_all(
                                    force=False,
                                    account_id=self.account_id,
                                    from_idle=True,
                                )
                    finally:
                        try:
                            self.client.idle_done()
                        except Exception:
                            pass
            except Exception:
                if not self.stop_event.is_set():
                    failures = min(failures + 1, 7)
                    self.state = "polling"
                    log.info("新邮件监听暂不可用，保留定时同步")
                    self.stop_event.wait(min(300, 5 * 2 ** (failures - 1)))
            finally:
                self.client = None
                if token is not None:
                    current.reset(token)
        self.state = "stopped"


def ensure(accounts):
    global _stopping
    if _stopping:
        return
    eligible = [
        key
        for key, a in accounts.items()
        if a.get("visible", True) and not a.get("auto_sync_paused", False)
    ][:MAX_LISTENERS]
    with _lock:
        for key in list(_listeners):
            if key not in eligible:
                _listeners.pop(key).stop()
        for key in eligible:
            existing = _listeners.get(key)
            if existing is not None and not existing.thread.is_alive():
                _listeners.pop(key).stop()
            if key not in _listeners:
                listener = Listener(key)
                _listeners[key] = listener
                listener.thread.start()


def status():
    with _lock:
        return {key: listener.state for key, listener in _listeners.items()}


def stop():
    global _stopping
    _stopping = True
    with _lock:
        listeners = list(_listeners.values())
        _listeners.clear()
    for listener in listeners:
        listener.stop()


def listening(account_id):
    """Only a live, recently checked IDLE listener can replace frequent polling."""
    with _lock:
        listener = _listeners.get(account_id)
        return bool(listener and listener.state == 'listening' and listener.thread.is_alive()
                    and time.monotonic() - listener.last_check < 120)
