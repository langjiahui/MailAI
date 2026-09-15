"""Start a built macOS app with blank isolated data and no network credentials."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundle', type=Path)
    args = parser.parse_args()
    executable = args.bundle.resolve() / 'Contents/MacOS/MailAI'
    if not executable.is_file():
        raise SystemExit('Built MailAI executable not found')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix='mailai-package-smoke-') as root:
        env = dict(os.environ, MAILAI_HOME=root, WEB_HOST='127.0.0.1', WEB_PORT=str(port),
                   IMAP_USER='', IMAP_PASSWORD='', IMAP_HOST='', SMTP_HOST='', SMTP_USER='', SMTP_PASSWORD='',
                   LLM_API_KEY='', LLM_BASE_URL='http://127.0.0.1:1', AUTO_OPEN_BROWSER='false')
        with open(Path(root)/'process.log', 'wb') as log:
            process = subprocess.Popen([str(executable)], env=env, stdout=log, stderr=log)
            try:
                base = f'http://127.0.0.1:{port}'
                deadline = time.monotonic()+45
                while True:
                    if process.poll() is not None:
                        raise RuntimeError(f'Packaged application exited early ({process.returncode})')
                    try:
                        with urllib.request.urlopen(base+'/api/health', timeout=2) as response:
                            assert response.status == 200
                        break
                    except (urllib.error.URLError, TimeoutError):
                        if time.monotonic() >= deadline: raise RuntimeError('Packaged server failed to start within 45 seconds')
                        time.sleep(.25)
                with urllib.request.urlopen(base+'/api/system/config', timeout=5) as response:
                    config = json.load(response)
                    assert response.headers['Cache-Control'] == 'no-store'
                assert not config['mail']['logged_in'] and not config['accounts'], 'Clean install unexpectedly contains a mailbox'
                for route in ('/', '/static/app.js', '/static/workspace.css', '/static/assets/mailai-mark.png'):
                    with urllib.request.urlopen(base+route, timeout=5) as response:
                        assert response.status == 200 and response.read(100), route
                try:
                    urllib.request.urlopen(urllib.request.Request(base+'/api/system/config', headers={'Origin':'https://untrusted.example'}), timeout=5)
                except urllib.error.HTTPError as error:
                    assert error.code == 403
                else: raise AssertionError('Packaged API allowed a foreign origin')
                print('Packaged macOS app passed: isolated startup, health, empty account registry, static assets and local-origin protection')
            finally:
                process.terminate()
                try: process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    process.kill(); process.wait(timeout=5)


if __name__ == '__main__':
    main()
