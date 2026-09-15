"""Installer upgrade contract: stable identity, program-only cleanup, stable data and credentials."""
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from unittest.mock import patch
from app import paths, credential_store

def main():
 root=Path(__file__).resolve().parents[1]
 text=(root/'scripts/mailai.iss').read_text()
 kit=(root/'scripts/create_windows_buildkit.py').read_text()
 for dependency in ['"scripts/create_release_manifest.py"', '"scripts/macos-components.plist"', '"scripts/macos_postinstall"', '".github/workflows/release.yml"', '"README.md"']:
  assert dependency in kit, f'Windows BuildKit must include release-gate dependency {dependency}'
 assert 'AppId={{7B538711-BF4A-49DE-9FB5-7C670120F2DE}' in text
 for option in ['UsePreviousAppDir=yes','UsePreviousTasks=yes','DisableDirPage=auto','PrivilegesRequired=lowest']:
  assert option in text
 section=text.split('[InstallDelete]')[1].split('[Files]')[0]
 entries=[line.strip() for line in section.splitlines() if line.strip().startswith('Type:')]
 assert entries==['Type: filesandordirs; Name: "{app}\\_internal"']
 assert '[UninstallDelete]' not in text
 assert 'UninstallString' not in text
 welcome=text.split('procedure InitializeWizard();')[1].split('function PrepareToInstall')[0]
 assert 'ExpandConstant' not in welcome, 'Early wizard initialization must not expand runtime directory constants'
 assert 'FileExists' not in welcome
 assert '安装或更新 MailAI' in welcome
 assert credential_store.SERVICE=='MailAI'
 with patch.object(paths.sys,'platform','win32'),patch.dict(paths.os.environ,{'LOCALAPPDATA':'C:/Users/Test/AppData/Local','MAILAI_HOME':''}):
  assert paths._default_user_dir()==Path('C:/Users/Test/AppData/Local/MailAI')
 assert 'DefaultDirName={localappdata}\\Programs\\MailAI' in text
 print('PASS upgrade identity, program-only cleanup, retained user data path and credential namespace')
if __name__=='__main__':main()
