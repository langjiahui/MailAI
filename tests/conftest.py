"""pytest 配置：脚本式测试不经 pytest 原生收集。

tests/ 下的历史测试都是 `python tests/test_x.py` 脚本（依赖 __main__ 守卫
在子进程中完成环境隔离），直接 import 收集会跳过它们的环境初始化。
统一入口是 test_offline_suite.py（子进程包装，清单来自 scripts/check_release.py）。
以后要新增 pytest 原生测试，把文件名加进 NATIVE_TESTS 即可。
"""
import os

_HERE = os.path.dirname(os.path.abspath(__file__))

NATIVE_TESTS = frozenset({
    'test_offline_suite.py',
})

collect_ignore = [
    name
    for name in os.listdir(_HERE)
    if name.startswith('test_') and name.endswith('.py') and name not in NATIVE_TESTS
]
