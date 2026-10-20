"""Mirror immutable Android bytes without replacing the desktop update channel."""
import argparse
import base64
import json
import os
from pathlib import Path
import sys
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.update_trust import canonical, verify
from scripts.android_release import validate_manifest
from scripts.publish_update_channel import publish
from scripts.sync_atomgit_release import api, digest, upload


def sync(tag, assets, token, notes):
    envelope = json.loads((assets / 'android-latest.signed.json').read_text())
    manifest = verify(envelope)
    if base64.b64decode(envelope['payload'], validate=True) != canonical(manifest):
        raise ValueError('Signed Android payload mismatch')
    validate_manifest(manifest)
    if tag != 'android-v' + manifest['version']:
        raise ValueError('Android mirror tag mismatch')
    apk = assets / Path(manifest['url']).name
    if apk.stat().st_size != manifest['size'] or digest(apk) != manifest['sha256']:
        raise ValueError('Android mirror source bytes mismatch')
    endpoint = '/releases/' + tag
    previous_latest = api('/releases/latest?type=latest', token)
    try:
        existing = api(endpoint, token)
        if existing.get('tag_name') != tag:
            raise ValueError('Domestic Android tag mismatch')
    except urllib.error.HTTPError as exc:
        if exc.code != 404:
            raise
        api('/releases', token, 'POST', dict(tag_name=tag, name='MailAI Android ' + manifest['version'],
            body=notes, target_commitish=tag, release_status='pre'))
    for path in sorted(assets.iterdir()):
        if path.is_file():
            upload(tag, path, token)
    # AtomGit has no latest=false option: promote then restore the desktop latest marker.
    # Both mirror workflows share a concurrency group. Client channels stay independent.
    try:
        api(endpoint, token, 'PATCH', dict(name='MailAI Android ' + manifest['version'], body=notes, release_status='latest'))
    finally:
        old_tag = previous_latest.get('tag_name', '')
        if old_tag.startswith('v'):
            api('/releases/' + old_tag, token, 'PATCH', dict(name=previous_latest['name'],
                body=previous_latest.get('body', ''), release_status='latest'))
    actual = api(endpoint, token)
    if actual.get('prerelease') or actual.get('tag_name') != tag:
        raise ValueError('Domestic Android formal release verification failed')
    publish(assets / 'android-latest.signed.json', token, filename='android-latest.signed.json')
    print('Domestic Android release verified: ' + tag, flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--tag', required=True)
    parser.add_argument('--assets', type=Path, required=True)
    parser.add_argument('--notes', type=Path, required=True)
    args = parser.parse_args()
    try:
        sync(args.tag, args.assets, os.environ['ATOMGIT_TOKEN'], args.notes.read_text())
    except Exception as exc:
        print('Android domestic synchronization failed: ' + type(exc).__name__, file=sys.stderr)
        sys.exit(1)
