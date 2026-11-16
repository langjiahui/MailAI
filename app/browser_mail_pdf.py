"""Render mail snapshots in a private, local Chromium profile."""

import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading


_render_slot = threading.BoundedSemaphore(1)


def _browser():
    override = os.environ.get('MAILAI_PDF_BROWSER')
    if override:
        return shutil.which(override)

    candidates = []
    if sys.platform == 'darwin':
        for base in (Path('/Applications'), Path.home() / 'Applications'):
            for name in ('Google Chrome', 'Microsoft Edge', 'Chromium', 'Brave Browser'):
                candidates.append(base / f'{name}.app' / 'Contents/MacOS' / name)
    elif sys.platform == 'win32':
        for key in ('ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA'):
            base = os.environ.get(key)
            if base:
                candidates.extend(Path(base) / path for path in (
                    'Google/Chrome/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe',
                ))
    for path in candidates:
        if path.is_file():
            return str(path)
    for name in ('google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'):
        if path := shutil.which(name):
            return path
    return None


def render_pdf(document):
    browser = _browser()
    if not browser:
        raise ValueError('生成 PDF 需要本机安装 Chrome、Edge 或 Chromium。')
    if not _render_slot.acquire(timeout=15):
        raise ValueError('正在生成其他邮件的 PDF，请稍后重试。')
    try:
        with tempfile.TemporaryDirectory(prefix='mailai-pdf-') as directory:
            root = Path(directory)
            source, target = root / 'mail.html', root / 'mail.pdf'
            source.write_text(document, encoding='utf-8')
            try:
                result = subprocess.run([
                    browser, '--headless', '--no-first-run', '--no-default-browser-check',
                    '--disable-extensions', '--disable-background-networking', '--disable-sync',
                    f'--user-data-dir={root / "profile"}', f'--print-to-pdf={target}',
                    '--no-pdf-header-footer', source.as_uri(),
                ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=45)
            except (OSError, subprocess.TimeoutExpired) as error:
                raise ValueError('PDF 生成未完成，请重试。') from error
            if result.returncode != 0 or not target.is_file():
                raise ValueError('PDF 生成未完成，请重试。')
            with target.open('rb') as pdf:
                payload = pdf.read(64 * 1024 * 1024 + 1)
            if not payload.startswith(b'%PDF-') or len(payload) > 64 * 1024 * 1024:
                raise ValueError('PDF 生成未完成，请重试。')
            return payload
    finally:
        _render_slot.release()
