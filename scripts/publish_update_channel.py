"""Publish a signed static pointer after anonymous installer verification."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app.update_mirror import STATIC_MANIFEST_URL, read_json
from app.update_trust import verify

REPOSITORY = 'https://atomgit.com/langjiahui2011/MailAI.git'
BRANCH = 'updates'


def version(value):
    if not re.fullmatch(r'\d+\.\d+\.\d+',str(value)):
        raise ValueError('Invalid static update version')
    return tuple(map(int,value.split('.')))


def publish(path: Path, token: str, filename='latest.signed.json'):
    if filename not in ('latest.signed.json', 'android-latest.signed.json'):
        raise ValueError('Invalid official update channel')
    raw = path.read_bytes()
    envelope = json.loads(raw)
    manifest = verify(envelope)
    incoming = version(manifest.get('version'))
    with tempfile.TemporaryDirectory(prefix='mailai-update-channel-') as folder:
        root = Path(folder)
        helper = root / 'askpass'
        helper.write_text('#!/usr/bin/env python3\nimport os,sys\nprint("langjiahui2011" if "Username" in sys.argv[1] else os.environ["ATOMGIT_TOKEN"])\n')
        helper.chmod(0o700)
        env = {**os.environ,'ATOMGIT_TOKEN':token,'GIT_ASKPASS':str(helper),'GIT_TERMINAL_PROMPT':'0'}
        checkout = root / 'checkout';checkout.mkdir()
        def git(*args):
            result = subprocess.run(['git','-c','credential.helper=',*args],cwd=checkout,env=env,
                                    capture_output=True,timeout=180)
            if result.returncode:
                raise OSError('Static channel Git command failed: '+args[0])
            return result.stdout
        git('init','--initial-branch='+BRANCH)
        git('config','core.autocrlf','false')
        git('config','user.name','MailAI Release Bot')
        git('config','user.email','release-bot@users.noreply.github.com')
        current = git('ls-remote','--heads',REPOSITORY,'refs/heads/'+BRANCH).strip()
        if current:
            git('fetch','--depth=1',REPOSITORY,'refs/heads/'+BRANCH)
            git('checkout','-B',BRANCH,'FETCH_HEAD')
            previous_path = checkout/filename
            previous_raw = previous_path.read_bytes() if previous_path.exists() else None
        else:
            previous_raw = None
        if previous_raw is not None:
            previous = verify(json.loads(previous_raw))
            prior_version = version(previous.get('version'))
            if prior_version > incoming:
                print('Static channel already has a newer verified release',flush=True)
                return
            if prior_version == incoming:
                if previous_raw != raw:
                    raise ValueError('Static channel conflicts with immutable release bytes')
                print('Static channel is already current',flush=True)
                verify_public(manifest, filename)
                return
        (checkout/filename).write_bytes(raw)
        git('add',filename)
        git('commit','-m','Publish verified update manifest v'+manifest['version'])
        # No force: concurrent/newer channel updates must never be overwritten.
        git('push',REPOSITORY,'HEAD:refs/heads/'+BRANCH)
    verify_public(manifest, filename)


def verify_public(manifest, filename='latest.signed.json'):
    for attempt in range(13):
        try:
            received = read_json(STATIC_MANIFEST_URL.rsplit('/', 1)[0] + '/' + filename)
            if verify(received) != manifest:
                raise OSError('Static channel has not refreshed yet')
            print('Static channel anonymously verified: v'+manifest['version'],flush=True)
            return
        except OSError:
            if attempt==12:raise
            print('Waiting for static channel CDN refresh',flush=True)
            time.sleep(30)
