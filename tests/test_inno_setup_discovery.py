"""Compiler discovery supports per-user, custom and explicit installations."""
import os
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from scripts.find_inno_setup import find_compiler


def main():
    with tempfile.TemporaryDirectory() as folder:
        root = Path(folder)
        compiler = root / 'Programs' / 'Inno Setup 6' / 'ISCC.exe'
        compiler.parent.mkdir(parents=True)
        compiler.touch()
        with patch.dict(os.environ, {'LOCALAPPDATA': folder}, clear=True), \
             patch('scripts.find_inno_setup.shutil.which', return_value=None), \
             patch('scripts.find_inno_setup.registry_directories', return_value=[]):
            assert find_compiler() == str(compiler.resolve())
            compiler.unlink()
            assert find_compiler() is None
        custom = root / 'custom' / 'ISCC.exe'
        custom.parent.mkdir(); custom.touch()
        with patch.dict(os.environ, {}, clear=True), \
             patch('scripts.find_inno_setup.shutil.which', return_value=None), \
             patch('scripts.find_inno_setup.registry_directories', return_value=[str(custom.parent)]):
            assert find_compiler() == str(custom.resolve())
        with patch.dict(os.environ, {'ISCC': str(custom)}, clear=True):
            assert find_compiler() == str(custom.resolve())
    print('PASS Inno Setup per-user, registry and explicit path discovery')


if __name__ == '__main__':
    main()
