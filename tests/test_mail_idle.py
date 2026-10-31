"""Offline IDLE wake-up, disconnect recovery and bounded background work."""
from contextlib import contextmanager, ExitStack
import socket
import sys
import threading
import time
from pathlib import Path
from unittest.mock import patch,MagicMock
from imapclient import IMAPClient
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app import mail_idle,mailbox_jobs,imap_client
from app.account_context import current


@contextmanager
def idle_fixture(listener, client):
    mail = MagicMock()
    mail.__enter__.return_value.client = client
    with ExitStack() as stack:
        stack.enter_context(patch.object(mail_idle, 'snapshot', return_value={'ACCOUNT_ID': 'a'}))
        connect = stack.enter_context(patch.object(imap_client, 'MailClient', return_value=mail))
        registry = stack.enter_context(patch.object(mail_idle.system_settings, '_load_registry',
                                                    return_value={'accounts': {'a': {'visible': True}}}))
        poll = stack.enter_context(patch.object(mailbox_jobs, 'poll_all'))
        yield connect, registry, poll
    assert listener.client is None
    assert current.get() is None, 'The failed listener leaked its account context'


def idle_client():
    client = MagicMock()
    client.capabilities.return_value = (b'IDLE',)
    return client


def run_failures(client, count, *, healthy_attempt=None):
    """Advance a virtual clock; keep production reconnect delays observable."""
    listener = mail_idle.Listener('a')
    clock = [100.0]
    delays = []
    attempts = [0]
    checks = [0]
    budget = count * mail_idle.MAX_FAST_EMPTY_CHECKS + int(healthy_attempt is not None)

    def idle():
        attempts[0] += 1

    def check(timeout):
        checks[0] += 1
        if checks[0] > budget:
            listener.stop_event.set()  # Fail old busy-loop implementations promptly.
            return []
        if attempts[0] == healthy_attempt:
            clock[0] += timeout
            # One genuinely healthy check, then disconnect this session too.
            attempts[0] += 1
        return []

    def wait(delay):
        clock[0] += delay
        if delay >= 5:
            assert listener.state == 'polling', 'A failed connection cannot advertise healthy IDLE'
            delays.append(delay)
            if len(delays) == count:
                listener.stop_event.set()
        return listener.stop_event.is_set()

    client.idle.side_effect = idle
    client.idle_check.side_effect = check
    with idle_fixture(listener, client) as (connect, registry, poll), \
            patch.object(mail_idle.time, 'monotonic', side_effect=lambda: clock[0]), \
            patch.object(listener.stop_event, 'wait', side_effect=wait):
        listener.run()
        assert checks[0] <= budget, 'A disconnected listener exhausted its check budget'
        assert connect.call_count == count
        poll.assert_not_called()
        # The third fast empty check must disconnect before another registry read.
        assert registry.call_count <= count * 2 + int(healthy_attempt is not None)
    assert listener.state == 'stopped'
    return delays


def test_fast_empty_connections_back_off():
    client = idle_client()
    assert run_failures(client, 8) == [5, 10, 20, 40, 80, 160, 300, 300]
    assert client.idle_check.call_count == 8 * mail_idle.MAX_FAST_EMPTY_CHECKS
    assert client._imap.shutdown.call_count == 8
    client.idle_done.assert_not_called()
    # Login success does not reset failures; a full healthy IDLE wait does.
    assert run_failures(idle_client(), 3, healthy_attempt=2) == [5, 5, 10]


def test_transient_empty_wakes_and_arrivals_are_preserved():
    listener = mail_idle.Listener('a')
    client = idle_client()
    responses = iter([[], [], [(1, b'EXISTS')], [], [], [(2, b'EXISTS')]])
    waits = []

    def check(timeout):
        response = next(responses)
        if response == [(2, b'EXISTS')]:
            listener.stop_event.set()
        return response

    def wait(delay):
        assert 0 < delay <= mail_idle.MIN_CHECK_SECONDS
        waits.append(delay)
        return listener.stop_event.is_set()

    client.idle_check.side_effect = check
    with idle_fixture(listener, client) as (connect, registry, poll), \
            patch.object(listener.stop_event, 'wait', side_effect=wait):
        listener.run()
        connect.assert_called_once()
        assert registry.call_count == 6
        poll.assert_called_once_with(force=False, account_id='a', from_idle=True)
    assert len(waits) == 6, 'Rapid empty returns and event bursts must both be throttled'
    client._imap.shutdown.assert_not_called()
    client.idle_done.assert_called_once()


def test_normal_idle_timeouts_keep_the_connection():
    listener = mail_idle.Listener('a')
    client = idle_client()
    clock = [100.0]
    checks = [0]

    def check(timeout):
        assert timeout == 60
        clock[0] += timeout
        checks[0] += 1
        if checks[0] == 4:
            listener.stop_event.set()
        return []

    client.idle_check.side_effect = check
    with idle_fixture(listener, client) as (connect, registry, poll), \
            patch.object(mail_idle.time, 'monotonic', side_effect=lambda: clock[0]), \
            patch.object(listener.stop_event, 'wait') as wait:
        listener.run()
        connect.assert_called_once()
        assert registry.call_count == 4
        poll.assert_not_called()
        wait.assert_not_called()
    client._imap.shutdown.assert_not_called()
    client.idle_done.assert_called_once()


def test_bye_and_read_errors_close_before_retry():
    for response in ([(b'BYE', b'synthetic disconnect')], [('BYE', 'synthetic disconnect')],
                     OSError('synthetic socket failure'), IMAPClient.AbortError('synthetic abort')):
        listener = mail_idle.Listener('a')
        client = idle_client()
        if isinstance(response, Exception):
            client.idle_check.side_effect = response
        else:
            client.idle_check.return_value = response

        def wait(delay):
            assert delay == 5
            client._imap.shutdown.assert_called_once()
            client.idle_done.assert_not_called()
            listener.stop_event.set()

        with idle_fixture(listener, client) as (_, registry, poll), \
                patch.object(listener.stop_event, 'wait', side_effect=wait):
            listener.run()
            registry.assert_not_called()
            poll.assert_not_called()


@contextmanager
def closed_socket_client():
    """Real IMAPClient poll/EOF handling, with a closed local peer and no network."""
    local, peer = socket.socketpair()
    peer.close()
    client = IMAPClient.__new__(IMAPClient)
    client.socket = lambda: local
    client.capabilities = lambda: (b'IDLE',)
    client._set_read_timeout = lambda: None
    client.select_folder = lambda *args, **kwargs: None
    client.idle = lambda: None
    client.idle_done = MagicMock()
    client._imap = MagicMock()
    client._imap._get_line.side_effect = IMAPClient.AbortError('socket error: EOF')
    client._imap.shutdown.side_effect = local.close
    try:
        yield client
    finally:
        local.close()


def test_real_eof_sleeps_and_shutdown_interrupts_backoff():
    listener = mail_idle.Listener('a')
    errors = []

    def run():
        try:
            listener.run()
        except BaseException as exc:
            errors.append(exc)

    listener.thread = threading.Thread(target=run, daemon=True)
    with closed_socket_client() as client, idle_fixture(listener, client) as (connect, registry, poll):
        listener.thread.start()
        try:
            # More than enough for three bounded checks; much less than the
            # five-second reconnect backoff. Old code spins throughout this wait.
            time.sleep(.8)
            assert listener.thread.is_alive()
            assert listener.state == 'polling', 'EOF must leave the listening state'
            assert client._imap._get_line.call_count == 3, 'A dead socket must not be polled continuously'
            assert registry.call_count == 2, 'EOF cannot continuously reload account JSON'
            connect.assert_called_once()
            poll.assert_not_called()
            client._imap.shutdown.assert_called_once()
            client.idle_done.assert_not_called()
        finally:
            listener.stop()
            listener.thread.join(timeout=1)
        assert not listener.thread.is_alive(), 'Shutdown must interrupt reconnect backoff'
        assert not errors, errors


def main():
    test_fast_empty_connections_back_off()
    test_transient_empty_wakes_and_arrivals_are_preserved()
    test_normal_idle_timeouts_keep_the_connection()
    test_bye_and_read_errors_close_before_retry()
    test_real_eof_sleeps_and_shutdown_interrupts_backoff()
    listener=mail_idle.Listener('a')
    client=MagicMock();client.capabilities.return_value=(b'IDLE',)
    def wake(timeout):listener.stop_event.set();return [(1,b'EXISTS')]
    client.idle_check.side_effect=wake
    mail=MagicMock();mail.__enter__.return_value.client=client
    with patch.object(mail_idle,'snapshot',return_value={'ACCOUNT_ID':'a','IMAP_USER':'a@example.test'}),patch.object(imap_client,'MailClient',return_value=mail),patch.object(mail_idle.system_settings,'_load_registry',return_value={'accounts':{'a':{'visible':True}}}),patch.object(mailbox_jobs,'poll_all') as poll:
        listener.run();poll.assert_called_once_with(force=False,account_id='a',from_idle=True);client.idle_done.assert_called_once();assert current.get() is None
    with patch.object(mail_idle,'Listener') as fake:
        mail_idle._listeners.clear();mail_idle._stopping=False
        accounts={str(i):{'visible':True} for i in range(20)}
        mail_idle.ensure(accounts);assert fake.call_count==8
        first=next(iter(mail_idle._listeners));mail_idle.ensure({first:{'visible':True,'auto_sync_paused':True}})
        assert not mail_idle._listeners
        mail_idle.stop();mail_idle.ensure(accounts);assert not mail_idle._listeners
        mail_idle._stopping=False
    print('PASS IDLE: real socket EOF sleeps, bounded checks, BYE/errors, reconnect backoff, '
          'healthy recovery, arrivals, account isolation, pause, listener cap and shutdown')


if __name__=='__main__':main()
