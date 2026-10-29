"""Private native builds may overlap full checks; artifact promotion fails closed."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts import ci_release_build as builds

HEAD, TREE = 'a' * 40, 'b' * 40
NOW = datetime.now(timezone.utc)
REPO = 'example/mailai'


class FakeGitHub:
    repository = REPO

    def __init__(self):
        self.run = dict(id=42, run_attempt=1, path=builds.WORKFLOW, event='workflow_dispatch',
                        head_sha=HEAD, repository={'full_name': REPO}, head_repository={'full_name': REPO},
                        status='completed', conclusion='success', created_at=NOW.isoformat(), updated_at=NOW.isoformat())
        self.tree = TREE
        self.version = '3.8.3'
        self.jobs = [dict(id=n, name=name, conclusion='success') for n, name in
                     enumerate(['metadata', 'quality', *builds.PACKAGES], 1)]
        self.jobs.append(dict(id=6, name='publish', conclusion='skipped'))
        self.artifacts = []
        self.archives = {}
        self.files = {}
        for n, (name, files) in enumerate(builds.FILES.items(), 10):
            content = {}
            for filename in files:
                if filename.endswith('.sha256'):
                    package = filename.removesuffix('.sha256')
                    content[filename] = (hashlib.sha256(package.encode()).hexdigest() + '  dist/' + package + '\n').encode()
                else:
                    content[filename] = filename.encode()
            self.files[name] = content
            self.artifacts.append(dict(id=n, name=name, expired=False,
                                       workflow_run={'id':42,'head_sha':HEAD}, size_in_bytes=100))
            self.repack(n)

    def repack(self, number, replacement=None):
        artifact = next(a for a in self.artifacts if a['id']==number)
        data = io.BytesIO()
        with zipfile.ZipFile(data, 'w') as archive:
            for filename, content in (replacement or self.files[artifact['name']]).items():
                archive.writestr(filename, content)
        self.archives[number] = data.getvalue()
        artifact['digest'] = 'sha256:' + hashlib.sha256(data.getvalue()).hexdigest()

    def get(self, path):
        if path.startswith('actions/workflows/'):
            return {'workflow_runs':[self.run]}
        if path.startswith('git/commits/'):
            return {'tree':{'sha':self.tree}}
        if '/jobs?' in path:
            return {'jobs':deepcopy(self.jobs)}
        if '/artifacts?' in path:
            return {'artifacts':deepcopy(self.artifacts)}
        if path == 'actions/runs/42':
            return deepcopy(self.run)
        raise AssertionError(path)

    def file(self, path, ref):
        assert (path, ref)==('VERSION', HEAD)
        return self.version

    def download(self, artifact, path):
        path.write_bytes(self.archives[artifact])


class BuildProvenanceTest(unittest.TestCase):
    def test_complete_private_build_is_bound_to_tree_version_and_artifact_ids(self):
        api=FakeGitHub()
        proof=builds.source(api,api.run,TREE,'3.8.3',NOW)
        self.assertEqual(proof['source_artifacts'],'10,11,12')
        self.assertEqual(proof['source_sha'],HEAD)
        self.assertEqual(builds.find(api,TREE,'3.8.3',NOW),proof)
        self.assertIsNone(builds.find(api,'c'*40,'3.8.3',NOW))

    def test_foreign_failed_expired_mismatched_and_incomplete_builds_are_rejected(self):
        mutations = [lambda a:a.run.update(event='push'),lambda a:a.run.update(status='in_progress'),
                     lambda a:a.run.update(conclusion='failure'),lambda a:a.run.update(path='other.yml'),
                     lambda a:a.run.update(repository={'full_name':'fork/repo'}),
                     lambda a:a.run.update(head_repository={'full_name':'fork/repo'}),
                     lambda a:a.run.update(created_at=(NOW-timedelta(days=8)).isoformat()),
                     lambda a:a.run.update(updated_at=(NOW+timedelta(seconds=1)).isoformat()),
                     lambda a:setattr(a,'tree','c'*40),lambda a:setattr(a,'version','3.8.2'),
                     lambda a:a.jobs.pop(0),lambda a:a.jobs[2].update(conclusion='skipped'),
                     lambda a:a.jobs[1].update(conclusion='failure'),lambda a:a.jobs[-1].update(conclusion='success'),
                     lambda a:a.artifacts.pop(),lambda a:a.artifacts.append(deepcopy(a.artifacts[0])),
                     lambda a:a.artifacts[0].update(expired=True),
                     lambda a:a.artifacts[0].update(digest='sha256:bad'),
                     lambda a:a.artifacts[0].update(workflow_run={'id':99,'head_sha':HEAD}),
                     lambda a:a.artifacts[0].update(workflow_run={'id':42,'head_sha':'c'*40})]
        for n, mutation in enumerate(mutations):
            api=FakeGitHub();mutation(api)
            with self.subTest(case=n),self.assertRaises((ValueError,KeyError)):
                builds.source(api,api.run,TREE,'3.8.3',NOW)

    def test_failed_only_reruns_keep_successful_platforms_but_never_stale_success(self):
        api=FakeGitHub();api.run['run_attempt']=2
        api.jobs.append(dict(id=20,name='quality',conclusion='failure'))
        with self.assertRaises(ValueError):builds.source(api,api.run,TREE,'3.8.3',NOW)
        api.jobs[-1]['conclusion']='success'
        self.assertEqual(builds.source(api,api.run,TREE,'3.8.3',NOW)['source_attempt'],2)

    def test_private_dispatch_cannot_follow_a_moved_branch_or_publish_as_a_tag(self):
        api=FakeGitHub()
        env=dict(GITHUB_SHA=HEAD,GITHUB_EVENT_NAME='workflow_dispatch',CANDIDATE_HEAD=HEAD,CANDIDATE_VERSION='3.8.3')
        with tempfile.TemporaryDirectory() as directory,patch.object(builds.ci_quality,'git',side_effect=lambda *a: TREE if a[-1]=='HEAD^{tree}' else HEAD):
            root=Path(directory);(root/'VERSION').write_text('3.8.3');(root/'README.md').write_text('当前版本：**v3.8.3**')
            with patch.object(builds,'find',side_effect=AssertionError('Preparation must build fresh')):
                self.assertEqual(builds.plan(api,env,root,NOW)['reuse'],'false')
            for change in [dict(CANDIDATE_HEAD='c'*40),dict(CANDIDATE_VERSION='3.8.2'),dict(GITHUB_SHA='c'*40),
                           dict(GITHUB_EVENT_NAME='pull_request'),dict(GITHUB_EVENT_NAME='push',GITHUB_REF='refs/heads/main')]:
                with self.subTest(change=change),self.assertRaises(ValueError):builds.plan(api,{**env,**change},root,NOW)
            tagged=dict(GITHUB_SHA=HEAD,GITHUB_EVENT_NAME='push',GITHUB_REF='refs/tags/v3.8.3')
            self.assertEqual(builds.plan(api,tagged,root,NOW)['source_run'],'42')


class RestoreTest(unittest.TestCase):
    def test_binary_transport_preserves_escape_bytes_for_archive_digest_verification(self):
        data=b'PK\x03\x04\x1b[31mbinary installer bytes\x00\xff'
        def emit(args,**kwargs):
            self.assertIn('--allow-escape-sequences',args)
            self.assertNotIn('shell',kwargs)
            kwargs['stdout'].write(data)
        with tempfile.TemporaryDirectory() as directory,patch.object(builds.subprocess,'run',side_effect=emit):
            path=Path(directory)/'artifact.zip'
            builds.GitHub(REPO).download(10,path)
            self.assertEqual(path.read_bytes(),data)

    def test_exact_installer_and_dmg_bytes_are_restored_and_all_checksums_verified(self):
        api=FakeGitHub()
        with tempfile.TemporaryDirectory() as directory:
            output=Path(directory)/'assets'
            builds.restore(api,42,1,'10,11,12',TREE,'3.8.3',output,NOW)
            self.assertEqual({p.name:p.read_bytes() for p in output.iterdir()},
                             {name:data for files in api.files.values() for name,data in files.items()})

    def test_changed_attempt_artifact_ids_and_archive_hash_fail_before_publication(self):
        for mutation in ['attempt','ids','archive']:
            api=FakeGitHub()
            if mutation=='archive':api.archives[10]+=b'changed'
            with tempfile.TemporaryDirectory() as directory:
                output=Path(directory)/'assets'
                with self.subTest(mutation=mutation),self.assertRaises(ValueError):
                    builds.restore(api,42,2 if mutation=='attempt' else 1,'10,11' if mutation=='ids' else '10,11,12',TREE,'3.8.3',output,NOW)
                self.assertFalse(output.exists())

    def test_nested_files_and_incorrect_installer_checksums_never_escape_staging(self):
        for mutation in ['traversal','checksum']:
            api=FakeGitHub();files=deepcopy(api.files['release-windows-x64'])
            if mutation=='traversal':files['../outside']=b'bad'
            else:files['MailAI-Windows-x64-Setup.exe']=b'changed installer'
            api.repack(10,files)
            with tempfile.TemporaryDirectory() as directory:
                output=Path(directory)/'assets'
                with self.subTest(mutation=mutation),self.assertRaises(ValueError):
                    builds.restore(api,42,1,'10,11,12',TREE,'3.8.3',output,NOW)
                self.assertFalse(output.exists());self.assertFalse((Path(directory)/'outside').exists())

    def test_fresh_tag_builds_still_run_the_original_native_checks_and_signatures(self):
        workflow=(ROOT/'.github/workflows/release.yml').read_text()
        for platform in builds.PACKAGES:
            self.assertIn('  '+platform+':\n    needs: metadata',workflow)
        self.assertIn("needs.quality.result == 'success'",workflow)
        self.assertIn("github.event_name == 'push'",workflow)
        self.assertIn('Scan the release commit history for credentials',workflow)
        self.assertIn('signtool.FullName verify /pa',workflow)
        self.assertIn('Verify real keychain access across signed upgrades',workflow)
        self.assertIn('verify-assets --assets release-assets',workflow)
        for script in ['build_windows.bat','build_linux_appimage.sh','build_macos.command']:
            self.assertIn('check_release.py',(ROOT/'scripts'/script).read_text())


if __name__ == '__main__':
    unittest.main()
