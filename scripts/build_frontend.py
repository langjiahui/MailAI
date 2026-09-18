#!/usr/bin/env python3
"""前端打包：把 frontend/sources.txt 列出的脚本按顺序拼成单个 bundle.js。

设计约定：
- 纯 Python 标准库实现，离线可用，输出完全确定（同样输入永远同样字节）；
- 拼接语义与原来的多个 <script> 标签完全一致（共享全局作用域），
  所以现有源码一行不用改；后续渐进式模块化时再把文件迁到 frontend/src；
- 产物 app/web/static/bundle.js 需要提交；index.html 中的 ?v= 缓存版本号
  由内容哈希生成，本脚本同时负责回写；
- scripts/check_release.py 用 --check 校验产物新鲜度，防止改了源码忘打包。
"""
import argparse
import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "app" / "web" / "static"
MANIFEST = ROOT / "frontend" / "sources.txt"
BUNDLE = STATIC / "bundle.js"
INDEX = STATIC / "index.html"

PROLOGUE = """/* MailAI frontend bundle. 由 scripts/build_frontend.py 生成，请勿手改。
 * 源文件与顺序见 frontend/sources.txt；全局命名空间兼容入口为 window.MailAI。
 */
window.MailAI = window.MailAI || {};
"""


def read_sources() -> list[str]:
    names = []
    for line in MANIFEST.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            names.append(line)
    if not names:
        raise SystemExit("frontend/sources.txt 为空")
    return names


def build() -> tuple[str, str]:
    parts = [PROLOGUE]
    for name in read_sources():
        path = STATIC / name
        if not path.is_file():
            raise SystemExit(f"清单中的源文件不存在: {name}")
        text = path.read_text(encoding="utf-8")
        parts.append(f"\n/* ---- {name} ---- */\n{text}\n;")
    bundle = "".join(parts)
    digest = hashlib.sha256(bundle.encode("utf-8")).hexdigest()[:12]
    return bundle, digest


def render_index(html: str, digest: str) -> str:
    tag = f'  <script src="/static/bundle.js?v={digest}"></script>'
    replacement = tag + "\n"
    bundle_pattern = re.compile(r'[ \t]*<script src="/static/bundle\.js\?v=[^"]*"></script>\n?')
    if bundle_pattern.search(html):
        new_html, count = bundle_pattern.subn(replacement, html)
        if count != 1:
            raise SystemExit("index.html 中出现多个 bundle.js 标签")
        return new_html
    pattern = re.compile(r'(?:[ \t]*<script src="/static/(?!bundle\.js)[^"]+\.js\?v=[^"]*"></script>\n?)+')
    new_html, count = pattern.subn(replacement, html, count=1)
    if count != 1:
        raise SystemExit("index.html 中未找到连续的静态脚本标签块")
    return new_html


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true",
                        help="只校验 bundle.js 与 index.html 是最新的，不写文件")
    args = parser.parse_args()

    bundle, digest = build()
    expected_index = render_index(INDEX.read_text(encoding="utf-8"), digest)

    if args.check:
        stale = []
        if not BUNDLE.is_file() or BUNDLE.read_text(encoding="utf-8") != bundle:
            stale.append("app/web/static/bundle.js")
        if INDEX.read_text(encoding="utf-8") != expected_index:
            stale.append("app/web/static/index.html (bundle 标签)")
        if stale:
            print("前端产物过期: " + ", ".join(stale))
            print("请运行 python scripts/build_frontend.py 重新打包")
            return 1
        print(f"Frontend bundle up to date (v={digest})")
        return 0

    BUNDLE.write_text(bundle, encoding="utf-8")
    INDEX.write_text(expected_index, encoding="utf-8")
    print(f"Wrote {BUNDLE.relative_to(ROOT)} ({len(bundle)} bytes), index v={digest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
