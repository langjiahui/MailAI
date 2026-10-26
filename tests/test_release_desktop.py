"""Exercise release mutations against a fake GitHub; never publish a real tag."""
from copy import deepcopy
from datetime import datetime, timezone
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts import ci_quality, release_desktop as release
from app import update_mirror, update_trust
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

REPO = 'example/mailai'
HEAD, BASE, TREE, MERGED, TAG, OTHER = (letter * 40 for letter in 'abcdef')
NOW = datetime.now(timezone.utc).isoformat()


def run(number, workflow='pr-check.yml', *, head=HEAD, branch='codex/release',
        event='pull_request', conclusion='success', attempt=1):
    return dict(id=number, path='.github/workflows/' + workflow, event=event,
                repository={'full_name': REPO}, head_repository={'full_name': REPO},
                head_sha=head, head_branch=branch, run_attempt=attempt,
                created_at=NOW, updated_at=NOW, status='completed', conclusion=conclusion)


class FakeClock:
    def __init__(self):
        self.value = 0

    def __call__(self):
        return self.value

    def sleep(self, seconds):
        self.value += seconds


class FakeGitHub:
    repository = REPO

    def __init__(self):
        self.writes = []
        self.tagged = False
        self.main = BASE
        self.merged_tree = TREE
        self.current_run = run(42)
        self.proof_mode = 'full'
        self.retry_result = 'success'
        self.pr = dict(state='open', draft=False, merged=False, merge_commit_sha=None,
                       head={'sha': HEAD, 'ref': 'codex/release', 'repo': {'full_name': REPO}},
                       base={'sha': BASE, 'ref': 'main', 'repo': {'full_name': REPO}})
        self.files = {'VERSION': '3.7.0\n', 'README.md': '当前版本：**v3.7.0**',
                      'docs/发布-v3.7.0-2026-10-26.md':
                      '- 基准版本：v3.6.0。\n- 变更类型：MINOR。\n- 目标版本：v3.7.0。\n- 判断依据：新增兼容功能。\n'}
        self.releases = [dict(tag_name='v3.6.0', draft=False, prerelease=False, published_at=NOW)]
        self.manifest = dict(version='3.7.0', release_url=f'https://github.com/{REPO}/releases/tag/v3.7.0', assets={})
        self.assets = []
        for number, (platform, name) in enumerate(release.INSTALLERS.items(), 1):
            url = f'https://github.com/{REPO}/releases/download/v3.7.0/{name}'
            self.manifest['assets'][platform] = dict(url=url, size=100, sha256='1' * 64)
            self.assets.append(dict(name=name, id=number, size=100, digest='sha256:' + '1' * 64,
                                    browser_download_url=url, state='uploaded'))
            self.assets.append(dict(name=name + '.sha256', id=10 + number, size=80, state='uploaded'))
        self.assets.extend([dict(name=name, id=20 + n, size=100, state='uploaded') for n, name in
                            enumerate(['latest.signed.json', 'latest.json', 'MailAI-macOS-arm64.dmg'])])
        self.signing_key = Ed25519PrivateKey.generate()
        self.public_key = base64.b64encode(self.signing_key.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()

    def file(self, path, ref):
        if ref != HEAD:
            raise AssertionError(ref)
        return self.files[path]

    def optional(self, path):
        if path.startswith('git/ref/tags/'):
            return {'object': {'type': 'tag', 'sha': TAG}} if self.tagged else None
        if path.startswith('releases/tags/'):
            return self.get(path) if self.tagged else None
        raise AssertionError(path)

    def get(self, path):
        if path.startswith('pulls/'):
            return deepcopy(self.pr)
        if path == 'releases?per_page=100':
            return self.releases
        if path == 'contents/docs?ref=' + HEAD:
            return [dict(name=Path(name).name, path=name) for name in self.files if name.startswith('docs/')]
        if path.startswith('compare/'):
            return {'status': 'ahead', 'behind_by': 0}
        if path == 'branches/main':
            return {'commit': {'sha': self.main}}
        if path.startswith('git/commits/'):
            sha = path.rsplit('/', 1)[1]
            return {'tree': {'sha': self.merged_tree if sha == MERGED else TREE}, 'parents': []}
        if path == 'git/tags/' + TAG:
            return {'object': {'type': 'commit', 'sha': MERGED}}
        if path.startswith('actions/artifacts?'):
            return {'artifacts': [{'name': ci_quality.ARTIFACT + '-' + TREE, 'expired': False,
                                   'workflow_run': {'id': 42}}]} if self.proof_mode == 'full' else {'artifacts': []}
        if path.startswith('actions/workflows/pr-check.yml/runs?'):
            if 'head_sha=' + MERGED in path:
                return {'workflow_runs': [run(44, head=MERGED, branch='main', event='push')]}
            return {'workflow_runs': [self.current_run]}
        if path.startswith('actions/workflows/release.yml/runs?'):
            return {'workflow_runs': [run(45, 'release.yml', head=MERGED, branch='v3.7.0', event='push')]}
        if path.startswith('actions/workflows/atomgit-sync.yml/runs?'):
            mirror = run(46, 'atomgit-sync.yml', head=OTHER, branch='main', event='workflow_run')
            mirror['display_title'] = 'Sync AtomGit v3.7.0'
            wrong = dict(mirror, id=47, display_title='Sync AtomGit v9.0.0')
            return {'workflow_runs': [wrong, mirror]}
        if path.startswith('actions/runs/') and '/artifacts?' in path:
            prefix = ci_quality.QUICK_ARTIFACT if self.proof_mode == 'quick' else ci_quality.ARTIFACT
            return {'artifacts': [{'name': prefix + '-' + TREE}]}
        if path == 'actions/runs/42':
            return self.current_run
        if path.startswith('releases/tags/'):
            return dict(tag_name='v3.7.0', draft=False, prerelease=False, assets=self.assets,
                        html_url=self.manifest['release_url'])
        raise AssertionError(path)

    def evidence(self, run, tree):
        return dict(schema=2, repository=REPO, run_id=run['id'], run_attempt=run['run_attempt'],
                    source_sha=HEAD, tested_sha=HEAD, tree=TREE, event=run['event'],
                    mode=self.proof_mode, coverage=ci_quality.coverage_digest(),
                    checks={name: 'success' for name in ci_quality.CHECKS})

    def write(self, method, path, payload=None):
        self.writes.append((method, path, payload))
        if path.endswith('/rerun-failed-jobs'):
            self.current_run.update(run_attempt=2, conclusion=self.retry_result)
            return None
        if path.endswith('/dispatches'):
            self.proof_mode = 'full'
            self.current_run = run(43, event='workflow_dispatch')
            return None
        if path.endswith('/merge'):
            self.pr.update(merged=True, state='closed', merge_commit_sha=MERGED)
            self.main = MERGED
            return {'merged': True, 'sha': MERGED}
        if path == 'git/tags':
            return {'sha': TAG}
        if path == 'git/refs':
            self.tagged = True
            return {'ref': payload['ref']}
        raise AssertionError(path)

    def asset(self, asset_id):
        if next(a['name'] for a in self.assets if a['id']==asset_id)=='latest.json':
            return json.dumps(self.manifest).encode()
        envelope = {'algorithm': 'ed25519', 'manifest': self.manifest,
                    'signature': base64.b64encode(self.signing_key.sign(
                        update_trust.canonical(self.manifest))).decode()}
        return json.dumps(envelope).encode()


class CoordinatorTest(unittest.TestCase):
    def setUp(self):
        self.api, self.clock, self.events = FakeGitHub(), FakeClock(), []
        self.runner = release.Coordinator(self.api, timeout=5, interval=1,
                    clock=self.clock, sleep=self.clock.sleep,
                    emit=lambda stage, **data: self.events.append((stage, data)))

    def plan(self):
        return self.runner.preflight(12, '3.7.0', 'minor', HEAD)

    def execute(self, plan):
        with patch.object(update_trust, 'PUBLIC_KEY', self.api.public_key), \
                patch.object(update_mirror, 'read_channel', side_effect=[{'version':'3.6.0'},self.api.manifest]):
            self.runner.execute(plan)

    def test_default_only_plans_and_requires_explicit_execution(self):
        with patch.object(release, 'GitHub', return_value=self.api):
            self.assertEqual(release.main(['--pr', '12', '--version', '3.7.0', '--change-type', 'minor']), 0)
        self.assertEqual(self.api.writes, [])

    def test_complete_release_uses_verified_tree_and_checks_real_signatures(self):
        self.execute(self.plan())
        self.assertEqual([(m, p) for m, p, _ in self.api.writes],
                         [('PUT', 'pulls/12/merge'), ('POST', 'git/tags'), ('POST', 'git/refs')])
        self.assertEqual(self.api.writes[0][2]['sha'], HEAD)
        self.assertEqual(self.api.writes[1][2]['object'], MERGED)
        self.assertEqual(self.api.writes[2][2]['ref'], 'refs/tags/v3.7.0')
        self.assertEqual(self.events[-1][0], 'complete')

    def test_fork_draft_old_base_wrong_version_and_missing_reason_stop_before_writes(self):
        for case in ['fork', 'draft', 'head', 'version', 'readme', 'reason', 'classification', 'record']:
            self.setUp()
            if case == 'fork':self.api.pr['head']['repo']['full_name'] = 'fork/repo'
            if case == 'draft':self.api.pr['draft'] = True
            if case == 'head':self.api.pr['head']['sha'] = OTHER
            if case == 'version':self.api.files['VERSION'] = '3.6.0'
            if case == 'readme':self.api.files['README.md'] = ''
            key='docs/发布-v3.7.0-2026-10-26.md'
            if case == 'reason':self.api.files[key] = self.api.files[key].split('- 判断依据')[0]
            if case == 'classification':self.api.files[key] = self.api.files[key].replace('MINOR', 'PATCH')
            if case == 'record':del self.api.files[key]
            with self.subTest(case=case), self.assertRaises(ValueError):self.plan()
            self.assertEqual(self.api.writes, [])
        self.setUp()
        original=self.api.get
        with patch.object(self.api,'get',side_effect=lambda p: {'status':'diverged','behind_by':1} if p.startswith('compare/') else original(p)):
            with self.assertRaises(ValueError):self.plan()

    def test_moved_head_or_main_and_changed_merged_tree_never_create_a_tag(self):
        plan=self.plan();self.api.pr['head']['sha']=OTHER
        with self.assertRaises(ValueError):self.execute(plan)
        self.assertEqual(self.api.writes, [])
        self.setUp();plan=self.plan();self.api.main=OTHER
        with self.assertRaises(ValueError):self.execute(plan)
        self.assertEqual(self.api.writes, [])
        self.setUp();plan=self.plan();self.api.merged_tree=OTHER
        with self.assertRaises(ValueError):self.execute(plan)
        self.assertFalse(any(path.startswith('git/') for _,path,_ in self.api.writes))

    def test_one_failed_only_retry_then_persistent_failure_stops(self):
        self.api.proof_mode='missing';self.api.current_run['conclusion']='failure'
        self.runner.wait('pr-check.yml',sha=HEAD)
        self.assertEqual([(m,p) for m,p,_ in self.api.writes],
                         [('POST','actions/runs/42/rerun-failed-jobs')])
        self.setUp();self.api.current_run['conclusion']='failure';self.api.retry_result='failure'
        with self.assertRaises(RuntimeError):self.runner.wait('pr-check.yml',sha=HEAD)
        self.assertEqual(len(self.api.writes),1)

    def test_cancellation_timeout_and_published_release_failures_are_not_retried(self):
        self.api.current_run['conclusion']='cancelled'
        with self.assertRaises(RuntimeError):self.runner.wait('pr-check.yml',sha=HEAD)
        self.assertEqual(self.api.writes,[])
        self.api.current_run.update(status='in_progress',conclusion=None)
        with self.assertRaises(TimeoutError):self.runner.wait('pr-check.yml',sha=HEAD)
        self.assertLessEqual(self.clock.value,5)
        self.assertEqual(self.api.writes,[])
        self.setUp();self.api.current_run['conclusion']='failure'
        with self.assertRaises(RuntimeError):self.runner.wait('pr-check.yml',sha=HEAD,retry_guard=lambda:False)
        self.assertEqual(self.api.writes,[])

    def test_quick_success_dispatches_full_and_missing_evidence_never_merges(self):
        self.api.proof_mode='quick'
        self.assertEqual(self.runner.full(self.plan()),43)
        self.assertEqual(self.api.writes[0][1],'actions/workflows/pr-check.yml/dispatches')
        self.setUp();self.api.proof_mode='missing'
        original=self.api.evidence
        with patch.object(self.api,'evidence',side_effect=lambda run,tree: dict(original(run,tree),checks={})):
            with self.assertRaises(ValueError):self.execute(self.plan())
        self.assertFalse(any(method=='PUT' for method,_,_ in self.api.writes))

    def test_expired_coordinator_cannot_merge_an_already_verified_candidate(self):
        plan=self.plan();self.clock.value=6
        with self.assertRaises(TimeoutError):self.execute(plan)
        self.assertEqual(self.api.writes,[])

    def test_resume_never_overwrites_a_tag_and_conflicts_stop(self):
        self.api.pr.update(merged=True,state='closed',merge_commit_sha=MERGED)
        self.api.main=MERGED;self.api.tagged=True
        self.execute(self.plan())
        self.assertEqual(self.api.writes,[])
        self.setUp();self.api.tagged=True
        with self.assertRaises(ValueError):self.plan()
        self.assertEqual(self.api.writes,[])
        self.setUp();plan=self.plan()
        with patch.object(release,'tag_commit',return_value=OTHER):
            with self.assertRaises(ValueError):self.runner.create_tag(plan,MERGED)
        self.assertEqual(self.api.writes,[])

    def test_new_published_baseline_blocks_tag_creation(self):
        plan=self.plan();self.api.releases.insert(0,dict(tag_name='v3.6.1',draft=False,
                                   prerelease=False,published_at='2099-01-01T00:00:00Z'))
        with self.assertRaises(ValueError):self.runner.create_tag(plan,MERGED)
        self.assertEqual(self.api.writes,[])

    def test_signed_manifest_rejects_changed_sizes_missing_assets_and_wrong_signer(self):
        plan=self.plan()
        with self.assertRaises(ValueError):self.runner.public_release(plan)
        with patch.object(update_trust,'PUBLIC_KEY',self.api.public_key):
            self.api.assets[0]['size']+=1
            with self.assertRaises(ValueError):self.runner.public_release(plan)
            self.api.assets[0]['size']-=1;self.api.assets.pop()
            with self.assertRaises(ValueError):self.runner.public_release(plan)

    def test_domestic_channel_must_match_the_official_signed_manifest(self):
        with patch.object(update_trust,'PUBLIC_KEY',self.api.public_key), \
                patch.object(update_mirror,'read_channel',return_value={'version':'3.6.0'}):
            with self.assertRaises(ValueError):self.runner.execute(self.plan())
        self.assertNotEqual(self.events[-1][0],'complete')


class VersionAndTransportTest(unittest.TestCase):
    def test_actions_token_cannot_silently_create_a_tag_without_triggering_builds(self):
        with patch.dict(os.environ,{'GITHUB_ACTIONS':'true'}),patch.object(release,'GitHub') as api:
            with self.assertRaises(SystemExit) as stopped:
                release.main(['--pr','12','--version','3.7.0','--change-type','minor','--execute'])
        self.assertEqual(stopped.exception.code,2)
        api.assert_not_called()

    def test_independent_desktop_version_classification_and_carry(self):
        for base,change,target in [('3.6.0','patch','3.6.1'),('3.6.0','minor','3.7.0'),
                                   ('3.6.0','major','4.0.0'),('3.9.4','minor','4.0.0'),
                                   ('3.4.9','patch','4.0.0')]:
            self.assertEqual(release.next_version(base,change),target)
        for value in ['v3.6.0','3.6','03.6.0','3.6.0-beta.1','../3.6.0']:
            with self.assertRaises(ValueError):release.version(value)

    def test_only_404_is_treated_as_an_absent_resource(self):
        api=release.GitHub(REPO)
        for status in [404,403,500]:
            error=subprocess.CalledProcessError(1,['gh'],stderr=f'gh: error (HTTP {status})'.encode())
            with patch.object(api,'get',side_effect=error):
                if status==404:self.assertIsNone(api.optional('git/ref/tags/v3.7.0'))
                else:
                    with self.assertRaises(subprocess.CalledProcessError):api.optional('git/ref/tags/v3.7.0')

    def test_http_mutations_use_json_stdin_instead_of_shell_interpolation(self):
        api=release.GitHub(REPO)
        payload={'commit_title':'line one\n$(not-a-command) `literal`'}
        with patch.object(subprocess,'run',return_value=subprocess.CompletedProcess([],0,stdout=b'{"merged":true}')) as call:
            self.assertTrue(api.write('PUT','pulls/12/merge',payload)['merged'])
        args,kwargs=call.call_args
        self.assertIsInstance(args[0],list)
        self.assertEqual(json.loads(kwargs['input']),payload)
        self.assertNotIn('shell',kwargs)


if __name__ == '__main__':
    unittest.main()
