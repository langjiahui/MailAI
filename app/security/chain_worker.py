"""URL 链跟踪的子进程隔离。

链路跟踪要对邮件内容控制的 URL 发 DNS/HTTP 请求：目标可能故意
慢响应/挂起，把这类 I/O 放在短寿命子进程里执行，父进程按预算硬
超时并强杀，避免拖垮主处理管道。

协议（NDJSON，每完成一个 URL 立即写一行，被杀时已完成的可保留）:
  stdin:  {"urls": [...], "body_html": "..."}
  stdout: {"url": ..., "findings": [...], "result": {...}}  # 每个 URL 一行

打包（PyInstaller frozen）或 MAILAI_CHAIN_WORKER=0 时回退到进程内执行。
"""
from __future__ import annotations

import json
import logging
import os
import queue
import subprocess
import sys
import threading
import time

log = logging.getLogger(__name__)

# 每个 URL 的最坏耗时约 max_hops(5) x timeout(5s)，再加进程启动余量
_PER_URL_BUDGET = 30
_BASE_BUDGET = 15


def _worker_command() -> list[str]:
    return [sys.executable, "-m", "app.security.chain_worker"]


def _worker_available() -> bool:
    if os.environ.get("MAILAI_CHAIN_WORKER", "1") in ("0", "false", "no"):
        return False
    return not getattr(sys, "frozen", False)


def _analyze_in_process(urls: list[str], body_html: str) -> list[dict]:
    from . import chains
    out = []
    for url in urls:
        try:
            findings, result = chains.analyze_url_chain(url, body_html)
            out.append({"url": url, "findings": findings, "result": result})
        except Exception:
            log.exception("URL 链跟踪失败: %s", url)
    return out


def _run_worker(urls: list[str], body_html: str, timeout: float) -> list[dict]:
    """启动子进程并流式收集 NDJSON 结果；超过预算硬杀，已完成部分保留。"""
    proc = subprocess.Popen(
        _worker_command(),
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True, encoding="utf-8", errors="replace",
        cwd=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    )
    try:
        proc.stdin.write(json.dumps({"urls": urls, "body_html": body_html}, ensure_ascii=False))
        proc.stdin.close()
    except (BrokenPipeError, OSError):
        proc.kill()
        proc.wait()
        return []

    # readline 会阻塞且无法设超时，用守护线程泵入行队列，主线程按截止时间收割
    lines: queue.Queue = queue.Queue()

    def _pump():
        for line in proc.stdout:
            lines.put(line)
        lines.put(None)

    threading.Thread(target=_pump, daemon=True).start()

    out = []
    deadline = time.monotonic() + timeout
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                line = lines.get(timeout=remaining)
            except queue.Empty:
                break
            if line is None:
                break
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(item, dict) and "url" in item:
                out.append(item)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
    return out


def analyze_urls(urls: list[str], body_html: str = "", timeout: float | None = None) -> list[dict]:
    """对一批可疑 URL 做链跟踪，返回 [{"url", "findings", "result"}, ...]。

    顺序与输入一致（子进程按序处理）；子进程不可用时回退进程内执行。
    """
    urls = [u for u in urls if u][:5]
    if not urls:
        return []
    if not _worker_available():
        return _analyze_in_process(urls, body_html)
    budget = timeout or (_BASE_BUDGET + _PER_URL_BUDGET * len(urls))
    try:
        return _run_worker(urls, body_html, budget)
    except Exception:
        log.exception("链跟踪子进程异常，回退进程内执行")
        return _analyze_in_process(urls, body_html)


def _child_main() -> int:
    """子进程入口：python -m app.security.chain_worker"""
    from . import chains

    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError:
        return 2
    urls = [u for u in (payload.get("urls") or []) if u][:5]
    body_html = payload.get("body_html") or ""
    for url in urls:
        try:
            findings, result = chains.analyze_url_chain(url, body_html)
            item = {"url": url, "findings": findings, "result": result}
        except Exception as e:  # 单个 URL 失败不影响其余
            item = {"url": url, "findings": [], "result": {
                "chain": [], "final_url": url,
                "final_domain": "", "final_ip": "",
                "status": "error", "error": str(e),
            }}
        sys.stdout.write(json.dumps(item, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(_child_main())
