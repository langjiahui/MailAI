"""Quality evidence must fail closed; partitioning must conserve browser coverage."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts import ci_browser, ci_mirror, ci_quality as quality

NOW = datetime.now(timezone.utc)
REPO = 'example/mailai'
TREE, SHA, HEAD = 'a' * 40, 'b' * 40, 'c' * 40


def run_record():
    return dict(id=42, run_attempt=1, path=quality.WORKFLOW, event='pull_request',
                head_sha=HEAD, repository={'full_name': REPO}, head_repository={'full_name': REPO},
                head_branch='codex/pipeline', status='completed', conclusion='success',
                created_at=NOW.isoformat(), updated_at=NOW.isoformat())


def evidence():
    return dict(schema=1, repository=REPO, run_id=42, run_attempt=1, source_sha=HEAD,
                tested_sha=SHA, tree=TREE, event='pull_request', mode='full',
                checks={name: 'success' for name in quality.CHECKS})


class FakeGitHub:
    repository = REPO

    def __init__(self):
        self.run = run_record()
        self.proof = evidence()
        self.commit = {'tree': {'sha': TREE}, 'parents': [{'sha': HEAD}, {'sha': 'd' * 40}]}

    def get(self, path):
        if path.startswith('git/commits/'):
            return self.commit
        if path.startswith('actions/workflows/'):
            return {'workflow_runs': [self.run]}
        if path.startswith('actions/artifacts?'):
            return {'artifacts':[{'name':quality.ARTIFACT+'-'+TREE,'expired':False,'workflow_run':{'id':42}}]}
        if path.startswith('actions/runs/'):
            return self.run
        raise AssertionError(path)

    def evidence(self, run, tree):
        return self.proof


class EvidenceTest(unittest.TestCase):
    def test_identical_tested_merge_tree_is_accepted(self):
        api = FakeGitHub()
        self.assertEqual(quality.find_evidence(api, TREE, now=NOW), 42)
        self.assertIsNone(quality.find_evidence(api, TREE, now=NOW, exclude=42))

    def test_untrusted_failed_stale_and_other_workflow_runs_are_rejected(self):
        variants = [
            {'conclusion': 'failure'}, {'conclusion': 'cancelled'}, {'status': 'in_progress'},
            {'path': '.github/workflows/other.yml'}, {'event': 'workflow_dispatch'},
            {'event': 'push', 'head_branch': 'codex/unchecked'},
            {'repository': {'full_name': 'other/repo'}},
            {'head_repository': {'full_name': 'fork/repo'}},
            {'updated_at': (NOW - timedelta(days=8)).isoformat()},
            {'created_at': (NOW - timedelta(days=8)).isoformat()},
            {'updated_at': (NOW + timedelta(days=1)).isoformat()},
        ]
        for changes in variants:
            with self.subTest(changes=changes):
                api = FakeGitHub(); api.run.update(changes)
                self.assertIsNone(quality.find_evidence(api, TREE, now=NOW))

    def test_evidence_cannot_substitute_a_different_tree_run_or_attempt(self):
        for changes in [dict(tree='d'*40), dict(run_id=99), dict(run_attempt=2),
                        dict(source_sha='d'*40), dict(tested_sha='invalid'), dict(repository='fork/repo'),
                        dict(mode='reuse'), dict(event='push'), dict(schema=2),
                        dict(checks={}), dict(checks={name:'skipped' for name in quality.CHECKS})]:
            with self.subTest(changes=changes):
                api = FakeGitHub(); api.proof.update(changes)
                self.assertIsNone(quality.find_evidence(api, TREE, now=NOW))
        api = FakeGitHub(); api.commit['tree']['sha'] = 'd'*40
        self.assertIsNone(quality.find_evidence(api, TREE, now=NOW))
        api = FakeGitHub(); api.commit['parents'] = [{'sha': 'd'*40}]
        self.assertIsNone(quality.find_evidence(api, TREE, now=NOW))

    def test_missing_or_unreadable_evidence_falls_back_to_full_checks(self):
        api = FakeGitHub()
        with patch.object(api, 'evidence', side_effect=ValueError('missing artifact')):
            self.assertIsNone(quality.find_evidence(api, TREE, now=NOW))

    def test_artifacts_are_bounded_data_not_extracted_or_executed(self):
        api = quality.GitHub(REPO)
        def packet(name, data):
            out=io.BytesIO()
            with zipfile.ZipFile(out, 'w') as z:z.writestr(name, data)
            return out.getvalue()
        listing={'artifacts':[{'name':quality.ARTIFACT+'-'+TREE,'expired':False,'size_in_bytes':100,'id':1}]}
        with patch.object(api, 'get', return_value=listing), patch.object(api, 'raw', return_value=packet('quality.json',json.dumps(evidence()))):
            self.assertEqual(api.evidence(run_record(),TREE),evidence())
        for name,data in [('../quality.json','{}'),('quality.json','x'*65537)]:
            with patch.object(api,'get',return_value=listing),patch.object(api,'raw',return_value=packet(name,data)):
                with self.assertRaises(ValueError):api.evidence(run_record(),TREE)
        for changes in [{'expired':True},{'size_in_bytes':2*1024*1024}]:
            invalid=deepcopy(listing);invalid['artifacts'][0].update(changes)
            with patch.object(api,'get',return_value=invalid):
                with self.assertRaises(ValueError):api.evidence(run_record(),TREE)

    def test_aggregate_requires_every_job_and_never_approves_partial_success(self):
        needs={name:{'result':'success'} for name in ['plan',*quality.CHECKS]}
        for state in ['failure','cancelled','skipped']:
            bad=deepcopy(needs);bad['browser-test']['result']=state
            with self.subTest(state=state),self.assertRaises(ValueError):quality.record(FakeGitHub(),bad)
        bad=deepcopy(needs);del bad['responsive-ui-browser']
        with self.assertRaises(ValueError):quality.record(FakeGitHub(),bad)

    def test_successful_full_and_reused_records_bind_the_actual_checkout(self):
        needs={name:{'result':'success'} for name in ['plan',*quality.CHECKS]}
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);event=root/'event.json'
            event.write_text(json.dumps({'pull_request':{'head':{'sha':HEAD}}}))
            env={'GITHUB_EVENT_PATH':str(event),'GITHUB_EVENT_NAME':'pull_request',
                 'GITHUB_RUN_ID':'99','GITHUB_RUN_ATTEMPT':'1','GITHUB_SHA':SHA}
            with patch.dict(os.environ,env),patch.object(quality,'ROOT',root),patch.object(quality,'git',side_effect=[TREE,SHA]),patch.object(quality,'summary'):
                quality.record(FakeGitHub(),needs)
            proof=json.loads((root/'build/quality-evidence/quality.json').read_text())
            self.assertEqual(proof['tree'],TREE);self.assertEqual(proof['tested_sha'],SHA)
            self.assertEqual(proof['source_sha'],HEAD);self.assertEqual(proof['mode'],'full')
            for name in quality.CHECKS:
                if name!='secret-scan':needs[name]['result']='skipped'
            event.write_text('{}');env['GITHUB_EVENT_NAME']='push'
            with patch.dict(os.environ,env),patch.object(quality,'ROOT',root),patch.object(quality,'git',side_effect=[TREE,SHA]),patch.object(quality,'summary'):
                quality.record(FakeGitHub(),needs,source=42)
            proof=json.loads((root/'build/quality-evidence/quality.json').read_text())
            self.assertEqual(proof['mode'],'reuse');self.assertEqual(proof['source_run'],42)
            self.assertEqual(proof['checks']['secret-scan'],'success')
            # A skipped scan cannot be laundered through another run's evidence.
            needs['secret-scan']['result']='skipped'
            with self.assertRaises(ValueError):quality.record(FakeGitHub(),needs,source=42)

    def test_release_accepts_verified_tree_but_not_an_unverified_successful_run(self):
        api=FakeGitHub()
        with patch.object(quality,'git',side_effect=[SHA,TREE]),patch.object(quality,'summary'):
            self.assertEqual(quality.wait_for_release(api,SHA,timeout=0),42)
        api.proof['checks']={}
        api.run.update(event='push',head_branch='main',head_sha=SHA)
        with patch.object(quality,'git',side_effect=[SHA,TREE]),self.assertRaises(ValueError):
            quality.wait_for_release(api,SHA,timeout=0)
        with patch.object(quality,'git',return_value=HEAD),self.assertRaises(ValueError):
            quality.wait_for_release(api,SHA,timeout=0)

    def test_pr_plan_always_runs_full_matrix_and_lookup_errors_do_not_skip(self):
        env={'GITHUB_EVENT_NAME':'pull_request','GITHUB_REF':'refs/pull/1/merge'}
        with patch.dict(os.environ,env),patch.object(quality,'find_evidence') as lookup,patch.object(quality,'emit_output') as output:
            quality.plan(FakeGitHub());lookup.assert_not_called()
            self.assertIn(unittest.mock.call('reuse',False),output.call_args_list)
        env.update(GITHUB_EVENT_NAME='push',GITHUB_REF='refs/heads/main',GITHUB_RUN_ID='99')
        with patch.dict(os.environ,env),patch.object(quality,'find_evidence',side_effect=OSError('API unavailable')),patch.object(quality,'emit_output') as output:
            quality.plan(FakeGitHub())
            self.assertIn(unittest.mock.call('reuse',False),output.call_args_list)


class PartitionTest(unittest.TestCase):
    def test_every_previous_browser_invocation_remains_covered(self):
        suites=json.loads(ci_browser.SUITES.read_text())
        before=json.loads((ROOT/'.github/ci/browser-coverage.json').read_text())
        key=lambda test:json.dumps(test,sort_keys=True)
        after=[test for phases in suites.values() for phase in phases for test in phase['tests']]
        self.assertEqual(set(map(key,before)),set(map(key,after)))
        # Two identical self-contained transparency invocations were duplicated.
        self.assertEqual(len(before)-len(after),2)
        for test in after:self.assertTrue((ROOT/test['file']).is_file(),test)

    def test_all_groups_are_scheduled_and_both_browsers_cover_every_dialog_shard(self):
        jobs=json.loads((ROOT/'.github/ci/browser-jobs.json').read_text())
        scheduled={'interaction','assistant-workspace'}
        for matrix in jobs.values():
            scheduled.update(matrix.get('suite',[]))
            scheduled.update(row['suite'] for row in matrix.get('include',[]))
        self.assertEqual(scheduled,set(json.loads(ci_browser.SUITES.read_text())))
        for browser in ['chromium','webkit']:
            rows=[r for r in jobs['responsive_matrix']['include'] if r['browser']==browser]
            self.assertEqual({r['shard'] for r in rows if r['suite']=='responsive-dialogs'},{'1/3','2/3','3/3'})
            self.assertEqual(sum(r['suite']=='responsive-settings' for r in rows),1)

    @unittest.skipUnless(shutil.which('node'), 'Node required for browser shard contract')
    def test_dialog_partitions_preserve_all_cases_and_reject_empty_or_invalid_shards(self):
        source="""
        const assert=require('node:assert/strict');
        const {partition}=require('./tests/helpers/ci-shard.cjs');
        const cases=require('./tests/helpers/home-dialog-cases.cjs');
        const groups=[1,2,3].map(i=>partition(cases,`${i}/3`));
        assert(groups.every(group=>group.length>0));
        assert.deepEqual(groups.flat().map(row=>row[0]).sort(),cases.map(row=>row[0]).sort());
        assert.equal(new Set(groups.flat().map(row=>row[0])).size,cases.length);
        for(const value of ['0/3','4/3','1/99','bad','1/0','1.5/3']) assert.throws(()=>partition(cases,value));
        assert.equal(partition(cases,''),cases);
        """
        subprocess.run(['node','-e',source],cwd=ROOT,check=True)

    @unittest.skipUnless(os.name=='posix','Linux/macOS process groups')
    def test_fixture_cleanup_releases_processes_without_unbounded_waits(self):
        process=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'],start_new_session=True)
        ci_browser.stop(process)
        self.assertIsNotNone(process.poll())
        ci_browser.stop(process)


class MirrorTriggerTest(unittest.TestCase):
    def event(self):
        return {'workflow_run':{'conclusion':'success','event':'push','path':'.github/workflows/release.yml',
             'head_repository':{'full_name':REPO},'head_branch':'v3.0.0','head_sha':SHA}}

    def api(self,path):
        if path.startswith('releases/tags/'):
            return {'draft':False,'prerelease':False,'tag_name':'v3.0.0'}
        if path.startswith('git/ref/'):
            return {'object':{'type':'commit','sha':SHA}}
        raise AssertionError(path)

    def test_only_successfully_published_immutable_tags_auto_sync(self):
        self.assertEqual(ci_mirror.resolve('workflow_run',self.event(),REPO,self.api),'v3.0.0')
        for changes in [{'conclusion':'failure'},{'event':'pull_request'}, {'path':quality.WORKFLOW},
                        {'head_repository':{'full_name':'fork/repo'}},{'head_sha':HEAD},{'head_branch':'main'},
                        {'head_branch':'v3.0.0; echo unsafe'}]:
            event=self.event();event['workflow_run'].update(changes)
            with self.subTest(changes=changes),self.assertRaises(ValueError):
                ci_mirror.resolve('workflow_run',event,REPO,self.api)

    def test_manual_retry_rejects_drafts_prereleases_and_changed_tags(self):
        event={'inputs':{'tag':'v3.0.0'}}
        self.assertEqual(ci_mirror.resolve('workflow_dispatch',event,REPO,self.api),'v3.0.0')
        for key in ['draft','prerelease']:
            def api(path,key=key):
                result=self.api(path)
                if path.startswith('releases/'):result[key]=True
                return result
            with self.assertRaises(ValueError):ci_mirror.resolve('workflow_dispatch',event,REPO,api)


if __name__ == '__main__':
    unittest.main()
