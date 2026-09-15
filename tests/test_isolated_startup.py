"""Process environment must isolate runtime paths and override local .env."""
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    with tempfile.TemporaryDirectory() as home:
        env = dict(os.environ, MAILAI_HOME=home, WEB_PORT="18795",
                   IMAP_USER="", IMAP_PASSWORD="", AUTO_OPEN_BROWSER="false")
        code = (
            "from app import config; from app.paths import USER_DIR; "
            "print(USER_DIR); print(config.WEB_PORT); print(repr(config.IMAP_USER)); "
            "print(config.DATA_DIR); print(config.AUTO_OPEN_BROWSER)"
        )
        run = subprocess.run([sys.executable, "-c", code], cwd=ROOT, env=env,
                             text=True, capture_output=True, timeout=15, check=True)
        lines = run.stdout.strip().splitlines()
        assert Path(lines[0]).resolve() == Path(home).resolve()
        assert lines[1:3] == ["18795", "''"]
        assert Path(lines[3]).resolve() == (Path(home) / "data").resolve()
        assert lines[4] == "False"
        assert not (Path(home) / "data" / "mailai.db").exists()
    print("Isolated runtime path and process environment precedence passed")


if __name__ == "__main__": main()
