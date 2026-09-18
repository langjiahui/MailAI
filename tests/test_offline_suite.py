"""pytest 统一入口：以子进程方式运行离线测试套件。

清单与 scripts/check_release.py 的 TESTS 保持同一份（直接 import 读取），
因此新增离线测试只需在 check_release.py 的 TESTS 里登记一处，
发布门禁与 `python -m pytest tests/ -q` 会同时覆盖。

每个脚本在独立子进程中运行（与门禁一致），超时与门禁同为 90 秒。
浏览器/.cjs 检查不在此列 —— 完整验收仍以 scripts/check_release.py 为准。
"""
import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent

_spec = importlib.util.spec_from_file_location(
    'check_release', ROOT / 'scripts' / 'check_release.py'
)
_check_release = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_check_release)

SCRIPT_TESTS = list(_check_release.TESTS)
if sys.platform == 'darwin':
    SCRIPT_TESTS.append('test_mail_links_webkit.py')


@pytest.mark.parametrize('name', SCRIPT_TESTS)
def test_offline_script(name):
    try:
        result = subprocess.run(
            [sys.executable, str(ROOT / 'tests' / name)],
            cwd=ROOT, capture_output=True, text=True, timeout=90,
            encoding='utf-8', errors='replace',
        )
    except subprocess.TimeoutExpired:
        pytest.fail(f'{name} 超时（90s）')
    assert result.returncode == 0, (
        f'{name} 退出码 {result.returncode}\n{result.stdout}\n{result.stderr}'
    )
