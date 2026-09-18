"""链跟踪子进程隔离：协议、SSRF 拦截透传、超时强杀、进程内回退。"""
import json
import os
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("MAILAI_HOME", tempfile.mkdtemp(prefix="mailai-chainworker-"))

from app.security import chain_worker


def test_child_protocol_roundtrip():
    """子进程 NDJSON 协议：SSRF 目标被拦截并以 blocked 状态回传。"""
    proc = subprocess.run(
        [sys.executable, "-m", "app.security.chain_worker"],
        input=json.dumps({"urls": ["http://127.0.0.1/internal", "http://[::1]/x"]}),
        capture_output=True, text=True, timeout=60,
        cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    )
    assert proc.returncode == 0, proc.stderr
    items = [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]
    assert len(items) == 2
    for item in items:
        assert item["result"]["status"] == "blocked", item
        # 父进程可用这些字段直接计 findings
        assert isinstance(item["findings"], list)


def test_analyze_urls_via_worker():
    """父进程入口：URL 顺序保持、SSRF 拦截结果完整。"""
    urls = ["http://127.0.0.1/a", "http://10.0.0.8/b"]
    out = chain_worker.analyze_urls(urls)
    assert [item["url"] for item in out] == urls
    assert all(item["result"]["status"] == "blocked" for item in out)
    # 私网/回环被拦截时不产生误报型 findings 由 chains 决定，这里只校验结构
    assert all(isinstance(item["findings"], list) for item in out)


def test_hard_timeout_kills_worker():
    """子进程挂起时按预算强杀，并返回已完成部分。"""
    class _BlockingStdout:
        """永不产出也不结束的 stdout，模拟挂死的子进程。"""

        def __iter__(self):
            while True:
                time.sleep(60)
                yield ""

    class FakeProc:
        def __init__(self):
            self.stdin = _FakeStdin()
            self.stdout = _BlockingStdout()
            self.killed = False

        def poll(self):
            return None if not self.killed else -9

        def kill(self):
            self.killed = True

        def wait(self, timeout=None):
            return -9

    class _FakeStdin:
        def write(self, data):
            pass

        def close(self):
            pass

    import app.security.chain_worker as cw
    original = cw.subprocess.Popen
    cw.subprocess.Popen = lambda *a, **k: FakeProc()
    try:
        t0 = time.time()
        out = cw._run_worker(["http://x.test"], "", timeout=1.5)
        elapsed = time.time() - t0
    finally:
        cw.subprocess.Popen = original
    assert out == []
    assert elapsed < 5, f"超时未生效: {elapsed:.1f}s"


def test_in_process_fallback_matches():
    """MAILAI_CHAIN_WORKER=0 回退进程内执行，结果结构一致。"""
    os.environ["MAILAI_CHAIN_WORKER"] = "0"
    try:
        out = chain_worker.analyze_urls(["http://127.0.0.1/internal"])
    finally:
        os.environ.pop("MAILAI_CHAIN_WORKER", None)
    assert len(out) == 1
    assert out[0]["result"]["status"] == "blocked"


def test_empty_and_cap():
    assert chain_worker.analyze_urls([]) == []
    assert chain_worker.analyze_urls(["", None]) == []


def main():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in tests:
        fn()
        print(f"PASS {fn.__name__}")
    print(f"{len(tests)} 项链跟踪隔离测试全部通过")


if __name__ == "__main__":
    main()
