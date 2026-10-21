"""Resolve an independent mirror run to an existing immutable official release."""
import json
import os
from pathlib import Path
import re
import subprocess


def get(repository, path):
    return json.loads(subprocess.check_output(['gh', 'api', f'repos/{repository}/{path}'], timeout=30))


def resolve(event_name, event, repository, api):
    expected = None
    if event_name == 'workflow_run':
        run = event['workflow_run']
        if (run['conclusion'] != 'success' or run['event'] != 'push'
                or run['path'] != '.github/workflows/release.yml'
                or run['head_repository']['full_name'] != repository):
            raise ValueError('Mirror trigger is not a successful official publish run')
        tag, expected = run['head_branch'], run['head_sha']
    else:
        tag = event.get('inputs', {}).get('tag') or os.getenv('REQUESTED_TAG', '')
    if not re.fullmatch(r'v\d+\.\d+\.\d+', tag):
        raise ValueError('Invalid desktop release tag')
    release = api('releases/tags/' + tag)
    if release['draft'] or release['prerelease'] or release['tag_name'] != tag:
        raise ValueError('Mirror target is not an official release')
    ref = api('git/ref/tags/' + tag)['object']
    # Accommodate both lightweight and annotated immutable tags.
    for _ in range(5):
        if ref['type'] == 'commit':
            break
        if ref['type'] != 'tag':
            raise ValueError('Release tag does not point to a commit')
        ref = api('git/tags/' + ref['sha'])['object']
    if ref['type'] != 'commit' or (expected and ref['sha'] != expected):
        raise ValueError('Publish run and release tag differ')
    return tag


if __name__ == '__main__':
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    repository = os.environ['GITHUB_REPOSITORY']
    tag = resolve(os.environ['GITHUB_EVENT_NAME'], event, repository,
                  lambda path: get(repository, path))
    with open(os.environ['GITHUB_OUTPUT'], 'a') as stream:
        stream.write('tag=' + tag + '\n')
    print('Mirror existing official release: ' + tag)
