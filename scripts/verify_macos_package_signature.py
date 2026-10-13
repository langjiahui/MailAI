"""Verify the installed payload signature, without installing or running it."""
import argparse
import os
from pathlib import Path
import plistlib
import tempfile
from macos_signing import run, verify


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('package',type=Path)
    args=parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='mailai-signed-pkg-') as directory:
        expanded=Path(directory)/'expanded'
        run('pkgutil','--expand-full',args.package,expanded)
        apps=list(expanded.glob('**/Payload/MailAI.app'))
        if len(apps)!=1:raise ValueError('Expected exactly one installed application')
        verify(apps[0],mode=os.environ.get('MAILAI_SIGNING_MODE','developer-id'))
        info=plistlib.loads((apps[0]/'Contents/Info.plist').read_bytes())
        expected=os.environ.get('MAILAI_RELEASE_VERSION')
        if not expected or info.get('CFBundleShortVersionString')!=expected:
            raise ValueError('Installer payload version mismatch')
        print('Verified PKG payload signature and version:',expected)

if __name__=='__main__':main()
