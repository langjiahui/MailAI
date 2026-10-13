"""Sign and verify MailAI using a pinned self-signed identity or Developer ID."""
import argparse
import hashlib
import os
from pathlib import Path
import re
import ssl
import subprocess
import tempfile

PUBLIC_CERT = Path(__file__).resolve().parent/'signing/mailai-self-signed.pem'
IDENTIFIER = 'com.langjiahui.mailai'


def fingerprint():
    return hashlib.sha1(ssl.PEM_cert_to_DER_cert(PUBLIC_CERT.read_text())).hexdigest().upper()


def requirement(identifier=IDENTIFIER):
    if not re.fullmatch(r'[A-Za-z0-9.-]+', identifier):
        raise ValueError('Invalid bundle identifier')
    return f'designated => identifier "{identifier}" and certificate leaf = H"{fingerprint()}"'


def run(*args, **kwargs):
    return subprocess.run(list(map(str,args)), check=True, **kwargs)


def sign(bundle, *, identifier=IDENTIFIER):
    mode = os.environ.get('MAILAI_SIGNING_MODE','developer-id')
    identity = os.environ.get('MAILAI_SIGN_IDENTITY','')
    if not identity:
        raise ValueError('Missing signing identity; refusing an ad-hoc fallback')
    options = []
    if os.environ.get('MAILAI_SIGNING_KEYCHAIN'):
        options += ['--keychain', os.environ['MAILAI_SIGNING_KEYCHAIN']]
    if mode == 'self-signed':
        if identity.upper() != fingerprint():
            raise ValueError('Self-signed identity does not match the pinned certificate')
        # Self-signed code has no Apple Team ID. Hardened runtime's library
        # validation would reject bundled Python extensions without that ID.
        options += ['--timestamp=none']
    elif mode == 'developer-id':
        options += ['--options','runtime','--timestamp']
    else:
        raise ValueError('Unsupported signing mode')
    run('codesign','--force','--deep','--sign',identity,*options,bundle)
    if mode == 'self-signed':
        # Pin only the outer application's DR; nested libraries keep their own IDs.
        run('codesign','--force','--sign',identity,*options,'--identifier',identifier,
            '--requirements','='+requirement(identifier),bundle)
    verify(bundle, mode=mode, identifier=identifier)


def verify(bundle, *, mode, identifier=IDENTIFIER):
    run('codesign','--verify','--deep','--strict',bundle)
    if mode == 'self-signed':
        run('codesign','--verify','--strict','-R','='+requirement(identifier).removeprefix('designated => '),bundle)
        with tempfile.TemporaryDirectory(prefix='mailai-public-cert-') as directory:
            prefix = str(Path(directory)/'cert')
            run('codesign','--display','--extract-certificates='+prefix,bundle,
                stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            if hashlib.sha1(Path(prefix+'0').read_bytes()).hexdigest().upper() != fingerprint():
                raise ValueError('Signed artifact has an unexpected leaf certificate')
        dr = run('codesign','-d','-r-',bundle,capture_output=True,text=True)
        text=dr.stdout+dr.stderr
        actual = next((line.strip() for line in text.splitlines() if line.startswith('designated => ')), '')
        if actual.lower() != requirement(identifier).lower():
            raise ValueError('Application identity must pin the certificate, not this build hash')
    print('Verified application signature and stable identity')

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundle',type=Path)
    parser.add_argument('--verify-only',action='store_true')
    args=parser.parse_args()
    if args.verify_only:
        verify(args.bundle,mode=os.environ.get('MAILAI_SIGNING_MODE','self-signed'))
    else:
        sign(args.bundle)
