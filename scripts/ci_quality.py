"""Layer development checks; reuse full evidence only for the identical Git tree.

GitHub's artifact/run APIs are the trust boundary. No PR-supplied artifact is
executed, and failed, expired, foreign-repository or incomplete evidence is never
accepted. Missing evidence means a full run, not an exemption from the gate.
"""
import argparse
from datetime import datetime, timezone, timedelta
import io
import json
import os
from pathlib import Path
import re
import subprocess
import time
import zipfile

if __package__:
    from . import ci_plan
else:
    import ci_plan

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = '.github/workflows/pr-check.yml'
ARTIFACT = 'quality-evidence-v2'
QUICK_ARTIFACT = 'quick-evidence-v2'
MAX_AGE = timedelta(days=7)
CHECKS = ci_plan.CHECKS


def coverage_digest():
    return ci_plan.select([], force_full=True)['coverage']


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True).strip()


class GitHub:
    def __init__(self, repository):
        if not re.fullmatch(r'[\w.-]+/[\w.-]+', repository):
            raise ValueError('Invalid repository')
        self.repository = repository

    def raw(self, path):
        return subprocess.check_output(
            ['gh', 'api', f'repos/{self.repository}/{path}', '--allow-escape-sequences'], timeout=30)

    def get(self, path):
        return json.loads(self.raw(path))

    def evidence(self, run, tree):
        artifacts = self.get(f'actions/runs/{run["id"]}/artifacts?per_page=100')['artifacts']
        matches = [a for a in artifacts if a['name'] == ARTIFACT + '-' + tree and not a['expired']]
        if len(matches) != 1 or matches[0]['size_in_bytes'] > 1024 * 1024:
            raise ValueError('Missing, ambiguous or oversized quality evidence')
        raw = self.raw(f'actions/artifacts/{matches[0]["id"]}/zip')
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            if archive.namelist() != ['quality.json']:
                raise ValueError('Unexpected evidence archive')
            info = archive.getinfo('quality.json')
            if info.file_size > 64 * 1024:
                raise ValueError('Oversized quality evidence')
            return json.loads(archive.read(info))


def validate_run(run, repository, now):
    if (run.get('conclusion') != 'success' or run.get('status') != 'completed'
            or run.get('path') != WORKFLOW
            or run.get('repository', {}).get('full_name') != repository
            or run.get('head_repository', {}).get('full_name') != repository
            or run.get('event') not in {'pull_request', 'push', 'workflow_dispatch'}
            or (run['event'] == 'push' and run.get('head_branch') != 'main')):
        raise ValueError('Untrusted or unsuccessful quality run')
    for key in ('created_at', 'updated_at'):
        timestamp = datetime.fromisoformat(run[key].replace('Z', '+00:00'))
        if not timedelta(0) <= now - timestamp <= MAX_AGE:
            raise ValueError('Quality evidence is stale')


def validate_full(api, run, proof, tree, now):
    validate_run(run, api.repository, now)
    if (proof.get('schema') != 2 or proof.get('mode') != 'full'
            or proof.get('repository') != api.repository
            or proof.get('run_id') != run['id']
            or proof.get('run_attempt') != run['run_attempt']
            or proof.get('source_sha') != run['head_sha']
            or proof.get('event') != run['event']
            or proof.get('tree') != tree
            or proof.get('checks') != {name: 'success' for name in CHECKS}
            or proof.get('coverage') != coverage_digest()):
        raise ValueError('Quality evidence does not cover this source')
    tested = proof.get('tested_sha', '')
    if not re.fullmatch(r'[a-f0-9]{40}', tested):
        raise ValueError('Invalid tested commit')
    commit = api.get('git/commits/' + tested)
    if commit['tree']['sha'] != tree:
        raise ValueError('Tested tree differs from the release')
    # PR checkout is normally GitHub's synthetic merge commit, not head_sha.
    if tested != run['head_sha']:
        parents = [parent['sha'] for parent in commit['parents']]
        if run['event'] != 'pull_request' or len(parents) != 2 or run['head_sha'] not in parents:
            raise ValueError('Evidence commit is unrelated to the quality run')
    return proof


def find_evidence(api, tree, *, now=None, exclude=None):
    now = now or datetime.now(timezone.utc)
    if not re.fullmatch(r'[a-f0-9]{40}', tree):
        raise ValueError('Invalid source tree')
    name = ARTIFACT + '-' + tree
    # Index evidence by the complete tree instead of downloading unrelated runs.
    artifacts = api.get(f'actions/artifacts?name={name}&per_page=100')['artifacts']
    for artifact in artifacts:
        if artifact['name'] != name or artifact['expired']:
            continue
        try:
            run_id = artifact['workflow_run']['id']
            if run_id == exclude:
                continue
            run = api.get(f'actions/runs/{run_id}')
            validate_run(run, api.repository, now)
            proof = api.evidence(run, tree)
            # Reuse only original full runs; never build an unverifiable chain.
            validate_full(api, run, proof, tree, now)
            return run['id']
        except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError,
                zipfile.BadZipFile):
            continue
    return None


def emit_output(name, value):
    value = str(value).lower() if isinstance(value, bool) else str(value)
    if os.getenv('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as stream:
            stream.write(f'{name}={value}\n')
    print(f'{name}={value}', flush=True)


def summary(message):
    print(message, flush=True)
    if os.getenv('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as stream:
            stream.write(message + '\n')


def plan(api):
    source = None
    event_name = os.getenv('GITHUB_EVENT_NAME')
    main_push = event_name == 'push' and os.getenv('GITHUB_REF') == 'refs/heads/main'
    # Integration is full unless the exact tree was already fully verified.
    if main_push:
        try:
            source = find_evidence(api, git('rev-parse', 'HEAD^{tree}'),
                                   exclude=int(os.environ['GITHUB_RUN_ID']))
        except (OSError, ValueError, KeyError, subprocess.SubprocessError):
            summary('Evidence lookup unavailable; running the complete quality gate.')
    force_full = main_push or event_name != 'pull_request'
    paths = []
    if event_name == 'pull_request':
        try:
            event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
            pr = event['pull_request']
            force_full = any(label['name'] == 'release-candidate' for label in pr.get('labels', []))
            paths = ci_plan.changed_files(pr['base']['sha'])
        except (OSError, ValueError, KeyError, subprocess.SubprocessError):
            force_full = True
            summary('Impact comparison unavailable; running the complete quality gate.')
    selected = ci_plan.select(paths, force_full=force_full)
    if source:
        selected['mode'] = 'reuse'
        selected['checks'] = {name: name == 'secret-scan' for name in CHECKS}
        selected['matrix'] = []
    image = ci_plan.browser_image()
    parallel = int(os.getenv('CI_BROWSER_PARALLEL') or '12')
    if not 1 <= parallel <= 16:
        raise ValueError('CI_BROWSER_PARALLEL must be between 1 and 16')
    emit_output('reuse', bool(source))
    emit_output('source_run', source or '')
    emit_output('mode', selected['mode'])
    emit_output('checks', json.dumps(selected['checks'], separators=(',', ':')))
    # Keep a syntactically valid matrix even when the entire job is skipped.
    ordered = ci_plan.schedule(selected['matrix'] or ci_plan.full_matrix())
    emit_output('browser_matrix', json.dumps({'include': ordered}, separators=(',', ':')))
    emit_output('browser_image', image['image'])
    emit_output('browser_version', image['playwright'])
    emit_output('browser_parallel', parallel)
    summary(f"Validation mode: **{selected['mode']}**; browser jobs: {len(selected['matrix'])}. "
            + '; '.join(selected['reasons']))
    target = ROOT / 'build/ci/plan.json'
    target.parent.mkdir(parents=True, exist_ok=True)
    selected['schedule'] = ordered if selected['matrix'] else []
    target.write_text(json.dumps(selected, indent=2) + '\n')


def record(api, needs, source=None):
    if set(needs) != {'plan', *CHECKS} or needs['plan']['result'] != 'success':
        raise ValueError('Missing quality jobs or failed plan')
    results = {name: needs[name]['result'] for name in CHECKS}
    mode = os.getenv('QUALITY_MODE', 'reuse' if source else 'full')
    required = json.loads(os.getenv('QUALITY_CHECKS') or json.dumps({name: True for name in CHECKS}))
    if mode not in {'quick', 'full', 'reuse'} or set(required) != set(CHECKS) or any(type(v) is not bool for v in required.values()):
        raise ValueError('Invalid validation plan')
    if mode == 'full' and not all(required.values()):
        raise ValueError('Full verification cannot omit a check')
    if mode == 'quick' and (not required['release-gate'] or not required['secret-scan'] or source):
        raise ValueError('Quick checks require the offline gate and fresh credential scan')
    if (mode == 'reuse') != bool(source):
        raise ValueError('Reuse requires a verified full source run')
    if mode == 'reuse':
        required = {name: name == 'secret-scan' for name in CHECKS}
    expected = {name: 'success' if required[name] else 'skipped' for name in CHECKS}
    if results != expected:
        raise ValueError('Quality jobs failed, were canceled or unexpectedly skipped: ' + json.dumps(results))
    tree = git('rev-parse', 'HEAD^{tree}')
    if source:
        run = api.get(f'actions/runs/{source}')
        validate_full(api, run, api.evidence(run, tree), tree, datetime.now(timezone.utc))
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    proof = {
        'schema': 2, 'repository': api.repository,
        'run_id': int(os.environ['GITHUB_RUN_ID']),
        'run_attempt': int(os.environ['GITHUB_RUN_ATTEMPT']),
        'event': os.environ['GITHUB_EVENT_NAME'],
        'source_sha': event.get('pull_request', {}).get('head', {}).get('sha') or os.environ['GITHUB_SHA'],
        'tested_sha': git('rev-parse', 'HEAD'), 'tree': tree,
        'mode': mode, 'source_run': source,
        'checks': results, 'coverage': coverage_digest(),
    }
    target = ROOT / 'build/quality-evidence/quality.json'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(proof, indent=2) + '\n')
    emit_output('tree', tree)
    emit_output('artifact', QUICK_ARTIFACT if mode == 'quick' else ARTIFACT)
    link = f'https://github.com/{api.repository}/actions/runs/{source}' if source else 'this run'
    summary(f'Quality gate passed for tree `{tree}`; mode: **{mode}**. '
            + (f'Full verification: {link}.' if mode != 'quick' else 'Development checks are not release evidence.'))


def wait_for_release(api, commit, timeout=1800):
    if git('rev-parse', 'HEAD') != commit:
        raise ValueError('Release checkout does not match its tag')
    tree = git('rev-parse', 'HEAD^{tree}')
    deadline = time.monotonic() + timeout
    while True:
        try:
            source = find_evidence(api, tree)
            runs = api.get('actions/workflows/pr-check.yml/runs?event=push&branch=main&per_page=30')['workflow_runs'] if not source else []
        except (OSError, subprocess.SubprocessError):
            source, runs = None, []
            print('Quality API unavailable; no verification is being bypassed.', flush=True)
        if source:
            summary(f'Release tree `{tree}` verified by https://github.com/{api.repository}/actions/runs/{source}.')
            return source
        current = next((r for r in runs if r['head_sha'] == commit), None)
        if current and current['status'] == 'completed':
            raise ValueError('Release commit has no reusable full quality evidence: ' + str(current['conclusion']))
        if time.monotonic() >= deadline:
            raise TimeoutError('Timed out waiting for verified release evidence')
        print('Waiting for full quality evidence for this source tree', flush=True)
        time.sleep(15)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['plan', 'record', 'wait'])
    parser.add_argument('--source-run', type=int)
    parser.add_argument('--commit')
    args = parser.parse_args()
    api = GitHub(os.environ['GITHUB_REPOSITORY'])
    if args.command == 'plan':
        plan(api)
    elif args.command == 'record':
        source = args.source_run or int(os.getenv('QUALITY_SOURCE_RUN') or 0) or None
        record(api, json.loads(os.environ['QUALITY_NEEDS']), source)
    else:
        wait_for_release(api, args.commit)


if __name__ == '__main__':
    main()
