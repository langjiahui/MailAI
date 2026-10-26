"""Quality evidence must fail closed; partitioning must conserve browser coverage."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts import ci_browser, ci_browser_timings, ci_mirror, ci_plan, ci_quality as quality

NOW = datetime.now(timezone.utc)
REPO = 'example/mailai'
TREE, SHA, HEAD = 'a' * 40, 'b' * 40, 'c' * 40


def run_record():
    return dict(id=42, run_attempt=1, path=quality.WORKFLOW, event='pull_request',
                head_sha=HEAD, repository={'full_name': REPO}, head_repository={'full_name': REPO},
                head_branch='codex/pipeline', status='completed', conclusion='success',
                created_at=NOW.isoformat(), updated_at=NOW.isoformat())


def evidence():
    return dict(schema=2, repository=REPO, run_id=42, run_attempt=1, source_sha=HEAD,
                tested_sha=SHA, tree=TREE, event='pull_request', mode='full',
                coverage=quality.coverage_digest(),
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
            {'path': '.github/workflows/other.yml'}, {'event': 'pull_request_target'},
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
                        dict(mode='reuse'), dict(mode='quick'), dict(event='push'), dict(schema=1),
                        dict(coverage='0'*64),
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
        bad=deepcopy(needs);del bad['browser-test']
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

    def test_unreadable_impact_and_lookup_errors_fall_back_to_full_checks(self):
        env={'GITHUB_EVENT_NAME':'pull_request','GITHUB_REF':'refs/pull/1/merge'}
        with patch.dict(os.environ,env),patch.object(quality,'find_evidence') as lookup,patch.object(quality,'emit_output') as output:
            quality.plan(FakeGitHub());lookup.assert_not_called()
            self.assertIn(unittest.mock.call('reuse',False),output.call_args_list)
        env.update(GITHUB_EVENT_NAME='push',GITHUB_REF='refs/heads/main',GITHUB_RUN_ID='99')
        with patch.dict(os.environ,env),patch.object(quality,'find_evidence',side_effect=OSError('API unavailable')),patch.object(quality,'emit_output') as output:
            quality.plan(FakeGitHub())
            self.assertIn(unittest.mock.call('reuse',False),output.call_args_list)

    def test_manual_full_verification_is_bound_to_its_exact_checkout(self):
        api=FakeGitHub()
        api.run.update(event='workflow_dispatch',head_sha=SHA)
        api.proof.update(event='workflow_dispatch',source_sha=SHA)
        self.assertEqual(quality.find_evidence(api,TREE,now=NOW),42)
        api.proof['mode']='quick'
        self.assertIsNone(quality.find_evidence(api,TREE,now=NOW))

    def test_pr_plan_emits_only_the_selected_jobs_and_dispatch_is_full(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);event=root/'event.json'
            event.write_text(json.dumps({'pull_request':{'base':{'sha':SHA},'labels':[]}}))
            env={'GITHUB_EVENT_NAME':'pull_request','GITHUB_EVENT_PATH':str(event)}
            with patch.dict(os.environ,env),patch.object(quality,'ROOT',root),patch.object(ci_plan,'changed_files',return_value=['app/web/static/todo-center.css']),patch.object(quality,'emit_output') as output,patch.object(quality,'summary'):
                quality.plan(FakeGitHub())
            values={call.args[0]:call.args[1] for call in output.call_args_list}
            self.assertEqual(values['mode'],'quick')
            self.assertTrue(json.loads(values['checks'])['browser-test'])
            self.assertFalse(json.loads(values['checks'])['native-scrollbar-macos'])
            self.assertLess(len(json.loads(values['browser_matrix'])['include']),len(ci_plan.full_matrix()))
            with patch.dict(os.environ,{**env,'GITHUB_EVENT_NAME':'workflow_dispatch'}),patch.object(quality,'ROOT',root),patch.object(quality,'emit_output') as output,patch.object(quality,'summary'):
                quality.plan(FakeGitHub())
            values={call.args[0]:call.args[1] for call in output.call_args_list}
            self.assertEqual(values['mode'],'full')
            self.assertTrue(all(json.loads(values['checks']).values()))
            self.assertEqual(json.loads(values['browser_matrix'])['include'],ci_plan.schedule(ci_plan.full_matrix()))

    def test_quick_checks_cannot_be_reused_or_hide_a_failed_selected_job(self):
        required={name:name in {'release-gate','secret-scan','browser-test'} for name in quality.CHECKS}
        needs={'plan':{'result':'success'},**{name:{'result':'success' if selected else 'skipped'} for name,selected in required.items()}}
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);event=root/'event.json';event.write_text(json.dumps({'pull_request':{'head':{'sha':HEAD}}}))
            env={'GITHUB_EVENT_PATH':str(event),'GITHUB_EVENT_NAME':'pull_request',
                 'GITHUB_RUN_ID':'99','GITHUB_RUN_ATTEMPT':'1','GITHUB_SHA':SHA,
                 'QUALITY_MODE':'quick','QUALITY_CHECKS':json.dumps(required)}
            with patch.dict(os.environ,env),patch.object(quality,'ROOT',root),patch.object(quality,'git',side_effect=[TREE,SHA]),patch.object(quality,'summary'),patch.object(quality,'emit_output') as output:
                quality.record(FakeGitHub(),needs)
                self.assertIn(unittest.mock.call('artifact',quality.QUICK_ARTIFACT),output.call_args_list)
            proof=json.loads((root/'build/quality-evidence/quality.json').read_text())
            self.assertEqual(proof['mode'],'quick')
            api=FakeGitHub();api.proof=proof
            self.assertIsNone(quality.find_evidence(api,TREE,now=NOW))
            bad=deepcopy(needs);bad['browser-test']['result']='failure'
            with patch.dict(os.environ,env),self.assertRaises(ValueError):quality.record(FakeGitHub(),bad)
            with patch.dict(os.environ,{**env,'QUALITY_MODE':'full'}),self.assertRaises(ValueError):quality.record(FakeGitHub(),needs)


class ImpactPlanTest(unittest.TestCase):
    def test_todo_changes_include_both_browsers_and_cross_page_interactions(self):
        result=ci_plan.select(['app/web/static/todo-center.css'])
        self.assertEqual(result['mode'],'quick')
        suites={row['suite'] for row in result['matrix']}
        self.assertTrue({'todos','task-workspace','dates-motion','interaction','responsive-dialogs'}<=suites)
        self.assertNotIn('server-cleanup',suites)
        self.assertFalse(result['checks']['native-notifications-windows'])
        for suite in ['interaction','responsive-dialogs']:
            self.assertEqual({row['browser'] for row in result['matrix'] if row['suite']==suite},{'chromium','webkit'})

    def test_unknown_common_dependency_and_release_changes_are_full(self):
        for path in ['app/web/static/app.js','app/web/static/theme.css','app/new_unknown.py',
                     'tests/helpers/new_helper.cjs','.github/workflows/pr-check.yml',
                     'scripts/ci_plan.py','package-lock.json','requirements.txt','VERSION']:
            with self.subTest(path=path):
                result=ci_plan.select([path])
                self.assertEqual(result['mode'],'full')
                self.assertTrue(all(result['checks'].values()))
                self.assertEqual(result['matrix'],ci_plan.full_matrix())

    def test_docs_and_mobile_keep_basics_without_unrelated_web_tests(self):
        for paths in [['docs/usage.md'],['mobile/android/app/build.gradle.kts'],[]]:
            result=ci_plan.select(paths)
            self.assertEqual(result['mode'],'quick')
            self.assertEqual(result['matrix'],[])
            self.assertTrue(result['checks']['release-gate'])
            self.assertTrue(result['checks']['secret-scan'])

    def test_browser_test_changes_schedule_every_containing_suite(self):
        result=ci_plan.select(['tests/test_date_time_workflows_browser.cjs'])
        self.assertEqual({row['suite'] for row in result['matrix']},{'dates-motion','responsive-settings'})

    def test_generated_outputs_require_attributable_source_changes(self):
        self.assertEqual(ci_plan.select(['app/web/static/bundle.js'])['mode'],'full')
        result=ci_plan.select(['app/web/static/bundle.js','app/web/static/index.html','app/web/static/todo-groups.js'])
        self.assertEqual(result['mode'],'quick')

    def test_explicit_release_validation_has_complete_coverage(self):
        result=ci_plan.select(['docs/usage.md'],force_full=True)
        self.assertEqual(result['mode'],'full')
        self.assertTrue(all(result['checks'].values()))
        self.assertEqual(result['matrix'],ci_plan.full_matrix())

    def test_immutable_diff_base_and_paths_are_required(self):
        for base in ['main','HEAD','-a','a'*39]:
            with self.assertRaises(ValueError):ci_plan.changed_files(base)
        for path in ['../app.py','/app.py','bad\npath']:
            with self.assertRaises(ValueError):ci_plan.select([path])

    def test_image_is_immutable_and_matches_the_lockfile(self):
        self.assertRegex(ci_plan.browser_image()['image'],r'@sha256:[a-f0-9]{64}$')
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'.github/ci').mkdir(parents=True)
            (root/'package-lock.json').write_text(json.dumps({'packages':{'node_modules/playwright':{'version':'1.0.0'}}}))
            (root/'.github/ci/browser-image.json').write_text(json.dumps(ci_plan.browser_image()))
            with self.assertRaises(ValueError):ci_plan.browser_image(root)


class SchedulingTest(unittest.TestCase):
    def test_long_groups_start_first_without_changing_any_matrix_entry(self):
        matrix=ci_plan.full_matrix()
        ordered=ci_plan.schedule(matrix)
        self.assertCountEqual(ordered,matrix)
        history=json.loads((ROOT/'.github/ci/browser-timings.json').read_text())
        weights={ci_plan.matrix_key(row):row['seconds'] for row in history['jobs']}
        self.assertEqual([weights[ci_plan.matrix_key(row)] for row in ordered],
                         sorted(weights.values(),reverse=True))
        self.assertNotEqual(ordered,matrix)
        selected=ci_plan.select(['app/web/static/todo-center.css'])['matrix']
        self.assertCountEqual(ci_plan.schedule(selected),selected)

    def test_new_groups_and_ties_are_preserved_and_bad_history_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'.github/ci').mkdir(parents=True)
            path=root/'.github/ci/browser-timings.json'
            matrix=[dict(suite=name,browser='',shard='') for name in ['known','new','other']]
            self.assertEqual(ci_plan.schedule(matrix,root),matrix)
            known=dict(matrix[0],seconds=60)
            path.write_text(json.dumps({'schema':1,'jobs':[known]}))
            self.assertEqual(ci_plan.schedule(matrix,root),matrix)
            for jobs in [[known,known],[dict(known,seconds=-1)],[dict(known,seconds=True)]]:
                path.write_text(json.dumps({'schema':1,'jobs':jobs}))
                with self.assertRaises(ValueError):ci_plan.schedule(matrix,root)

    def test_history_requires_all_successful_groups_from_the_same_repository(self):
        api=FakeGitHub();run=run_record()
        matrix=ci_plan.full_matrix()
        jobs=[dict(name=f'browser-test ({r["suite"]}, {r["browser"]}, {r["shard"]})',
                   conclusion='success',started_at=NOW.isoformat(),
                   completed_at=(NOW+timedelta(seconds=60)).isoformat()) for r in matrix]
        def get(path):
            return {'jobs':jobs} if '/jobs?' in path else run
        api.get=get
        result=ci_browser_timings.collect(api,42)
        self.assertEqual(len(result['jobs']),len(matrix))
        self.assertEqual(result['source']['run_id'],42)
        for change in ['missing','failed','foreign','wrong-workflow','duplicate']:
            current=deepcopy(jobs);record=deepcopy(run)
            if change=='missing':current.pop()
            if change=='failed':current[0]['conclusion']='failure'
            if change=='foreign':record['head_repository']={'full_name':'fork/repo'}
            if change=='wrong-workflow':record['path']='.github/workflows/other.yml'
            if change=='duplicate':current.append(current[0])
            with patch.object(api,'get',side_effect=lambda path: {'jobs':current} if '/jobs?' in path else record):
                with self.subTest(change=change),self.assertRaises(ValueError):
                    ci_browser_timings.collect(api,42)


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

    @unittest.skipUnless(os.name=='posix','Linux/macOS process groups')
    def test_cleanup_kills_children_after_the_leader_exits(self):
        source = '''import os, signal, time
if os.fork() == 0:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    print("child ready", flush=True)
time.sleep(60)
'''
        process = subprocess.Popen([sys.executable, '-c', source], start_new_session=True,
                                   stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(process.stdout.readline().strip(), 'child ready')
            ci_browser.stop(process)
            # EOF requires the TERM-resistant child to close its inherited pipe.
            process.communicate(timeout=2)
            self.assertIsNotNone(process.returncode)
        finally:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.communicate(timeout=5)


class ImportWaitTest(unittest.TestCase):
    def test_background_import_waits_for_real_completion_and_rejects_failures(self):
        script = r'''
const assert = require('node:assert/strict');
const {waitForImport} = require('./tests/helpers/import-job.cjs');
(async () => {
  let calls = 0, pauses = 0;
  const page = {
    evaluate: async () => ++calls < 3 ? {state:'importing',imported:calls} : {state:'completed',imported:3},
    waitForTimeout: async () => pauses++,
  };
  assert.equal((await waitForImport(page,'fixture')).imported,3);
  assert.equal(calls,3);assert.equal(pauses,2);
  page.evaluate = async () => ({state:'failed',error:'disk full'});
  await assert.rejects(waitForImport(page,'fixture'),/disk full/);
  page.evaluate = async () => ({state:'importing',imported:1});
  await assert.rejects(waitForImport(page,'fixture',0),/Import did not complete/);
})().catch(error => {console.error(error);process.exitCode=1});
'''
        subprocess.run(['node', '-e', script], cwd=ROOT, check=True, timeout=10)


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
