"""Mirror a verified GitHub release; publish domestic metadata only after assets verify.

ATOMGIT_TOKEN stays in the runner environment. Signed upload URLs are never logged.
Retries reuse identical release bytes and never replace an existing attachment.
"""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import sys
import time
import urllib.error
import urllib.parse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.update_mirror import ATOM_API, attachment, NAMES
from app.update_transport import open_public
from app.update_trust import verify
from scripts.publish_update_channel import publish as publish_channel, version as version_tuple


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def api(path, token, method='GET', body=None):
    raw = json.dumps(body).encode() if body is not None else None
    # Credentials go only to this fixed host, never through redirects.
    for attempt in range(3):
        try:
            with open_public(ATOM_API + path, method=method, body=raw, allow_redirects=False,
                    headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}, timeout=30) as response:
                data = response.read(1024 * 1024 + 1)
                if len(data) > 1024 * 1024:
                    raise ValueError('Platform API response is too large')
                declared = int(response.headers.get('Content-Length') or 0)
                if declared and len(data) != declared:
                    raise OSError('Platform API response is incomplete')
                return json.loads(data) if data else {}
        except (OSError, http.client.HTTPException) as exc:
            if isinstance(exc, urllib.error.HTTPError) and exc.code not in {408, 429} and exc.code < 500:
                raise
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


def matches(tag, path):
    for attempt in range(3):
        try:
            return _matches_once(tag, path)
        except (OSError, http.client.HTTPException):
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


def _matches_once(tag, path):
    h = hashlib.sha256()
    total = 0
    with open_public(attachment(tag, path.name), timeout=45) as response:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > path.stat().st_size:
                return False
            h.update(chunk)
    if total < path.stat().st_size:
        raise OSError('Domestic attachment read was interrupted')
    return total == path.stat().st_size and h.hexdigest() == digest(path)


def upload(tag, path, token):
    if path.name in NAMES.values():
        manifest = json.loads((path.parent / 'latest.json').read_text(encoding='utf-8'))
        device = next(device for device, name in NAMES.items() if name == path.name)
        expected = manifest['assets'][device]
        if (manifest.get('version') != tag.removeprefix('v') or expected['size'] != path.stat().st_size
                or expected['sha256'] != digest(path)):
            raise ValueError('Source installer does not match official manifest: ' + path.name)
    endpoint = '/releases/' + urllib.parse.quote(tag, safe='')
    # Existing assets are immutable; re-runs validate instead of overwriting.
    release = api(endpoint, token)
    if any(item.get('name') == path.name for item in release.get('assets', [])):
        if not matches(tag, path):
            raise ValueError('Existing domestic attachment differs: ' + path.name)
        print('Verified existing attachment: ' + path.name, flush=True)
        return
    for attempt in range(4):
        try:
            result = api(endpoint + '/upload_url?file_name=' + urllib.parse.quote(path.name, safe=''), token)
            url = result['url']
            parsed = urllib.parse.urlparse(url)
            if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
                raise ValueError('Invalid upload URL')
            # Trust only storage domains returned by the authenticated platform.
            if not any(parsed.hostname == domain or parsed.hostname.endswith('.' + domain)
                       for domain in ('atomgit.com', 'gitcode.com', 'huaweicloud.com', 'myhuaweicloud.com')):
                raise ValueError('Unexpected upload storage host: ' + parsed.hostname)
            headers = dict(result.get('headers') or {})
            if any(name.lower() in {'authorization', 'cookie', 'proxy-authorization'} for name in headers):
                raise ValueError('Unexpected storage credential header')
            headers['Content-Length'] = str(path.stat().st_size)
            edge = os.getenv('ATOMGIT_UPLOAD_EDGE_IP', '').strip() if attempt % 2 == 0 and parsed.hostname == 'file.gitcode.com' else ''
            print('Uploading: ' + path.name + ' via ' + parsed.hostname + (' (verified TLS edge)' if edge else ''), flush=True)
            with path.open('rb') as source:
                with open_public(url, method='PUT', body=source, headers=headers, allow_redirects=False, timeout=180, connect_ip=edge or None) as response:
                    response.read(1024 * 1024)
            if not matches(tag, path):
                raise OSError('Domestic attachment verification failed')
            print('Uploaded and anonymously verified: ' + path.name, flush=True)
            return
        except (OSError, http.client.HTTPException) as exc:
            # The callback may have committed an upload before the connection broke.
            current = api(endpoint, token)
            if any(item.get('name') == path.name for item in current.get('assets', [])):
                if not matches(tag, path):
                    raise ValueError('Existing domestic attachment differs: ' + path.name) from None
                return
            print(f'Upload retry {attempt + 1}: {path.name} ({type(exc).__name__})', flush=True)
            if attempt == 3:
                raise RuntimeError('Attachment upload failed: ' + path.name) from None
            time.sleep(3 * (attempt + 1))


def sync(tag, assets, token, notes):
    manifest = json.loads((assets / 'latest.json').read_text(encoding='utf-8'))
    signed = verify(json.loads((assets / 'latest.signed.json').read_text(encoding='utf-8')))
    if signed != manifest or manifest.get('version') != tag.removeprefix('v'):
        raise ValueError('Release version/signature mismatch')
    for device, name in NAMES.items():
        path = assets / name
        item = manifest['assets'][device]
        if (item['sha256'] != digest(path) or item['size'] != path.stat().st_size
                or item['url'] != f'https://github.com/langjiahui/MailAI/releases/download/{tag}/{name}'):
            raise ValueError('Source installer verification failed: ' + name)
    endpoint = '/releases/' + urllib.parse.quote(tag, safe='')
    try:
        existing = api(endpoint, token)
        if existing.get('tag_name') != tag:
            raise ValueError('Domestic release tag mismatch')
    except urllib.error.HTTPError as exc:
        if exc.code != 404:
            raise
        api('/releases', token, 'POST', {'tag_name': tag, 'name': 'MailAI ' + tag.removeprefix('v'),
            'body': notes, 'target_commitish': tag, 'release_status': 'pre'})
    files = sorted(p for p in assets.iterdir() if p.is_file() and p.name not in {'latest.json', 'latest.signed.json'})
    for path in files + [assets / 'latest.json', assets / 'latest.signed.json']:
        upload(tag, path, token)
    try:
        current_latest = api('/releases/latest?type=latest', token)
    except urllib.error.HTTPError as exc:
        if exc.code != 404:
            raise
        current_latest = None
    if current_latest and version_tuple(str(current_latest.get('tag_name') or '').removeprefix('v')) > version_tuple(tag.removeprefix('v')):
        print('Historical release verified; newer domestic channel preserved', flush=True)
        return
    api(endpoint, token, 'PATCH', {'name': 'MailAI ' + tag.removeprefix('v'), 'body': notes, 'release_status': 'latest'})
    published = api('/releases/latest?type=latest', token)
    if published.get('tag_name') != tag or published.get('prerelease'):
        raise ValueError('Domestic release promotion failed')
    publish_channel(assets / 'latest.signed.json', token)
    print('Domestic release published and verified: ' + tag, flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--tag', required=True)
    parser.add_argument('--assets', type=Path, required=True)
    parser.add_argument('--notes', type=Path, required=True)
    args = parser.parse_args()
    try:
        sync(args.tag, args.assets, os.environ['ATOMGIT_TOKEN'], args.notes.read_text(encoding='utf-8'))
    except Exception as exc:
        # Never include exception URLs: signed storage query strings are credentials.
        print('AtomGit synchronization failed: ' + type(exc).__name__, file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
