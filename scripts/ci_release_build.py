"""Prepare private installers in parallel with full checks; promote identical bytes only.

Build artifacts are not quality evidence. The tag workflow still requires the
original full proof, release history scan, native smoke tests and signed manifest.
GitHub run/commit/artifact APIs bind the build to the exact release source tree.
"""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile
import zipfile

if __package__:
    from . import ci_quality
else:
    import ci_quality

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = '.github/workflows/release.yml'
SHA = re.compile(r'[a-f0-9]{40}')
VERSION = re.compile(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)')
PACKAGES = {'windows-x64': 'MailAI-Windows-x64-Setup.exe',
            'macos-arm64': 'MailAI-macOS-arm64.pkg',
            'linux-x64': 'MailAI-Linux-x64.AppImage'}
FILES = {'release-' + platform: {name, name + '.sha256'} for platform, name in PACKAGES.items()}
FILES['release-macos-arm64'].add('MailAI-macOS-arm64.dmg')


class GitHub(ci_quality.GitHub):
    def file(self, path, ref):
        record = self.get(f'contents/{path}?ref={ref}')
        if record.get('encoding') != 'base64' or record.get('size', 10**9) > 256 * 1024:
            raise ValueError('Missing or oversized build metadata')
        return base64.b64decode(record['content']).decode('utf-8')

    def download(self, artifact, path):
        with path.open('wb') as stream:
            subprocess.run(['gh', 'api', f'repos/{self.repository}/actions/artifacts/{artifact}/zip'],
                           stdout=stream, check=True, timeout=180)


def source(api, run, tree, version, now):
    """Accept only complete same-repository preparation runs, never tag/fork/PR runs."""
    if (run.get('path') != WORKFLOW or run.get('event') != 'workflow_dispatch'
            or run.get('status') != 'completed' or run.get('conclusion') != 'success'
            or run.get('repository', {}).get('full_name') != api.repository
            or run.get('head_repository', {}).get('full_name') != api.repository
            or not SHA.fullmatch(run.get('head_sha', ''))):
        raise ValueError('Untrusted or incomplete installer build')
    for key in ('created_at', 'updated_at'):
        age = now - datetime.fromisoformat(run[key].replace('Z', '+00:00'))
        if age.total_seconds() < 0 or age > ci_quality.MAX_AGE:
            raise ValueError('Installer build is stale')
    head = run['head_sha']
    if api.get('git/commits/' + head)['tree']['sha'] != tree:
        raise ValueError('Installer source tree differs from the release')
    if api.file('VERSION', head).strip() != version:
        raise ValueError('Installer product version differs from the release')
    # Rerun-failed preserves successful jobs/artifacts from earlier attempts.
    # Select the latest execution of each job without accepting a stale success.
    jobs = []
    for page in range(1, 11):
        batch = api.get(f'actions/runs/{run["id"]}/jobs?filter=all&per_page=100&page={page}')['jobs']
        jobs.extend(batch)
        if len(batch) < 100:
            break
    else:
        raise ValueError('Too many installer jobs')
    latest = {job['name']: job for job in sorted(jobs, key=lambda item: item['id'])}
    required = {'metadata', 'quality', *PACKAGES}
    if not required <= latest.keys() or any(latest[name]['conclusion'] != 'success' for name in required):
        raise ValueError('Installer build or its full quality gate did not succeed')
    if 'publish' in latest and latest['publish']['conclusion'] != 'skipped':
        raise ValueError('A preparation run must not publish a release')
    artifacts = api.get(f'actions/runs/{run["id"]}/artifacts?per_page=100')['artifacts']
    selected = [a for a in artifacts if a['name'].startswith('release-')]
    if len(selected) != len(FILES) or {a['name'] for a in selected} != set(FILES):
        raise ValueError('Missing or ambiguous platform artifacts')
    for artifact in selected:
        origin = artifact.get('workflow_run', {})
        if (artifact.get('expired') is not False or origin.get('id') != run['id']
                or origin.get('head_sha') != head
                or not re.fullmatch(r'sha256:[a-f0-9]{64}', artifact.get('digest', ''))
                or not 0 < artifact.get('size_in_bytes', 0) <= 512 * 1024 * 1024):
            raise ValueError('Expired, foreign or unverifiable installer artifact')
    return dict(source_run=run['id'], source_attempt=run['run_attempt'],
                source_artifacts=','.join(str(a['id']) for a in sorted(selected, key=lambda a:a['id'])),
                source_sha=head, tree=tree, version=version, artifacts=selected)


def find(api, tree, version, now):
    rows = api.get('actions/workflows/release.yml/runs?event=workflow_dispatch&per_page=100')['workflow_runs']
    for run in sorted(rows, key=lambda item:item['id'], reverse=True):
        try:
            return source(api, run, tree, version, now)
        except (ValueError, KeyError) as exc:
            print(f'Build {run.get("id")}: fresh build required ({exc})')
    return None


def verify_assets(folder):
    expected = set().union(*FILES.values())
    if {path.name for path in folder.iterdir()} != expected:
        raise ValueError('Installer files are missing or unexpected')
    for name in PACKAGES.values():
        checksum = (folder / (name + '.sha256')).read_text().strip()
        match = re.fullmatch(r'([a-fA-F0-9]{64})\s+\*?([^\r\n]+)', checksum)
        with (folder / name).open('rb') as stream:
            actual = hashlib.file_digest(stream, 'sha256').hexdigest()
        if not match or Path(match[2].replace('\\', '/')).name != name or match[1].lower() != actual:
            raise ValueError('Installer checksum differs: ' + name)


def restore(api, run_id, attempt, artifact_ids, tree, version, folder, now):
    proof = source(api, api.get(f'actions/runs/{run_id}'), tree, version, now)
    if proof['source_attempt'] != attempt or proof['source_artifacts'] != artifact_ids:
        raise ValueError('Installer run attempt or immutable artifact IDs changed')
    # Check archive hashes before extraction, including the DMG's exact bytes.
    # Stage all files so a partial restore can never be published.
    with tempfile.TemporaryDirectory(prefix='mailai-release-build-') as directory:
        stage = Path(directory) / 'assets'
        stage.mkdir()
        for artifact in proof['artifacts']:
            path = Path(directory) / (str(artifact['id']) + '.zip')
            api.download(artifact['id'], path)
            with path.open('rb') as stream:
                digest = 'sha256:' + hashlib.file_digest(stream, 'sha256').hexdigest()
            if digest != artifact['digest']:
                raise ValueError('Downloaded artifact archive digest differs')
            with zipfile.ZipFile(path) as archive:
                infos = archive.infolist()
                if (len(infos) != len(FILES[artifact['name']])
                        or {i.filename for i in infos} != FILES[artifact['name']]
                        or any(i.is_dir() or stat.S_ISLNK(i.external_attr >> 16)
                               or i.file_size > 512 * 1024 * 1024 for i in infos)):
                    raise ValueError('Unexpected installer archive contents')
                archive.extractall(stage)
        verify_assets(stage)
        if folder.exists() and any(folder.iterdir()):
            raise ValueError('Installer destination must be empty')
        folder.mkdir(parents=True, exist_ok=True)
        for path in stage.iterdir():
            shutil.copyfile(path, folder / path.name)
    print(f'Restored immutable build {run_id}, attempt {attempt}, tree {tree}')


def plan(api, env, root=ROOT, now=None):
    now = now or datetime.now(timezone.utc)
    version = (root / 'VERSION').read_text().strip()
    head = ci_quality.git('rev-parse', 'HEAD')
    tree = ci_quality.git('rev-parse', 'HEAD^{tree}')
    if not VERSION.fullmatch(version) or len(version) > 30:
        raise ValueError('Expected a formal desktop version')
    if f'当前版本：**v{version}**' not in (root / 'README.md').read_text():
        raise ValueError('README differs from the build version')
    if env.get('GITHUB_SHA') != head:
        raise ValueError('Workflow checkout differs from the requested build commit')
    preparation = env.get('GITHUB_EVENT_NAME') == 'workflow_dispatch'
    if preparation:
        if env.get('CANDIDATE_HEAD') != head or env.get('CANDIDATE_VERSION') != version:
            raise ValueError('Candidate moved or its version changed before preparation')
        proof = None
    else:
        if env.get('GITHUB_EVENT_NAME') != 'push' or env.get('GITHUB_REF') != 'refs/tags/v' + version:
            raise ValueError('Only explicit preparation or a matching formal tag is accepted')
        proof = find(api, tree, version, now)
    return dict(version=version, tree=tree, reuse='true' if proof else 'false',
                source_run=str(proof['source_run']) if proof else '',
                source_attempt=str(proof['source_attempt']) if proof else '',
                source_artifacts=proof['source_artifacts'] if proof else '')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('plan')
    reuse = sub.add_parser('restore')
    reuse.add_argument('--run', type=int, required=True)
    reuse.add_argument('--attempt', type=int, required=True)
    reuse.add_argument('--artifacts', required=True)
    reuse.add_argument('--tree', required=True)
    reuse.add_argument('--version', required=True)
    reuse.add_argument('--assets', type=Path, required=True)
    check = sub.add_parser('verify-assets')
    check.add_argument('--assets', type=Path, required=True)
    args = parser.parse_args()
    if args.command == 'verify-assets':
        verify_assets(args.assets)
        return
    api = GitHub(os.environ['GITHUB_REPOSITORY'])
    if args.command == 'plan':
        result = plan(api, os.environ)
        with Path(os.environ['GITHUB_OUTPUT']).open('a') as stream:
            for key, value in result.items():
                stream.write(f'{key}={value}\n')
        print(json.dumps(result))
    else:
        restore(api, args.run, args.attempt, args.artifacts, args.tree, args.version,
                args.assets, datetime.now(timezone.utc))


if __name__ == '__main__':
    main()
