"""Import the existing release identity into an isolated build keychain."""
import base64
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
from macos_signing import fingerprint


def main():
    encoded=os.environ.get('MACOS_SELF_SIGN_CERTIFICATE','')
    password=os.environ.get('MACOS_SELF_SIGN_PASSWORD','')
    if not encoded or not password:
        raise ValueError('Fixed signing credentials are required; no unsigned release fallback')
    root=Path(os.environ['RUNNER_TEMP'])
    keychain=root/'mailai-self-signing.keychain-db'
    if keychain.exists():
        raise ValueError('Build keychain already exists')
    key_password=secrets.token_urlsafe(40)
    def security(*args):
        # Never echo commands or tool errors that may contain secret arguments.
        result=subprocess.run(['security',*map(str,args)],capture_output=True)
        if result.returncode:
            raise RuntimeError(f'Signing keychain operation {args[0]} failed ({result.returncode})')
    try:
        security('create-keychain','-p',key_password,keychain)
        security('set-keychain-settings','-lut','21600',keychain)
        security('unlock-keychain','-p',key_password,keychain)
        with tempfile.NamedTemporaryFile(dir=root,suffix='.p12') as stream:
            os.chmod(stream.name,0o600)
            stream.write(base64.b64decode(encoded,validate=True));stream.flush()
            security('import',stream.name,'-P',password,'-T','/usr/bin/codesign','-k',keychain)
        security('set-key-partition-list','-S','apple-tool:,apple:','-s','-k',key_password,keychain)
        # Explicit --keychain is used by codesign. No login/default keychain edits.
        with open(os.environ['GITHUB_ENV'],'a') as output:
            output.write(f'MAILAI_SIGNING_MODE=self-signed\nMAILAI_SIGN_IDENTITY={fingerprint()}\nMAILAI_SIGNING_KEYCHAIN={keychain}\n')
        print('Imported fixed self-signed identity into isolated build keychain')
    except BaseException:
        if keychain.exists():
            subprocess.run(['security','delete-keychain',str(keychain)],capture_output=True)
        raise

if __name__=='__main__':main()
