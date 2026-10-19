"""Choose official update sources by verified reachability, never by user location."""
from __future__ import annotations
import http.client
import logging
import re
import threading
import time
from dataclasses import dataclass, field
from . import update_mirror
from .update_transport import open_public

log = logging.getLogger(__name__)
DISCOVERY_TIMEOUT = 8.0
PROBE_TIMEOUT = 4.0
SETTLE_SECONDS = .25
CACHE_SECONDS = 1800
_SAMPLE_BYTES = 64 * 1024
_lock = threading.Lock()
_pending = {}
_recent = {}


@dataclass
class Attempt:
    done: threading.Event = field(default_factory=threading.Event)
    result: object = None
    error: Exception | None = None
    elapsed: float = 0


def _start(key, function):
    with _lock:
        pending = _pending.get(key)
        if pending is not None:
            return pending
        attempt = Attempt()
        _pending[key] = attempt

    def run():
        started = time.monotonic()
        try:
            attempt.result = function()
        except Exception as exc:
            attempt.error = exc
        finally:
            attempt.elapsed = time.monotonic() - started
            with _lock:
                if attempt.error is None:
                    _recent[key] = (time.monotonic(), attempt.result, attempt.elapsed)
                _pending.pop(key, None)
                # Bound memory even if many different versions are checked.
                expired = [name for name, item in _recent.items() if time.monotonic() - item[0] > CACHE_SECONDS]
                for name in expired:
                    _recent.pop(name, None)
            attempt.done.set()

    # A blocked provider must not hold up a working source or application exit.
    threading.Thread(target=run, name='mailai-update-source', daemon=True).start()
    return attempt


def _version(value):
    if not re.fullmatch(r'\d+\.\d+\.\d+', str(value)):
        raise ValueError('Invalid official update version')
    return tuple(map(int, value.split('.')))


def _normalize(manifest, source):
    version = str(manifest.get('version') or '').lstrip('v')
    _version(version)
    tag = 'v' + version
    original_release = update_mirror.GITHUB_RELEASES + '/tag/' + tag
    if manifest.get('release_url') != original_release:
        raise ValueError('Official update release page mismatch')
    original_assets = manifest.get('assets')
    if not isinstance(original_assets, dict):
        raise ValueError('Official update assets are missing')
    assets = {}
    for device, name in update_mirror.NAMES.items():
        item = original_assets.get(device)
        if item is None:
            continue
        if (not isinstance(item, dict) or item.get('url') != f'{update_mirror.GITHUB_RELEASES}/download/{tag}/{name}'
                or not re.fullmatch(r'[a-fA-F0-9]{64}', str(item.get('sha256') or ''))
                or type(item.get('size')) is not int or not 0 < item['size'] <= 500 * 1024 * 1024):
            raise ValueError('Official update asset identity mismatch')
        assets[device] = {**item, 'mirror_url': update_mirror.attachment(tag, name), 'preferred_source': source}
    if not assets:
        raise ValueError('Official update has no supported assets')
    return {**manifest, 'version': version, 'assets': assets,
            'release_url': update_mirror.ATOM_RELEASES if source == 'atomgit' else original_release}


def discover(github_loader, installed_version):
    # Both loaders read only our two public repositories. No GeoIP or telemetry.
    loaders = {'atomgit': update_mirror.discover, 'github': github_loader}
    attempts = {source: _start('manifest:' + source,
                               lambda loader=loader, source=source: _normalize(loader(), source))
                for source, loader in loaders.items()}
    deadline = time.monotonic() + DISCOVERY_TIMEOUT
    settle_at = None
    candidates = {}
    installed = _version(installed_version)
    while True:
        now = time.monotonic()
        with _lock:
            for source in attempts:
                cached = _recent.get('manifest:' + source)
                if cached and now - cached[0] <= CACHE_SECONDS:
                    candidates[source] = (cached[1], cached[2])
        for source, attempt in attempts.items():
            if attempt.done.is_set() and attempt.error is None:
                candidates[source] = (attempt.result, attempt.elapsed)
        if candidates and any(_version(value[0]['version']) > installed for value in candidates.values()):
            if settle_at is None:
                settle_at = now + SETTLE_SECONDS
        if (all(value.done.is_set() for value in attempts.values()) or now >= deadline
                or (settle_at is not None and now >= settle_at)):
            break
        threading.Event().wait(min(.02, max(0, deadline - now)))
    if not candidates:
        if any(isinstance(attempt.error, ValueError) for attempt in attempts.values()):
            raise ValueError('更新清单校验失败，已停止更新')
        raise OSError('无法连接更新服务，请稍后重试或点击“查看发布页”手动下载')
    source, (manifest, _elapsed) = max(candidates.items(),
        key=lambda pair: (_version(pair[1][0]['version']), -pair[1][1]))
    log.info('更新清单自动选路：%s', source)
    return manifest


def _probe(url, size):
    count = min(_SAMPLE_BYTES, size)
    with open_public(url, headers={'Accept': 'application/octet-stream', 'Range': f'bytes=0-{count - 1}'}, timeout=PROBE_TIMEOUT) as response:
        if response.status == 206:
            if response.headers.get('Content-Range') != f'bytes 0-{count - 1}/{size}':
                raise ValueError('Download probe range mismatch')
        elif response.status == 200:
            if int(response.headers.get('Content-Length') or 0) != size:
                raise ValueError('Download probe size mismatch')
        else:
            raise OSError('Download probe failed')
        if len(response.read(count)) != count:
            raise OSError('Download probe interrupted')
    return True


def download_source(asset):
    preferred = asset.get('preferred_source', 'atomgit')
    if preferred not in {'atomgit', 'github'}:
        preferred = 'atomgit'
    size = int(asset['size'])
    attempts = {source: _start('download:' + asset['sha256'] + ':' + source,
                               lambda url=url: _probe(url, size))
                for source, url in [('atomgit', asset['mirror_url']), ('github', asset['url'])]}
    deadline = time.monotonic() + PROBE_TIMEOUT
    while time.monotonic() < deadline:
        ready = [(source, attempt.elapsed) for source, attempt in attempts.items()
                 if attempt.done.is_set() and attempt.error is None]
        if ready:
            source = min(ready, key=lambda value: value[1])[0]
            log.info('安装包自动选路：%s', source)
            return source
        if all(attempt.done.is_set() for attempt in attempts.values()):
            break
        threading.Event().wait(.02)
    # Failed probes do not invalidate a known manifest or discard partial bytes.
    return preferred
