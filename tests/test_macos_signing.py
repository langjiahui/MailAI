"""Offline signing policy tests; native cross-upgrade checks run on macOS CI."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import macos_signing as signing

class SigningTests(unittest.TestCase):
    def test_requirement_pins_certificate_and_identifier_not_build(self):
        dr=signing.requirement()
        self.assertIn('identifier "com.langjiahui.mailai"',dr)
        self.assertIn('certificate leaf = H"'+signing.fingerprint()+'"',dr)
        self.assertNotIn('cdhash',dr)
        self.assertNotIn('anchor trusted',dr)
        with self.assertRaises(ValueError):signing.requirement('x" or true')

    def test_missing_or_changed_identity_fails_before_signing(self):
        for env in ({},{'MAILAI_SIGNING_MODE':'self-signed','MAILAI_SIGN_IDENTITY':'different'}):
            with patch.dict(os.environ,env,clear=True),patch.object(signing,'run') as run:
                with self.assertRaises(ValueError):signing.sign(Path('MailAI.app'))
                run.assert_not_called()

    def test_self_signing_preserves_nested_ids_and_verifies_outer_pin(self):
        env={'MAILAI_SIGNING_MODE':'self-signed','MAILAI_SIGN_IDENTITY':signing.fingerprint(),
             'MAILAI_SIGNING_KEYCHAIN':'isolated.keychain-db'}
        with patch.dict(os.environ,env,clear=True),patch.object(signing,'run') as run,patch.object(signing,'verify') as verify:
            signing.sign(Path('MailAI.app'))
            first,second=[call.args for call in run.call_args_list]
            self.assertIn('--deep',first);self.assertNotIn('--requirements',first)
            self.assertNotIn('--deep',second);self.assertIn('='+signing.requirement(),second)
            self.assertIn('--timestamp=none',first);self.assertNotIn('runtime',first)
            self.assertIn('isolated.keychain-db',first)
            verify.assert_called_once()

    def test_release_has_no_unsigned_fallback_and_runs_real_test(self):
        root=Path(__file__).resolve().parents[1]
        workflow=(root/'.github/workflows/release.yml').read_text()
        self.assertIn('python3 scripts/import_macos_self_signing.py',workflow)
        self.assertIn('python3 scripts/verify_macos_signing_upgrade.py',workflow)
        self.assertNotIn('building unsigned artifacts',workflow)
        build=(root/'scripts/build_macos.command').read_text()
        self.assertIn('elif [[ "${CI:-}" == "1" ]]',build)
        self.assertIn('scripts/smoke_macos_app.py dist/MailAI.app --verify-keychain-query',build)

if __name__=='__main__':unittest.main()
