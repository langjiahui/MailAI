"""Real macOS upgrade/negative-control test; synthetic keychain only, UI disabled."""
import argparse
import os
from pathlib import Path
import plistlib
import secrets
import shutil
import subprocess
import sys
import tempfile
from macos_signing import IDENTIFIER, sign, verify, run

SOURCE=Path(__file__).resolve().parents[1]/'tests/fixtures/macos_keychain_identity.c'


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference-app', type=Path)
    args=parser.parse_args()
    if args.reference_app:
        verify(args.reference_app,mode='self-signed')
    if sys.platform!='darwin':raise RuntimeError('Requires macOS')
    if os.environ.get('MAILAI_SIGNING_MODE')!='self-signed':raise ValueError('Requires pinned self-signed identity')
    with tempfile.TemporaryDirectory(prefix='mailai-signing-upgrade-') as directory:
        root=Path(directory)
        keychain=root/'fixture.keychain-db'
        password=secrets.token_urlsafe(32)
        app=root/'MailAI.app'
        def security(*args):
            proc=subprocess.run(['security',*map(str,args)],capture_output=True)
            if proc.returncode:raise RuntimeError(f'Temporary keychain operation failed: {args[0]}')
        def build(variant,identifier=IDENTIFIER,adhoc=False):
            if app.exists():shutil.rmtree(app)
            executable=app/'Contents/MacOS/MailAI';executable.parent.mkdir(parents=True)
            (app/'Contents/Info.plist').write_bytes(plistlib.dumps({
                'CFBundleIdentifier':identifier,'CFBundleExecutable':'MailAI','CFBundlePackageType':'APPL',
                'CFBundleVersion':variant,'CFBundleName':'MailAI Signing Test'}))
            run('xcrun','clang','-Wno-deprecated-declarations',f'-DBUILD_VARIANT="{variant}"',
                SOURCE,'-framework','Security','-framework','CoreFoundation','-o',executable)
            if adhoc:run('codesign','--force','--sign','-',app)
            else:sign(app,identifier=identifier)
            return executable
        def probe(executable,action,allowed):
            result=subprocess.run([str(executable),action,str(keychain)],capture_output=True,text=True,timeout=20)
            if allowed:
                assert result.returncode==0 and 'status=0' in result.stdout, result.stdout+result.stderr
            else:
                assert result.returncode!=0 and any(f'status={code}' in result.stdout for code in (-25308,-25293)), result.stdout+result.stderr
            print(result.stdout.strip())
        try:
            security('create-keychain','-p',password,keychain)
            security('set-keychain-settings','-lut','3600',keychain)
            security('unlock-keychain','-p',password,keychain)
            first=build('1');probe(first,'create',True);probe(first,'read',True)
            second=build('2');probe(second,'read',True);probe(second,'read',True)
            # Same name/path/identifier must not be enough without the private key.
            probe(build('3',adhoc=True),'read',False)
            # Same signer must not grant a different application access either.
            probe(build('4',identifier='com.langjiahui.mailai.unrelated'),'read',False)
            probe(build('5'),'read',True)
            print('PASS: changed builds and fresh processes preserve access; ad-hoc and wrong-ID binaries denied; no authorization UI allowed')
        finally:
            if keychain.exists():security('delete-keychain',keychain)

if __name__=='__main__':main()
