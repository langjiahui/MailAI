"""Offline checks for device-only iOS packaging, independent versions, and immutable artifacts."""
import importlib.util
import json
from pathlib import Path
import plistlib
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('ios_build', ROOT / 'mobile/ios/scripts/build.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class IOSReleaseTest(unittest.TestCase):
    def fixture(self, root, platform='iPhoneOS'):
        app = root / 'MailAI.app'; app.mkdir()
        info = dict(CFBundleIdentifier='com.mailai.ios', CFBundleShortVersionString='1.0.0',
                    CFBundleVersion='1', CFBundleSupportedPlatforms=[platform], CFBundleExecutable='MailAI')
        (app / 'Info.plist').write_bytes(plistlib.dumps(info))
        (app / 'MailAI').write_bytes(b'synthetic arm64 executable')
        (app / 'MailAI').chmod(0o755)
        return app

    def test_independent_ios_metadata_is_consistent(self):
        self.assertEqual(build.version_metadata(), ('1.0.0', '1'))

    def test_simulator_bundles_cannot_be_packaged_as_device_ipa(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); app = self.fixture(root, 'iPhoneSimulator')
            with self.assertRaisesRegex(SystemExit, 'CFBundleSupportedPlatforms'):
                build.package(app, root / 'output', '1.0.0', '1')

    def test_x86_binaries_cannot_be_packaged_as_device_ipa(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); app = self.fixture(root)
            with patch.object(build.subprocess, 'check_output', return_value='x86_64'), self.assertRaisesRegex(SystemExit, 'arm64'):
                build.package(app, root / 'output', '1.0.0', '1')

    def test_manifest_discloses_unsigned_state_and_published_bytes_are_not_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); app = self.fixture(root); output = root / 'output'
            with patch.object(build.subprocess, 'check_output', side_effect=['arm64', 'a' * 40]):
                build.package(app, output, '1.0.0', '1')
            manifest = json.loads((output / 'ios-build-manifest.json').read_text())
            self.assertFalse(manifest['installable_directly'])
            self.assertEqual(manifest['signing'], 'unsigned-requires-device-signing')
            with zipfile.ZipFile(output / manifest['file']) as ipa:
                self.assertIn('Payload/MailAI.app/MailAI', ipa.namelist())
                self.assertTrue((ipa.getinfo('Payload/MailAI.app/MailAI').external_attr >> 16) & 0o111)
            with patch.object(build.subprocess, 'check_output', return_value='arm64'), self.assertRaisesRegex(SystemExit, 'overwrite'):
                build.package(app, output, '1.0.0', '1')


if __name__ == '__main__':
    unittest.main()
