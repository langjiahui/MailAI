"""Locate an installed Inno Setup compiler without depending on winget status."""
import os
from pathlib import Path
import shutil


def registry_directories():
    try:
        import winreg
    except ImportError:
        return
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        for view in (winreg.KEY_WOW64_32KEY, winreg.KEY_WOW64_64KEY):
            try:
                with winreg.OpenKey(hive, r'Software\Microsoft\Windows\CurrentVersion\Uninstall',
                                    0, winreg.KEY_READ | view) as parent:
                    for index in range(winreg.QueryInfoKey(parent)[0]):
                        try:
                            with winreg.OpenKey(parent, winreg.EnumKey(parent, index)) as key:
                                name = winreg.QueryValueEx(key, 'DisplayName')[0]
                                if str(name).startswith('Inno Setup'):
                                    yield winreg.QueryValueEx(key, 'InstallLocation')[0]
                        except OSError:
                            continue
            except OSError:
                continue


def find_compiler():
    candidates = [os.environ.get('ISCC', ''), shutil.which('ISCC.exe') or '']
    for variable in ('ProgramFiles(x86)', 'ProgramFiles', 'LOCALAPPDATA'):
        base = os.environ.get(variable)
        if base:
            candidates.extend(str(Path(base) / suffix / 'ISCC.exe') for suffix in
                              ('Inno Setup 6', 'Programs/Inno Setup 6'))
    candidates.extend(str(Path(folder) / 'ISCC.exe') for folder in registry_directories() if folder)
    return next((str(Path(p).resolve()) for p in candidates if p and Path(p).is_file()), None)


if __name__ == '__main__':
    compiler = find_compiler()
    if compiler:
        print(compiler)
    else:
        raise SystemExit(1)
