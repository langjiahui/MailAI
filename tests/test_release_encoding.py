"""Release checks must not fail merely because Windows defaults to GBK."""
import os
import subprocess
import sys


def main():
    env = os.environ.copy()
    env.update(PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
    child = subprocess.run(
        [sys.executable, "-c", "print('✓ 系统配置与邮箱账号隔离测试通过')"],
        capture_output=True, text=True, encoding="utf-8", errors="strict", env=env, check=True,
    )
    assert child.stdout.strip() == "✓ 系统配置与邮箱账号隔离测试通过"
    print("UTF-8 release output passed")


if __name__ == "__main__":
    main()
