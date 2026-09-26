"""Real isolated server processes: duplicate startup, kill, restart, persistence.

No mail credentials or external services are used. This does not substitute
for testing a real IMAP server or SMTP acknowledgments during disconnection.
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from unittest.mock import patch
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

ROOT = Path(__file__).resolve().parents[1]


def test_windows_locked_byte():
    from app import outbox
    class Stream:
        def fileno(self): return 7
        def read(self, *_): raise AssertionError('Do not read a locked Windows byte')
        def seek(self, *_): pass
        def close(self): pass
    windows = SimpleNamespace(LK_NBLCK=1, LK_UNLCK=2,
                              locking=lambda *_: (_ for _ in ()).throw(OSError('locked')))
    with patch.object(outbox.os, 'name', 'nt'), patch('builtins.open', return_value=Stream()), \
         patch.object(outbox.os, 'makedirs'), patch.object(outbox.os, 'fstat', return_value=SimpleNamespace(st_size=1)), \
         patch.dict(sys.modules, {'msvcrt':windows}):
        with outbox._process_lock('existing.lock') as acquired:
            assert acquired is False


def main():
    test_windows_locked_byte()
    with tempfile.TemporaryDirectory(prefix='mailai-process-recovery-') as root:
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        env = dict(os.environ, MAILAI_HOME=root, WEB_HOST='127.0.0.1', WEB_PORT=str(port),
                   IMAP_HOST='', IMAP_USER='', IMAP_PASSWORD='', SMTP_HOST='', SMTP_USER='',
                   SMTP_PASSWORD='', LLM_API_KEY='', AUTO_OPEN_BROWSER='false')
        def python(code):
            result = subprocess.run([sys.executable, '-c', code], env=env, cwd=ROOT,
                                    check=True, capture_output=True, text=True, timeout=20)
            return result.stdout.strip()
        python("from app import db; db.init_db(); "
               "db.save_draft({'subject':'persisted draft','body_text':'keep this text'}); "
               "db.set_runtime_setting('recovery_probe','preserved')")
        base = f'http://127.0.0.1:{port}'
        def get(route):
            with urllib.request.urlopen(base + route, timeout=2) as response:
                return json.load(response)
        processes = []
        with open(Path(root) / 'server.log', 'wb') as log:
            def start():
                process = subprocess.Popen([sys.executable, 'run.py'], env=env, cwd=ROOT,
                                           stdout=log, stderr=log)
                processes.append(process)
                return process
            def ready(process):
                deadline = time.monotonic() + 25
                while time.monotonic() < deadline:
                    assert process.poll() is None, 'server exited before readiness'
                    try:
                        get('/api/health')
                        return
                    except (urllib.error.URLError, TimeoutError):
                        time.sleep(.05)
                raise AssertionError('server startup timed out')
            try:
                original = start(); ready(original)
                assert get('/api/system/config')['accounts'] == [], 'test loaded a real account'
                duplicate = start()
                assert duplicate.wait(timeout=15) == 0, (Path(root) / 'server.log').read_text(encoding='utf-8', errors='replace')
                assert original.poll() is None
                get('/api/health')
                original.kill(); original.wait(timeout=8)
                restarted = start(); ready(restarted)
                restored = json.loads(python(
                    "import json; from app import db; "
                    "print(json.dumps([db.list_drafts(),db.get_runtime_settings().get('recovery_probe')]))"))
                assert restored[0][0]['subject'] == 'persisted draft' and restored[1] == 'preserved'
                # Uvicorn may re-raise SIGTERM after shutdown; Windows terminate
                # uses TerminateProcess. Both are normal outcomes for this probe.
                restarted.terminate()
                assert restarted.wait(timeout=10) in ((0, 1) if os.name == 'nt' else (0, -15))
                assert '已在运行' in (Path(root) / 'server.log').read_text(encoding='utf-8', errors='replace')
            finally:
                for process in processes:
                    if process.poll() is None:
                        process.kill(); process.wait(timeout=8)
    print('Real process recovery passed: duplicate startup, forced exit, restart, draft/settings persistence, shutdown')


if __name__ == '__main__':
    main()
