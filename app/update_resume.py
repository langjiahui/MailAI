"""Persist verified package identity and resume partial bytes across restarts."""
import hashlib
import http.client
import json
import logging
import re
import time
from pathlib import Path
from .update_transport import open_public
from .update_mirror import valid_mirror
from . import update_routing

log = logging.getLogger(__name__)
MAX_BYTES = 500 * 1024 * 1024


def download(asset: dict, target: Path, progress=None, fallback=None):
    size = int(asset.get('size') or 0)
    if not 0 < size <= MAX_BYTES or not valid_mirror(asset.get('mirror_url', ''), asset['url']):
        raise ValueError('国内更新安装包信息无效')
    part = target.with_suffix(target.suffix + '.part')
    meta = part.with_suffix(part.suffix + '.json')
    identity = {'sha256': asset['sha256'], 'size': size}
    try:
        same = json.loads(meta.read_text(encoding='utf-8')) == identity
    except (OSError, ValueError):
        same = False
    if not same or (part.exists() and part.stat().st_size > size):
        part.unlink(missing_ok=True)
    meta.write_text(json.dumps(identity), encoding='utf-8')
    selected = (asset.get('preferred_source', 'atomgit') if part.exists() and part.stat().st_size == size
                else update_routing.download_source(asset))
    first, second = (asset['mirror_url'], asset['url']) if selected == 'atomgit' else (asset['url'], asset['mirror_url'])
    urls = [first, second, first, second, first]
    try:
        for attempt in range(6):
            if attempt == 5:
                candidate = fallback(asset) if fallback else asset
                url = candidate['url']
            else:
                url = urls[attempt]
            try:
                if not part.exists() or part.stat().st_size != size:
                    transfer(url, part, size, progress)
                digest = hashlib.sha256()
                with part.open('rb') as source:
                    for chunk in iter(lambda: source.read(1024 * 1024), b''):
                        digest.update(chunk)
                if digest.hexdigest() != asset['sha256']:
                    raise ValueError('安装包 SHA-256 校验失败，已停止更新')
                part.replace(target)
                meta.unlink(missing_ok=True)
                if progress:
                    progress(phase='verified', downloaded=size, total=size, speed_bps=0, message='安装包校验通过')
                return
            except (OSError, http.client.HTTPException) as exc:
                log.warning('更新下载中断，第 %d 次：%s', attempt + 1, type(exc).__name__)
                if attempt == 5:
                    raise OSError('安装包下载多次中断，已保留下载进度，请重试') from exc
                time.sleep(min(2 + attempt, 5))
    except ValueError:
        # A complete corrupt file or invalid server range is never reusable.
        part.unlink(missing_ok=True)
        meta.unlink(missing_ok=True)
        raise


def transfer(url: str, part: Path, size: int, progress=None):
    offset = part.stat().st_size if part.exists() else 0
    headers = {'Accept': 'application/octet-stream'}
    if offset:
        headers['Range'] = f'bytes={offset}-'
    started = time.monotonic()
    with open_public(url, headers=headers, timeout=30) as response:
        declared = int(response.headers.get('Content-Length') or 0)
        if response.status == 206:
            match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', response.headers.get('Content-Range', ''))
            if (not match or int(match[1]) != offset or int(match[3]) != size
                    or not offset <= int(match[2]) < size
                    or (declared and declared != int(match[2]) - offset + 1)):
                raise ValueError('安装包断点续传范围无效，已停止更新')
        elif response.status == 200:
            # A server may ignore Range. Restart instead of appending byte zero.
            offset = 0
            if declared and declared != size:
                raise OSError('安装包下载大小不完整')
        else:
            raise OSError('安装包下载响应无效')
        received = offset
        if progress:
            progress(phase='downloading', downloaded=received, total=size, speed_bps=0, message='正在下载安装包')
        with part.open('ab' if offset else 'wb') as output:
            while True:
                try:
                    chunk = response.read(256 * 1024)
                except http.client.IncompleteRead as exc:
                    chunk = exc.partial
                    if received + len(chunk) > size:
                        raise ValueError('安装包超过允许大小') from exc
                    output.write(chunk)
                    raise OSError('安装包下载不完整') from exc
                if not chunk:
                    break
                received += len(chunk)
                if received > size:
                    raise ValueError('安装包超过允许大小')
                output.write(chunk)
                if progress:
                    progress(phase='downloading', downloaded=received, total=size,
                             speed_bps=int((received - offset) / max(.001, time.monotonic() - started)),
                             message='正在下载安装包')
        if received != size:
            raise OSError('安装包下载不完整')
