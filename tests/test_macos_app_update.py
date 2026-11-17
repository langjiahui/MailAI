"""Validate signed app selection and the native handoff in an isolated directory."""
import os
import hashlib
from contextlib import ExitStack
import plistlib
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app import macos_app_update as mac_update, release_update, update_mirror, update_trust
from app import account_guard, desktop, draft_lifecycle


class UpdateManifestTest(unittest.TestCase):
    def test_system_owned_bundle_uses_system_installer(self):
        with tempfile.TemporaryDirectory() as folder:
            bundle = Path(folder) / 'MailAI.app'
            executable = bundle / 'Contents/MacOS/MailAI'
            executable.parent.mkdir(parents=True)
            signature = bundle / 'Contents/_CodeSignature/CodeResources'
            signature.parent.mkdir()
            signature.touch()
            with (patch.object(mac_update, 'FROZEN', True),
                  patch.object(mac_update.sys, 'platform', 'darwin'),
                  patch.object(mac_update.sys, 'executable', str(executable)),
                  patch.object(desktop, '_runtime', Mock(quitting=False))):
                self.assertEqual(mac_update._installed_bundle(), bundle.resolve())
                with patch.object(mac_update.os, 'getuid', return_value=os.getuid() + 1):
                    self.assertFalse(mac_update.eligible())

    def test_failed_update_stays_failed_after_outcome_is_consumed(self):
        with (tempfile.TemporaryDirectory() as folder,
              patch.object(release_update, 'USER_DIR', Path(folder)),
              patch.object(release_update, 'current_version', return_value='3.0.0'),
              patch.object(release_update, 'device_key', return_value='macos-arm64'),
              patch.object(release_update, '_install_state', {'status':'idle'})):
            import json
            updates = Path(folder) / 'updates'
            updates.mkdir()
            release = {'latest_version':'3.1.0', 'device':'macos-arm64',
                       'asset':{'size':4}, 'install_method':'mac-app'}
            release_update._download_path(release).write_bytes(b'test')
            release_update._remember_ready_update(release)
            (updates / 'install-pending.json').write_text(json.dumps({
                'version':'3.1.0', 'started_at':time.time(), 'method':'mac-app'}))
            (updates / 'install-outcome.txt').write_text('failed')
            (updates / 'install-output.log').write_text('Permission denied')
            self.assertEqual(release_update.consume_install_outcome()['status'], 'failed')
            self.assertEqual(release_update.consume_install_outcome(), {'pending':False})
            self.assertEqual(release_update.install_status()['phase'], 'failed')
            self.assertEqual(release_update.install_status()['error'], '更新所需的权限不足，请使用系统安装器完成更新。')
            with patch.object(mac_update, 'USER_DIR', Path(folder)):
                self.assertFalse(mac_update.eligible())

    def test_prepared_app_requires_confirmation_and_rechecks_its_hash(self):
        payload = b'isolated signed application archive fixture'
        release = {
            'latest_version': '3.1.0', 'device': 'macos-arm64', 'install_method': 'mac-app',
            'available': True, 'installable': True,
            'asset': {'sha256': hashlib.sha256(payload).hexdigest(), 'size': len(payload)},
        }
        with (tempfile.TemporaryDirectory() as folder,
              patch.object(release_update, 'USER_DIR', Path(folder)),
              patch.object(release_update, 'current_version', return_value='3.0.0'),
              patch.object(release_update, 'device_key', return_value='macos-arm64'),
              patch.object(release_update, 'check', return_value=release),
              patch.object(release_update, '_download', side_effect=lambda _asset, path, **_options: path.write_bytes(payload)),
              patch.object(mac_update, 'install') as install):
            result = release_update.download_and_launch(download_only=True)
            self.assertEqual(result['phase'], 'ready')
            install.assert_not_called()
            result = release_update.download_and_launch(prepared_only=True, expected_version='3.1.0')
            self.assertEqual(result['phase'], 'restarting')
            install.assert_called_once_with(release_update._download_path(release), '3.1.0')
            install.reset_mock()
            release_update._download_path(release).write_bytes(b'x' * len(payload))
            with self.assertRaisesRegex(ValueError, '校验失败'):
                release_update.download_and_launch(prepared_only=True, expected_version='3.1.0')
            install.assert_not_called()

    def test_only_verified_official_app_asset_is_offered(self):
        manifest = {
            'version': '3.1.0',
            'assets': {
                'macos-arm64': {'url': 'https://example.test/mail.pkg', 'sha256': 'a' * 64},
                update_mirror.MAC_APP_DEVICE: {'url': 'https://example.test/mail.zip', 'sha256': 'b' * 64},
            },
        }
        with (patch.object(release_update, 'FROZEN', True),
              patch.object(release_update, 'current_version', return_value='3.0.0'),
              patch.object(mac_update, 'eligible', return_value=True)):
            with patch.object(release_update, '_read_json_url', side_effect=OSError), \
                    patch.object(release_update, '_read_manifest', return_value=manifest):
                fallback = release_update._official_github_manifest()
            self.assertNotIn(update_mirror.MAC_APP_DEVICE, fallback['assets'])
            self.assertNotIn('install_method', release_update.evaluate_manifest(fallback, device='macos-arm64', allow_app=True))
            self.assertNotIn('install_method', release_update.evaluate_manifest(manifest, device='macos-arm64'))
            with patch.object(release_update, '_read_json_url', return_value={'manifest': manifest}):
                with self.assertRaisesRegex(ValueError, '签名校验失败'):
                    release_update._official_github_manifest()
                with patch.object(update_trust, 'verify', return_value=manifest):
                    verified = release_update._official_github_manifest()
            result = release_update.evaluate_manifest(verified, device='macos-arm64', allow_app=True)
            self.assertEqual(result['install_method'], 'mac-app')
            self.assertEqual(release_update._download_path(result).suffix, '.zip')

    def test_startup_receipt_waits_for_app_scripts(self):
        token = 'a' * 32
        window = Mock()
        window.evaluate_js.side_effect = [False, True]
        with tempfile.TemporaryDirectory() as folder, patch.object(mac_update, 'USER_DIR', Path(folder)), \
                patch.dict(os.environ, {'MAILAI_UPDATE_BOOT_TOKEN': token}):
            directory = Path(folder) / 'updates'
            directory.mkdir()
            mac_update.confirm_startup(window)
            self.assertFalse((directory / f'boot-{token}').exists())
            mac_update.confirm_startup(window)
            self.assertTrue((directory / f'boot-{token}').is_file())


class PreparationFailureTest(unittest.TestCase):
    def test_shutdown_rejects_queued_mail_work_without_blocking_process_exit(self):
        guard = account_guard.AccountGuard()
        guard.acquire(exclusive=True)
        completed = threading.Event()
        results = []

        def queued():
            try:
                guard.acquire_work()
            except account_guard.AccountBusy:
                results.append('postponed')
            finally:
                completed.set()

        worker = threading.Thread(target=queued)
        worker.start()
        guard.set_stopping(True)
        try:
            self.assertTrue(completed.wait(2))
            self.assertEqual(results, ['postponed'])
            for operation in (guard.acquire_work, guard.wait_ready, guard.reserve_work):
                with self.assertRaises(account_guard.AccountBusy):
                    operation()
        finally:
            guard.set_stopping(False)
            guard.release(exclusive=True)
            worker.join(2)
        self.assertTrue(guard.acquire())
        guard.release()

    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.current = self.root / 'MailAI.app'
        self.current.mkdir()
        self.stage = self.root / 'stage'
        self.stage.mkdir()
        (self.root / 'updates').mkdir()
        self.runtime = Mock(quitting=False)
        self.guard = account_guard.AccountGuard()
        for target, name, value in (
            (mac_update, 'USER_DIR', self.root),
            (mac_update, 'APP_DIR', ROOT),
            (desktop, '_runtime', self.runtime),
            (account_guard, 'guard', self.guard),
        ):
            self.stack.enter_context(patch.object(target, name, value))
        self.stack.enter_context(patch.object(mac_update, '_installed_bundle', return_value=self.current))
        self.stack.enter_context(patch.object(mac_update.tempfile, 'mkdtemp', return_value=str(self.stage)))
        self.stack.enter_context(patch.object(mac_update, '_run'))
        self.stack.enter_context(patch.object(mac_update, '_verify_bundle'))

    def assert_preserved(self):
        self.assertTrue(self.current.is_dir())
        self.assertFalse(self.stage.exists())
        self.assertFalse((self.root / 'updates/install-pending.json').exists())
        self.runtime._finish_quit.assert_not_called()

    def test_draft_cancellation_preserves_installed_app(self):
        with patch.object(draft_lifecycle, 'request_safe_exit', side_effect=lambda runtime, finish, on_cancel: on_cancel()):
            with self.assertRaisesRegex(ValueError, '草稿尚未保存'):
                mac_update.install(self.root / 'fixture.zip', '3.1.0')
        self.assert_preserved()
        self.assertTrue(self.guard.acquire(exclusive=True))
        self.guard.release(exclusive=True)

    def test_active_mail_operation_postpones_before_closing_editors(self):
        self.guard.acquire()
        try:
            with (patch.object(mac_update.time, 'monotonic', side_effect=[0, 16]),
                  patch.object(draft_lifecycle, 'request_safe_exit') as save):
                with self.assertRaisesRegex(ValueError, '邮件仍在处理'):
                    mac_update.install(self.root / 'fixture.zip', '3.1.0')
                save.assert_not_called()
            self.assert_preserved()
        finally:
            self.guard.release()

    def test_handoff_failure_cleans_checkpoint_and_releases_mail_operations(self):
        with (patch.object(draft_lifecycle, 'request_safe_exit', side_effect=lambda runtime, finish, on_cancel: finish()),
              patch.object(mac_update.subprocess, 'Popen', side_effect=OSError('isolated helper failure'))):
            with self.assertRaises(OSError):
                mac_update.install(self.root / 'fixture.zip', '3.1.0')
        self.assert_preserved()
        self.assertTrue(self.guard.acquire(exclusive=True))
        self.guard.release(exclusive=True)


@unittest.skipUnless(sys.platform == 'darwin', 'Requires native macOS commands')
class NativeMacUpdateTest(unittest.TestCase):
    def make_app(self, root, version, command):
        executable = root / 'Contents' / 'MacOS' / 'MailAI'
        executable.parent.mkdir(parents=True)
        executable.write_text('#!/bin/sh\n' + command + '\n', encoding='utf-8')
        executable.chmod(0o755)
        (root / 'Contents' / 'Info.plist').write_bytes(plistlib.dumps({
            'CFBundleIdentifier': mac_update.IDENTIFIER,
            'CFBundleExecutable': 'MailAI',
            'CFBundlePackageType': 'APPL',
            'CFBundleShortVersionString': version,
        }))
        return executable

    def test_native_signature_and_bundle_version(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            previous = root / 'Installed.app'
            candidate = root / 'Updated.app'
            for bundle, version in ((previous, '3.0.0'), (candidate, '3.1.0')):
                self.make_app(bundle, version, 'exit 0')
                subprocess.run(['/usr/bin/codesign', '--sign', '-', '--requirements',
                                f'=designated => identifier "{mac_update.IDENTIFIER}"', str(bundle)],
                               check=True, capture_output=True)
            mac_update._verify_bundle(previous, candidate, '3.1.0')
            with self.assertRaisesRegex(ValueError, '目标版本不一致'):
                mac_update._verify_bundle(previous, candidate, '3.2.0')
            (candidate / 'Contents' / 'MacOS' / 'MailAI').write_text('#!/bin/sh\nexit 1\n')
            with self.assertRaises(subprocess.CalledProcessError):
                mac_update._verify_bundle(previous, candidate, '3.1.0')

    def run_handoff(self, startup, *, reap_parent=True, deny_move=False):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            current, stage, updates = (root / name for name in ('MailAI.app', 'stage', 'updates'))
            updates.mkdir()
            token = 'a' * 32
            marker = root / 'old-started'
            process_file = root / 'new-process'
            executable = self.make_app(current, '3.0.0', f'touch "{marker}"')
            if deny_move:
                locked = root / 'locked'
                locked.mkdir()
                current.rename(locked / 'MailAI.app')
                current = locked / 'MailAI.app'
                executable = current / 'Contents/MacOS/MailAI'
                locked.chmod(0o555)
            command = 'exit 1'
            if startup in {'ready', 'crashed'}:
                command = f'touch "{updates}/boot-$MAILAI_UPDATE_BOOT_TOKEN"\n'
                command += f'echo $$ > "{process_file}"\nexec /bin/sleep 30' if startup == 'ready' else 'exit 1'
            self.make_app(stage / 'MailAI.app', '3.1.0', command)
            succeeded = startup == 'ready'
            with subprocess.Popen(['/bin/sleep', '10']) as active:
                with subprocess.Popen([
                    '/bin/zsh', '-f', str(ROOT / 'app/native/apply_macos_update.zsh'),
                    str(active.pid), str(current), str(stage), str(updates), token,
                ]) as helper:
                    try:
                        self.assertIn(str(marker), executable.read_text())
                        active.terminate()
                        if reap_parent:
                            active.wait(timeout=3)
                        self.assertEqual(helper.wait(timeout=8), 0 if succeeded else 1)
                    finally:
                        if deny_move:
                            locked.chmod(0o755)
                        if helper.poll() is None:
                            helper.kill()
                        if active.poll() is None:
                            active.kill()
                        if process_file.is_file():
                            try:
                                os.kill(int(process_file.read_text()), 15)
                            except ProcessLookupError:
                                pass
            self.assertEqual((updates / 'install-outcome.txt').read_text().strip(),
                             'success' if succeeded else 'failed')
            self.assertFalse(stage.exists())
            self.assertEqual(str(marker) in executable.read_text(), not succeeded)
            if not succeeded:
                deadline = time.monotonic() + 3
                while not marker.is_file() and time.monotonic() < deadline:
                    time.sleep(.02)
                self.assertTrue(marker.is_file())

    def test_updated_app_replaces_previous_after_startup(self):
        self.run_handoff('ready')

    def test_exited_parent_awaiting_reaping_does_not_block_the_update(self):
        self.run_handoff('ready', reap_parent=False)

    def test_failed_startup_restores_and_relaunches_previous_app(self):
        self.run_handoff('failed')

    def test_permission_failure_reopens_previous_app(self):
        self.run_handoff('failed', deny_move=True)

    def test_crash_after_startup_receipt_still_restores_previous_app(self):
        self.run_handoff('crashed')


if __name__ == '__main__':
    unittest.main()
