"""Compare IDLE worker CPU against an earlier mail_idle.py using local EOF only.

Example: python scripts/benchmark_mail_idle.py --baseline /tmp/mail_idle_before.py
This measures worker CPU, not battery watts. No mailbox or network is accessed.
"""
import argparse
from contextlib import ExitStack
import importlib.util
import json
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from imapclient import IMAPClient
from app import imap_client, mail_idle, mailbox_jobs


def measure(module, seconds):
    counts = {'idle_checks': 0, 'registry_reads': 0, 'connections': 0}
    result = {}
    errors = []

    class ClosedConnection:
        def __enter__(self):
            counts['connections'] += 1
            self.local, peer = socket.socketpair()
            peer.close()
            self.client = IMAPClient.__new__(IMAPClient)
            self.client.socket = lambda: self.local
            self.client.capabilities = lambda: (b'IDLE',)
            self.client._set_read_timeout = lambda: None
            self.client.select_folder = lambda *args, **kwargs: None
            self.client.idle = lambda: None
            self.client.idle_done = lambda: None
            self.client._imap = SimpleNamespace(_get_line=self.eof, shutdown=self.local.close)
            return self

        def eof(self):
            counts['idle_checks'] += 1
            raise IMAPClient.AbortError('socket error: EOF')

        def __exit__(self, *exc):
            self.local.close()

    def unexpected_poll(**kwargs):
        raise AssertionError('EOF must not trigger mail synchronization')

    listener = module.Listener('fixture')
    started = threading.Event()

    def run():
        cpu_start, wall_start = time.thread_time(), time.monotonic()
        started.set()
        try:
            listener.run()
        except BaseException as exc:
            errors.append(exc)
        finally:
            result.update(cpu_seconds=time.thread_time() - cpu_start,
                          wall_seconds=time.monotonic() - wall_start)

    with tempfile.TemporaryDirectory() as folder, ExitStack() as stack:
        registry = Path(folder) / 'accounts.json'
        registry.write_text(json.dumps({'accounts': {'fixture': {'visible': True}}}), encoding='utf-8')

        def load_registry():
            counts['registry_reads'] += 1
            with registry.open(encoding='utf-8') as stream:
                return json.load(stream)

        stack.enter_context(patch.object(imap_client, 'MailClient', new=ClosedConnection))
        stack.enter_context(patch.object(module, 'snapshot', new=lambda key: {'ACCOUNT_ID': key}))
        stack.enter_context(patch.object(module.system_settings, '_load_registry', new=load_registry))
        stack.enter_context(patch.object(mailbox_jobs, 'poll_all', new=unexpected_poll))
        listener.thread = threading.Thread(target=run, daemon=True)
        listener.thread.start()
        try:
            assert started.wait(2), 'Worker did not start'
            listener.thread.join(timeout=seconds)
            result['state_before_stop'] = listener.state
        finally:
            stopped_at = time.monotonic()
            listener.stop()
            listener.thread.join(timeout=1)
            result['shutdown_seconds'] = time.monotonic() - stopped_at
        assert not listener.thread.is_alive(), 'Shutdown did not interrupt the worker'
        assert not errors, errors
    result.update(counts)
    result['worker_cpu_percent'] = 100 * result['cpu_seconds'] / result['wall_seconds']
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--seconds', type=float, default=2)
    args = parser.parse_args()
    if not 1 <= args.seconds <= 4:
        parser.error('--seconds must be between 1 and 4 (before the first reconnect)')
    spec = importlib.util.spec_from_file_location('app._idle_energy_baseline', args.baseline)
    baseline_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(baseline_module)
    baseline = measure(baseline_module, args.seconds)
    fixed = measure(mail_idle, args.seconds)
    reduction = 100 * (1 - fixed['cpu_seconds'] / baseline['cpu_seconds'])
    print(json.dumps({'scenario': 'closed local socket; real IMAPClient EOF handling; synthetic registry',
                      'baseline': baseline, 'fixed': fixed, 'worker_cpu_reduction_percent': reduction},
                     indent=2))
    assert baseline['cpu_seconds'] > .1, 'Insufficient baseline CPU for a useful comparison'
    assert fixed['state_before_stop'] == 'polling'
    assert fixed['idle_checks'] == 3 and fixed['registry_reads'] == 2
    assert fixed['connections'] == 1
    assert reduction > 90, 'Disconnected worker CPU did not fall by at least 90%'


if __name__ == '__main__':
    main()
