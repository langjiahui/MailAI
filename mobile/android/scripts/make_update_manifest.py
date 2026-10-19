#!/usr/bin/env python3
"""Create a versioned GitHub update manifest from the signed distribution APK."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('apk', type=Path)
parser.add_argument('--sdk', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
assert args.output.name == 'mailai-android-update.json', 'Use the manifest filename expected by installed Android clients'
args.output.parent.mkdir(parents=True, exist_ok=True)
root = Path(__file__).resolve().parents[1]
version = (root / 'VERSION').read_text().strip()
assert re.fullmatch(r'\d+\.\d+\.\d+(?:-beta\.\d+)?', version)
bin_dir = args.sdk / 'build-tools/35.0.0'
subprocess.run([str(bin_dir / 'apksigner'), 'verify', '--verbose', str(args.apk)], check=True)
info = subprocess.check_output([str(bin_dir / 'aapt'), 'dump', 'badging', str(args.apk)], text=True)
package = re.search(r"package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'", info)
assert package and package[1] == 'com.mailai.mobile' and package[3] == version and int(package[2]) == int((root / 'VERSION_CODE').read_text().strip())
assert args.apk.name == f'MailAI-Android-{version}.apk'
tag = f'android-v{version}'
manifest = dict(schema=1, applicationId=package[1], version=version, code=int(package[2]),
    url=f'https://github.com/langjiahui/MailAI/releases/download/{tag}/{args.apk.name}',
    sha256=hashlib.file_digest(args.apk.open('rb'), 'sha256').hexdigest(), size=args.apk.stat().st_size,
    notes=(root / 'RELEASE.md').read_text()[:12000],
    page=f'https://github.com/langjiahui/MailAI/releases/tag/{tag}')
args.output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
print(f'Update manifest ready: {version} / {manifest["code"]}')
