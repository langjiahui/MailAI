"""Application-bound reader policy; all native operations mocked."""
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app import macos_keychain as native

class ReaderTests(unittest.TestCase):
    def test_foreground_and_background_use_only_the_application_native_reader(self):
        for interactive in (False,True):
            with self.subTest(interactive=interactive), patch.object(native,'read',return_value=(0,'fixture-secret')) as read, patch.object(subprocess,'run') as child:
                self.assertEqual(native.read_for_app('MailAI','fixture',interactive=interactive),(0,'fixture-secret'))
                read.assert_called_once_with('MailAI','fixture',interactive=interactive)
                child.assert_not_called()
        self.assertFalse(hasattr(native,'SYSTEM_READER'))
        self.assertFalse(hasattr(native,'_read_system_tool'))

    def test_denial_is_returned_without_another_reader(self):
        with patch.object(native,'read',return_value=(-128,'')) as read, patch.object(subprocess,'run') as child:
            self.assertEqual(native.read_for_app('MailAI','fixture',interactive=True),(-128,''))
            read.assert_called_once();child.assert_not_called()

if __name__=='__main__':unittest.main()
