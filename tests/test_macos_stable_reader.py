"""Stable-reader routing and byte-accurate decoding; no real user credentials."""
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import macos_keychain as native


class ReaderTests(unittest.TestCase):
    def result(self, output, status=0):
        return subprocess.CompletedProcess([], status, stderr=output)

    def test_background_read_never_launches_an_interactive_child(self):
        with patch.object(native, 'read', return_value=(-25308, '')) as quiet, \
             patch.object(native.subprocess, 'run') as child:
            self.assertEqual(native.read_for_app('MailAI', 'fixture'), (-25308, ''))
            quiet.assert_called_once_with('MailAI', 'fixture', interactive=False)
            child.assert_not_called()

    def test_foreground_restoration_uses_the_fixed_reader_and_no_shell(self):
        with patch.object(native.subprocess, 'run', return_value=self.result(b'password: "fixture-secret"\n')) as child, \
             patch.object(native, 'read') as direct:
            self.assertEqual(native.read_for_app('MailAI', 'fixture', interactive=True), (0, 'fixture-secret'))
            args, kwargs = child.call_args
            self.assertEqual(args[0], ['/usr/bin/security', 'find-generic-password', '-s', 'MailAI', '-a', 'fixture', '-g'])
            self.assertNotIn('fixture-secret', str(args))
            self.assertFalse(kwargs.get('shell', False))
            self.assertEqual(kwargs['stdout'], subprocess.DEVNULL)
            self.assertEqual(kwargs['stderr'], subprocess.PIPE)
            self.assertGreaterEqual(kwargs['timeout'], 120)
            direct.assert_not_called()

    def test_spaces_quotes_and_hex_looking_ascii_are_not_reinterpreted(self):
        for value in [' fixture-secret ', 'deadbeef', 'a"quoted"value', '0x1234', '']:
            output = b'password: ' + (('"'+value+'"').encode() if value else b'') + b'\n'
            with self.subTest(value=value), patch.object(native.subprocess, 'run', return_value=self.result(output)):
                self.assertEqual(native.read_for_app('MailAI', 'fixture', interactive=True), (0, value))

    def test_unicode_backslashes_and_newlines_decode_from_explicit_hex(self):
        for value in ['密码 fixture', 'fixture\\secret', ' line\n', '\x00fixture']:
            output = b'password: 0x' + value.encode('utf-8').hex().upper().encode() + b'  "display-only"\n'
            with self.subTest(value=value), patch.object(native.subprocess, 'run', return_value=self.result(output)):
                self.assertEqual(native.read_for_app('MailAI', 'fixture', interactive=True), (0, value))
        with patch.object(native.subprocess, 'run', return_value=self.result(b'password: 0x0A \n')):
            self.assertEqual(native.read_for_app('MailAI', 'fixture', interactive=True), (0, '\n'))

    def test_nonzero_exit_cannot_return_data_and_preserves_missing_or_denied_status(self):
        for status in [native.NOT_FOUND, -25308, -25293, -128]:
            with self.subTest(status=status), patch.object(native.subprocess, 'run', return_value=self.result(b'fixture-sensitive-error', status % 256)):
                self.assertEqual(native.read_for_app('MailAI', 'fixture', interactive=True), (status, ''))

    def test_cancel_timeout_does_not_fall_back_or_log_credential_output(self):
        error = subprocess.TimeoutExpired(['/usr/bin/security'], 240, stderr=b'fixture-sensitive-output')
        with patch.object(native.subprocess, 'run', side_effect=error) as child, \
             patch.object(native, 'read') as direct, patch.object(native.log, 'warning') as log:
            self.assertEqual(native.read_for_app('MailAI', 'fixture', interactive=True), (-128, ''))
            child.assert_called_once()
            direct.assert_not_called()
            log.assert_not_called()

    def test_malformed_output_fails_closed_without_logging_secrets(self):
        for output in [b'fixture-secret', b'password: 0x123 \n', b'password: 0xZZ \n', b'password: 0xFF \n']:
            with self.subTest(output=output), patch.object(native.subprocess, 'run', return_value=self.result(output)), \
                 patch.object(native.log, 'warning') as log:
                self.assertEqual(native.read_for_app('MailAI', 'fixture', interactive=True), (-1, ''))
                log.assert_not_called()

    def test_reader_error_never_logs_the_exception_message(self):
        with patch.object(native.subprocess, 'run', side_effect=OSError('fixture-secret')), \
             self.assertLogs(native.log, level='WARNING') as output:
            self.assertEqual(native.read_for_app('MailAI', 'fixture', interactive=True), (-1, ''))
        self.assertNotIn('fixture-secret', '\n'.join(output.output))


if __name__ == '__main__':
    unittest.main()
