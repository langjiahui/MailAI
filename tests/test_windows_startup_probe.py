"""Exercise the release probe against the real logged-out HTTP application."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def main():
    if '--child' not in sys.argv:
        with tempfile.TemporaryDirectory() as home:
            env = dict(os.environ, MAILAI_HOME=home, IMAP_USER='', IMAP_PASSWORD='',
                       LLM_API_KEY='', HTTP_PROXY='http://127.0.0.1:1',
                       http_proxy='http://127.0.0.1:1', NO_PROXY='', no_proxy='')
            subprocess.run([sys.executable, __file__, '--child'], env=env, check=True, timeout=30)
        return
    from app.desktop import start_local_server
    from app.web.server import app
    from scripts.verify_windows_artifact import verify_startup, get_json
    from urllib.error import HTTPError
    server = start_local_server(app)
    try:
        base = f'http://127.0.0.1:{server.port}'
        assert get_json(base + '/api/health')['llm_configured'] is False
        verify_startup(base)
        try:
            get_json(base + '/api/config')
        except HTTPError as exc:
            assert exc.code == 401
        else:
            raise AssertionError('Old probe should fail for a logged-out mailbox')
        print('PASS real startup probe: logged out, no model key, unreachable proxy')
    finally:
        server.stop()


if __name__ == '__main__':
    main()
