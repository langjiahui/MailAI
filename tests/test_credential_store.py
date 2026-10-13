"""Credential prompt/session regression tests. Never access the real OS vault."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import subprocess
import sys
import threading
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import credential_store as store, macos_keychain, macos_credential_vault


class CredentialStoreTests(unittest.TestCase):
    def setUp(self):
        store._session_cache.clear()
        store._quiet_unavailable.clear()
        store._authorization_required.clear()
        store._master_blocked.clear()
        platform = patch.object(store.platform, 'system', return_value='Windows')
        platform.start()
        self.addCleanup(platform.stop)
        self.addCleanup(store._quiet_unavailable.clear)
        self.addCleanup(store._authorization_required.clear)
        self.addCleanup(store._master_blocked.clear)
        for name,value in [('get',(macos_keychain.NOT_FOUND,'')),('put',True),('remove',True),('unlocked',False)]:
            mocker=patch.object(macos_credential_vault,name,return_value=value)
            mocker.start();self.addCleanup(mocker.stop)
        deletion=patch.object(macos_keychain,'delete',return_value=0)
        deletion.start();self.addCleanup(deletion.stop)
        self.vault = Mock()
        self.backend = patch.object(store, '_keyring', return_value=self.vault)
        self.backend.start()
        self.addCleanup(self.backend.stop)
        self.addCleanup(store._session_cache.clear)

    def test_repeated_reads_and_account_isolation(self):
        self.vault.get_password.side_effect = lambda service, key: 'fixture-' + key
        for _ in range(5):
            self.assertEqual(store.load('account-a'), 'fixture-account-a')
            self.assertEqual(store.load('oauth:account-b'), 'fixture-oauth:account-b')
        self.assertEqual(self.vault.get_password.call_count, 2)
        self.vault.get_password.assert_any_call('MailAI', 'account-a')

    def test_concurrent_reads_request_permission_once(self):
        started, release = threading.Event(), threading.Event()
        def read(service, key):
            started.set()
            self.assertTrue(release.wait(3))
            return 'fixture-password'
        self.vault.get_password.side_effect = read
        with ThreadPoolExecutor(max_workers=8) as pool:
            jobs = [pool.submit(store.load, 'account') for _ in range(8)]
            self.assertTrue(started.wait(3))
            release.set()
            self.assertEqual([job.result(timeout=3) for job in jobs], ['fixture-password'] * 8)
        self.vault.get_password.assert_called_once()

    def test_denied_access_does_not_retry_in_background(self):
        self.vault.get_password.side_effect = PermissionError('fixture-sensitive-exception')
        with self.assertLogs(store.log, level='WARNING') as logs:
            for _ in range(5):
                self.assertEqual(store.load('denied'), '')
        self.vault.get_password.assert_called_once()
        self.assertNotIn('fixture-sensitive-exception', ''.join(logs.output))
        # A deliberate credential save recovers without restarting the app.
        self.assertTrue(store.save('denied', 'fixture-new-password'))
        self.assertEqual(store.load('denied'), 'fixture-new-password')
        self.vault.get_password.assert_called_once()

    def test_missing_credentials_are_cached_until_saved(self):
        self.vault.get_password.return_value = None
        self.assertEqual(store.load('missing'), '')
        self.assertEqual(store.load('missing'), '')
        self.vault.get_password.assert_called_once()
        self.assertTrue(store.save('missing', 'fixture-password'))
        self.assertEqual(store.load('missing'), 'fixture-password')

    def test_save_updates_cached_value_and_failed_save_blocks_old_value(self):
        self.vault.get_password.return_value = 'fixture-old'
        self.assertEqual(store.load('account'), 'fixture-old')
        self.assertTrue(store.save('account', 'fixture-new'))
        self.assertEqual(store.load('account'), 'fixture-new')
        self.vault.set_password.side_effect = RuntimeError('fixture-secret-in-backend-error')
        with self.assertLogs(store.log, level='WARNING') as logs:
            self.assertFalse(store.save('account', 'fixture-replacement'))
        self.assertEqual(store.load('account'), '')
        self.vault.get_password.assert_called_once()
        self.assertNotIn('fixture-secret-in-backend-error', ''.join(logs.output))
        self.assertNotIn('fixture-replacement', ''.join(logs.output))

    def test_delete_clears_cached_secret_even_if_backend_fails(self):
        self.vault.get_password.return_value = 'fixture-old'
        self.assertEqual(store.load('account'), 'fixture-old')
        self.vault.delete_password.side_effect = RuntimeError('fixture-delete-failure')
        store.delete('account')
        self.assertEqual(store.load('account'), '')
        self.vault.get_password.assert_called_once()
        self.assertTrue(store.save('account', 'fixture-relogin'))
        self.assertEqual(store.load('account'), 'fixture-relogin')

    def test_explicit_save_cannot_be_overwritten_by_inflight_old_read(self):
        started, release = threading.Event(), threading.Event()
        def read(service, key):
            started.set()
            self.assertTrue(release.wait(3))
            return 'fixture-old'
        self.vault.get_password.side_effect = read
        with ThreadPoolExecutor(max_workers=2) as pool:
            old = pool.submit(store.load, 'account')
            self.assertTrue(started.wait(3))
            write = pool.submit(store.save, 'account', 'fixture-new')
            release.set()
            self.assertEqual(old.result(timeout=3), 'fixture-old')
            self.assertTrue(write.result(timeout=3))
        self.assertEqual(store.load('account'), 'fixture-new')

    def test_empty_arguments_do_not_access_vault(self):
        self.assertEqual(store.load(''), '')
        self.assertFalse(store.save('', 'fixture'))
        self.assertFalse(store.save('account', ''))
        store.delete('')
        self.assertEqual(self.vault.mock_calls, [])

    def test_macos_native_migration_and_encrypted_mutations_share_cache(self):
        with patch.object(store, '_keyring', return_value=None), \
             patch.object(store.platform, 'system', return_value='Darwin'), \
             patch.object(macos_keychain, 'read_for_app', return_value=(0, 'fixture-password')) as read, \
             patch.object(store.subprocess, 'run') as command:
            self.assertEqual(store.load('native'), 'fixture-password')
            self.assertEqual(store.load('native'), 'fixture-password')
            read.assert_called_once_with('MailAI', 'native', interactive=False)
            command.assert_not_called()
            self.assertTrue(store.save('native', 'fixture-new'))
            self.assertEqual(store.load('native'), 'fixture-new')
            command.assert_not_called()
            store.delete('native')
            self.assertEqual(store.load('native'), '')
            command.assert_not_called()

    def test_macos_quiet_failure_can_be_unlocked_by_explicit_action(self):
        with patch.object(store.platform, 'system', return_value='Darwin'), \
             patch.object(macos_keychain, 'read_for_app', side_effect=[(-25308, ''), (0, 'fixture')]) as read:
            for _ in range(8):
                self.assertEqual(store.load('locked'), '')
            self.assertTrue(store.authorization_required('locked'))
            read.assert_called_once_with('MailAI', 'locked', interactive=False)
            with store.prompt_policy(True):
                self.assertEqual(store.load('locked'), 'fixture')
            self.assertFalse(store.authorization_required('locked'))
            self.assertEqual(store.load('locked'), 'fixture')
            self.assertEqual(read.call_count, 2)
            self.assertTrue(read.call_args.kwargs['interactive'])

    def test_macos_explicit_cancellation_is_not_reprompted(self):
        with patch.object(store.platform, 'system', return_value='Darwin'), \
             patch.object(macos_keychain, 'read_for_app', return_value=(-128, '')) as read:
            with store.prompt_policy(True):
                self.assertEqual(store.load('canceled'), '')
            for _ in range(5):
                with store.prompt_policy(True):
                    self.assertEqual(store.load('canceled'), '')
            read.assert_called_once()
            self.assertFalse(store.authorization_required('canceled'))
            self.assertTrue(store.save('canceled', 'fixture-relogin'))
            self.assertEqual(store.load('canceled'), 'fixture-relogin')

    def test_quiet_status_cannot_inherit_interactive_request_policy(self):
        @store.quiet
        def status():
            return store.load('status-only')
        with patch.object(store.platform, 'system', return_value='Darwin'), \
             patch.object(macos_keychain, 'read_for_app', return_value=(-25308, '')) as read:
            with store.prompt_policy(True):
                self.assertEqual(status(), '')
            read.assert_called_once_with('MailAI', 'status-only', interactive=False)
            self.assertFalse(store._interactive.get())

    def test_quiet_native_failure_never_falls_back_to_interactive_backend(self):
        with patch.object(store.platform, 'system', return_value='Darwin'), \
             patch.object(macos_keychain, 'read_for_app', side_effect=OSError('fixture-secret')) as read, \
             patch.object(store.subprocess, 'run') as command:
            with self.assertLogs(store.log, level='WARNING') as logs:
                self.assertEqual(store.load('broken'), '')
            self.assertEqual(store.load('broken'), '')
            read.assert_called_once()
            command.assert_not_called()
            self.vault.get_password.assert_not_called()
            self.assertNotIn('fixture-secret', ''.join(logs.output))


if __name__ == '__main__':
    unittest.main()
