"""Windowed builds must preserve crashes in a user-writable log."""
import os
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def main():
    with tempfile.TemporaryDirectory() as folder:
        env = dict(os.environ, MAILAI_HOME=folder)
        code = """
from app.runtime_logging import configure_runtime_logging
import logging
import threading

path = configure_runtime_logging()
logging.getLogger('runtime-test').error('persistent-test')

def fail():
    raise RuntimeError('thread-test')

t = threading.Thread(target=fail, name='failure-thread')
t.start()
t.join()
logging.shutdown()
print(path)
"""
        result = subprocess.run(
            [sys.executable, "-c", code], cwd=ROOT, env=env,
            text=True, capture_output=True, timeout=15, check=True,
        )
        log_path = Path(folder).resolve() / "logs" / "mailai.log"
        content = log_path.read_text(encoding="utf-8")
        assert "persistent-test" in content
        assert "未捕获的后台线程异常: failure-thread" in content
        assert "thread-test" in content
        assert (Path(folder) / "logs" / "running.json").exists()
    print("Persistent runtime logging passed")


if __name__ == "__main__":
    main()
