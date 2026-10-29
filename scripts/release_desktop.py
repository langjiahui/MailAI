"""Plan or execute one immutable desktop release using the local gh login.

The default is read-only. --execute waits for full evidence, retries failed jobs
once, merges the frozen PR head, checks the merged tree, creates a new tag and
waits for publication and its independently verified domestic mirror.
"""
import argparse
import base64
from datetime import datetime, timezone
import http.client
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from urllib.parse import quote
import zipfile

if __package__:
    from . import ci_quality
else:
    import ci_quality

ROOT = Path(__file__).resolve().parents[1]
SHA = re.compile(r'[a-f0-9]{40}')
VERSION = re.compile(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)')
INSTALLERS = {'windows-x64': 'MailAI-Windows-x64-Setup.exe',
              'macos-arm64': 'MailAI-macOS-arm64.pkg',
              'linux-x64': 'MailAI-Linux-x64.AppImage'}


def version(value):
    if len(value) > 30 or not VERSION.fullmatch(value):
        raise ValueError('Expected a formal version without the v prefix')
    return tuple(map(int, value.split('.')))


def next_version(base, change):
    major, minor, patch = version(base)
    if change == 'major':
        major, minor, patch = major + 1, 0, 0
    elif change == 'minor':
        minor, patch = minor + 1, 0
    elif change == 'patch':
        patch += 1
    else:
        raise ValueError('A release classification is required')
    if minor >= 10 or patch >= 10:
        major, minor, patch = major + 1, 0, 0
    return f'{major}.{minor}.{patch}'


def formal_releases(api):
    return sorted((r for r in api.get('releases?per_page=100')
                   if not r['draft'] and not r['prerelease'] and r['tag_name'].startswith('v')
                   and VERSION.fullmatch(r['tag_name'][1:])),
                  key=lambda r: r['published_at'], reverse=True)


class GitHub(ci_quality.GitHub):
    def optional(self, path):
        try:
            return self.get(path)
        except subprocess.CalledProcessError as exc:
            # Only an actual 404 is absence; authorization/network errors stop.
            error = exc.stderr or b''
            if isinstance(error, bytes):
                error = error.decode(errors='replace')
            if 'HTTP 404' in error:
                return None
            raise

    def raw(self, path):
        result = subprocess.run(['gh', 'api', f'repos/{self.repository}/{path}',
                                 '--allow-escape-sequences'], capture_output=True,
                                check=True, timeout=30)
        if len(result.stdout) > 8 * 1024 * 1024:
            raise ValueError('Oversized GitHub response')
        return result.stdout

    def write(self, method, path, payload=None):
        result = subprocess.run(['gh', 'api', '--method', method,
                                 f'repos/{self.repository}/{path}', '--input', '-'],
                                input=json.dumps(payload or {}).encode(),
                                capture_output=True, check=True, timeout=30)
        return json.loads(result.stdout) if result.stdout.strip() else None

    def file(self, path, ref):
        data = self.get(f'contents/{quote(path, safe="/")}?ref={quote(ref, safe="")}')
        if data.get('encoding') != 'base64' or not 0 <= data.get('size', -1) <= 256 * 1024:
            raise ValueError('Missing or oversized release metadata')
        return base64.b64decode(data['content']).decode('utf-8')

    def asset(self, asset_id):
        result = subprocess.run(['gh', 'api', f'repos/{self.repository}/releases/assets/{asset_id}',
                                 '-H', 'Accept: application/octet-stream'], capture_output=True,
                                check=True, timeout=30)
        if len(result.stdout) > 1024 * 1024:
            raise ValueError('Oversized signed update manifest')
        return result.stdout


def tag_commit(api, tag):
    ref = api.optional('git/ref/tags/' + quote(tag, safe=''))
    if ref is None:
        return None
    obj = ref['object']
    for _ in range(5):
        if not SHA.fullmatch(obj.get('sha', '')):
            break
        if obj['type'] == 'commit':
            return obj['sha']
        if obj['type'] != 'tag':
            break
        obj = api.get('git/tags/' + obj['sha'])['object']
    raise ValueError('Invalid or excessively nested release tag')


class Coordinator:
    def __init__(self, api, *, timeout=7200, interval=15, clock=time.monotonic,
                 sleep=time.sleep, emit=None):
        self.api = api
        self.clock, self.sleep, self.interval = clock, sleep, interval
        self.started = clock()
        self.deadline = self.started + timeout
        self.emit = emit or (lambda stage, **data: print(json.dumps(
            {'time': datetime.now(timezone.utc).isoformat(timespec='seconds'),
             'stage': stage, **data}, ensure_ascii=False), flush=True))
        self.retried = {}

    def ensure_time(self, stage):
        if self.clock() >= self.deadline:
            raise TimeoutError('Timed out before ' + stage)

    def write(self, method, path, payload=None):
        self.ensure_time(path)
        return self.api.write(method, path, payload)

    def pause(self, stage):
        remaining = self.deadline - self.clock()
        if remaining <= 0:
            raise TimeoutError('Timed out waiting for ' + stage)
        self.sleep(min(self.interval, remaining))

    def head(self, plan):
        pr = self.api.get(f'pulls/{plan["pr"]}')
        if (pr['head']['sha'] != plan['head'] or pr.get('draft')
                or (pr['state'] != 'open' and not pr.get('merged'))):
            raise ValueError('PR changed or closed; review the new candidate before resuming')
        return pr

    def preflight(self, number, target, change, expected_head=None):
        version(target)
        pr = self.api.get(f'pulls/{number}')
        if (pr['head']['repo']['full_name'] != self.api.repository
                or pr['base']['repo']['full_name'] != self.api.repository
                or pr['base']['ref'] != 'main' or pr.get('draft')
                or (pr['state'] != 'open' and not pr.get('merged'))):
            raise ValueError('A ready, same-repository PR targeting main is required')
        head = pr['head']['sha']
        if not SHA.fullmatch(head) or (expected_head and expected_head != head):
            raise ValueError('Candidate head does not match the requested commit')
        tree = self.api.get('git/commits/' + head)['tree']['sha']
        if not SHA.fullmatch(tree):
            raise ValueError('Invalid candidate tree')
        formal = formal_releases(self.api)
        if not formal or version(formal[0]['tag_name'][1:]) > version(target):
            raise ValueError('No desktop baseline, or a newer version is already published')
        prior = next((r for r in formal if r['tag_name'] != 'v' + target), None)
        if prior is None:
            raise ValueError('Cannot determine the last formal desktop release')
        baseline = prior['tag_name'][1:]
        if next_version(baseline, change) != target:
            raise ValueError('Target version does not match the chosen release classification')
        if self.api.file('VERSION', head).strip() != target:
            raise ValueError('Candidate VERSION differs from the release target')
        if f'当前版本：**v{target}**' not in self.api.file('README.md', head):
            raise ValueError('Candidate README is not ready for this version')
        entries = self.api.get(f'contents/docs?ref={head}')
        records = [entry['path'] for entry in entries
                   if entry['name'].startswith(f'发布-v{target}-') and entry['name'].endswith('.md')]
        if len(records) != 1:
            raise ValueError('Exactly one release record is required')
        notes = self.api.file(records[0], head)
        fields = {'基准版本': 'v' + baseline, '变更类型': change.upper(), '目标版本': 'v' + target}
        for label, value in fields.items():
            line = re.search(r'(?m)^- ' + label + r'[：:]([^\n]+)', notes)
            if not line or not re.search(r'(?<![\w.])' + re.escape(value) + r'(?![\w.])', line[1]):
                raise ValueError('Release record does not match ' + label)
        if not re.search(r'(?m)^- 判断依据[：:]\s*\S', notes):
            raise ValueError('Release record lacks a classification reason')
        plan = dict(pr=number, head=head, tree=tree, branch=pr['head']['ref'],
                    base=pr['base']['sha'], baseline=baseline, version=target,
                    change_type=change, tag='v' + target)
        if not pr.get('merged'):
            compare = self.api.get(f'compare/{plan["base"]}...{head}')
            if compare.get('status') not in {'ahead', 'identical'} or compare.get('behind_by') != 0:
                raise ValueError('Update the PR with main before starting release verification')
        existing = tag_commit(self.api, plan['tag'])
        if existing and (not pr.get('merged') or existing != pr.get('merge_commit_sha')):
            raise ValueError('Release tag already exists for a different commit')
        self.emit('plan', **plan, merged=bool(pr.get('merged')), existing_tag=existing)
        return plan

    def runs(self, workflow, sha=None, events=(), branch=None, title=None, after=0):
        suffix = f'&head_sha={sha}' if sha else ''
        rows = self.api.get(f'actions/workflows/{workflow}/runs?per_page=100{suffix}')['workflow_runs']
        return sorted((r for r in rows if r['id'] > after
                       and r.get('path') == '.github/workflows/' + workflow
                       and r.get('head_repository', {}).get('full_name') == self.api.repository
                       and r.get('repository', {}).get('full_name') == self.api.repository
                       and (not sha or r['head_sha'] == sha)
                       and (not events or r['event'] in events)
                       and (not branch or r['head_branch'] == branch)
                       and (not title or r.get('display_title') == title)),
                      key=lambda r: r['id'], reverse=True)

    def wait(self, workflow, *, sha=None, events=(), branch=None, title=None,
             guard=None, dispatch=None, after=0, retry_guard=None):
        dispatched, last_state = False, None
        while True:
            self.ensure_time(workflow)
            if guard:
                guard()
            rows = self.runs(workflow, sha, events, branch, title, after)
            if not rows:
                if dispatch and not dispatched:
                    dispatch()
                    dispatched = True
                self.pause(workflow)
                continue
            run = rows[0]
            state = (run['id'], run['run_attempt'], run['status'], run['conclusion'])
            if state != last_state:
                self.emit('workflow', workflow=workflow, run=run['id'],
                          attempt=run['run_attempt'], status=run['status'], conclusion=run['conclusion'])
                last_state = state
            pending = self.retried.get(run['id'], 0)
            if run['run_attempt'] <= pending:
                self.pause(workflow)
                continue
            if run['status'] != 'completed':
                self.pause(workflow)
                continue
            if run['conclusion'] == 'success':
                created = datetime.fromisoformat(run['created_at'].replace('Z', '+00:00'))
                updated = datetime.fromisoformat(run['updated_at'].replace('Z', '+00:00'))
                self.emit('workflow-complete', workflow=workflow, run=run['id'],
                          attempt=run['run_attempt'],
                          seconds=max(0, round((updated - created).total_seconds())))
                return run
            if (run['conclusion'] == 'failure' and run['run_attempt'] == 1
                    and (retry_guard is None or retry_guard())):
                attempt = run['run_attempt']
                self.write('POST', f'actions/runs/{run["id"]}/rerun-failed-jobs')
                self.retried[run['id']] = attempt
                self.emit('retry-failed', run=run['id'], sha=run['head_sha'])
                self.pause(workflow)
                continue
            raise RuntimeError(f'{workflow} stopped: {run["conclusion"]}; run {run["id"]}')

    def full(self, plan):
        self.head(plan)
        source = ci_quality.find_evidence(self.api, plan['tree'])
        if source:
            return source
        dispatch = lambda: self.write('POST', 'actions/workflows/pr-check.yml/dispatches',
                                     {'ref': plan['branch']})
        run = self.wait('pr-check.yml', sha=plan['head'],
                        events={'pull_request', 'workflow_dispatch'},
                        guard=lambda: self.head(plan), dispatch=dispatch)
        try:
            ci_quality.validate_full(self.api, run, self.api.evidence(run, plan['tree']),
                                     plan['tree'], datetime.now(timezone.utc))
        except (ValueError, KeyError, zipfile.BadZipFile):
            # Quick, expired or missing proof requires a new complete run.
            # Refresh only once; invalid evidence after refresh stops publication.
            dispatch()
            run = self.wait('pr-check.yml', sha=plan['head'], events={'workflow_dispatch'},
                            after=run['id'], guard=lambda: self.head(plan))
            ci_quality.validate_full(self.api, run, self.api.evidence(run, plan['tree']),
                                     plan['tree'], datetime.now(timezone.utc))
        self.emit('full-verified', source_run=run['id'], tree=plan['tree'])
        return run['id']

    def prepare(self, plan):
        """Start private native builds before waiting for full verification.

        The dispatch pins the head/version; moving the branch before checkout
        fails metadata validation. Publication remains restricted to formal tags.
        """
        rows = self.runs('release.yml', sha=plan['head'], events={'workflow_dispatch'},
                         branch=plan['branch'])
        if not rows:
            self.write('POST', 'actions/workflows/release.yml/dispatches',
                       {'ref': plan['branch'], 'inputs': {'candidate_head': plan['head'],
                                                       'candidate_version': plan['version']}})
            self.emit('prepare-dispatched', head=plan['head'], version=plan['version'])
        else:
            self.emit('prepare-existing', run=rows[0]['id'], status=rows[0]['status'])

    def merge(self, plan):
        pr = self.head(plan)
        if not pr.get('merged'):
            current = self.api.get('branches/main')['commit']['sha']
            if current != plan['base']:
                raise ValueError('Main advanced; update the candidate and run full checks again')
            result = self.write('PUT', f'pulls/{plan["pr"]}/merge',
                                    {'sha': plan['head'], 'merge_method': 'squash',
                                     'commit_title': f'release: {plan["tag"]} (#{plan["pr"]})'})
            if not result.get('merged'):
                raise RuntimeError('GitHub did not merge the requested PR')
            merged = result['sha']
        else:
            merged = pr['merge_commit_sha']
        if not SHA.fullmatch(merged) or self.api.get('git/commits/' + merged)['tree']['sha'] != plan['tree']:
            raise ValueError('Merged source differs from the verified candidate; no tag created')
        self.emit('merged', sha=merged, tree=plan['tree'])
        return merged

    def create_tag(self, plan, merged):
        existing = tag_commit(self.api, plan['tag'])
        if existing:
            if existing != merged:
                raise ValueError('Existing tag points to another commit')
            return
        latest = formal_releases(self.api)
        if not latest or latest[0]['tag_name'] != 'v' + plan['baseline']:
            raise ValueError('Published baseline changed during verification; no tag created')
        # Create an annotated tag; never PATCH/force a tag or alter release assets.
        obj = self.write('POST', 'git/tags', {'tag': plan['tag'],
                             'message': f'MailAI {plan["tag"]}', 'object': merged, 'type': 'commit'})
        if not SHA.fullmatch(obj.get('sha', '')):
            raise ValueError('GitHub returned an invalid tag object')
        self.write('POST', 'git/refs', {'ref': 'refs/tags/' + plan['tag'], 'sha': obj['sha']})
        self.emit('tag-created', tag=plan['tag'], sha=merged)

    def public_release(self, plan):
        sys.path.insert(0, str(ROOT))
        from app.update_trust import verify
        release = self.api.get('releases/tags/' + plan['tag'])
        if release['draft'] or release['prerelease'] or release['tag_name'] != plan['tag']:
            raise ValueError('Release is not a published formal desktop version')
        assets = {a['name']: a for a in release['assets']}
        required = {'latest.json', 'latest.signed.json', 'MailAI-macOS-arm64.dmg'}
        required.update(INSTALLERS.values())
        required.update(name + '.sha256' for name in INSTALLERS.values())
        if not required <= set(assets) or any(a['state'] != 'uploaded' or a['size'] <= 0
                                               for a in assets.values()):
            raise ValueError('Published release is missing complete platform assets')
        manifest = verify(json.loads(self.api.asset(assets['latest.signed.json']['id'])))
        if json.loads(self.api.asset(assets['latest.json']['id'])) != manifest:
            raise ValueError('Plain and signed update manifests differ')
        if (manifest['version'] != plan['version'] or manifest['release_url'] != release['html_url']
                or set(manifest['assets']) != set(INSTALLERS)):
            raise ValueError('Signed manifest does not describe this release')
        for platform, name in INSTALLERS.items():
            item, asset = manifest['assets'][platform], assets[name]
            if (item['url'] != asset['browser_download_url'] or item['size'] != asset['size']
                    or asset.get('digest') != 'sha256:' + item['sha256']):
                raise ValueError('Published installer metadata differs from the signed manifest')
        self.emit('published', url=release['html_url'], version=manifest['version'])
        return manifest

    def execute(self, plan):
        self.ensure_time('release execution')
        preparing = not self.head(plan).get('merged')
        if preparing:
            self.prepare(plan)
        source = self.full(plan)
        if preparing:
            self.wait('release.yml', sha=plan['head'], events={'workflow_dispatch'},
                      branch=plan['branch'], guard=lambda: self.head(plan))
        merged = self.merge(plan)
        self.wait('pr-check.yml', sha=merged, events={'push'}, branch='main',
                  guard=lambda: self.head(plan))
        # Revalidate after integration; a quick/reused record is not the original proof.
        if not ci_quality.find_evidence(self.api, plan['tree']):
            raise ValueError('Full source evidence is no longer valid')
        self.head(plan)
        self.create_tag(plan, merged)
        self.wait('release.yml', sha=merged, events={'push'}, branch=plan['tag'],
                  retry_guard=lambda: self.api.optional('releases/tags/' + plan['tag']) is None)
        manifest = self.public_release(plan)
        sys.path.insert(0, str(ROOT))
        from app.update_mirror import read_channel
        try:
            current = read_channel()
        except (OSError, http.client.HTTPException):
            current = None
        if current != manifest:
            self.wait('atomgit-sync.yml', events={'workflow_run', 'workflow_dispatch'},
                      title='Sync AtomGit ' + plan['tag'])
            if read_channel() != manifest:
                raise ValueError('Domestic update channel differs from the official signed manifest')
        self.emit('complete', version=plan['version'], merged_sha=merged, source_run=source,
                  url=manifest['release_url'], mirror='verified',
                  elapsed_seconds=round(self.clock() - self.started))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', default=os.getenv('GITHUB_REPOSITORY', 'langjiahui/MailAI'))
    parser.add_argument('--pr', type=int, required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--change-type', choices=['patch', 'minor', 'major'], required=True)
    parser.add_argument('--head', help='Optional reviewed candidate commit SHA')
    parser.add_argument('--execute', action='store_true', help='Perform the displayed release plan')
    parser.add_argument('--timeout', type=int, default=7200)
    parser.add_argument('--poll-interval', type=int, default=15)
    args = parser.parse_args(argv)
    if args.pr <= 0 or not 1 <= args.poll_interval <= 60 or not 1 <= args.timeout <= 14400:
        parser.error('Invalid PR, polling interval or total timeout')
    if args.execute and os.getenv('GITHUB_ACTIONS') == 'true':
        parser.error('Run locally using gh auth login; Actions GITHUB_TOKEN cannot trigger tag builds')
    runner = Coordinator(GitHub(args.repository), timeout=args.timeout, interval=args.poll_interval)
    try:
        plan = runner.preflight(args.pr, args.version, args.change_type, args.head)
        if args.execute:
            runner.execute(plan)
        return 0
    except (OSError, ValueError, RuntimeError, KeyError, subprocess.SubprocessError) as exc:
        runner.emit('stopped', error=str(exc))
        return 1
    except KeyboardInterrupt:
        runner.emit('interrupted', message='Resume with the same reviewed candidate; tags are never overwritten')
        return 130


if __name__ == '__main__':
    raise SystemExit(main())
