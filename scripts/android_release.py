#!/usr/bin/env python3
"""Android-only release transaction. Signing secrets never enter this script's output."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

REPO = 'langjiahui/MailAI'
PACKAGE = 'com.mailai.mobile'
SIGNER = '415c2ff611048d705ec4f516b6156dbbd4af8c2ad75d0feab81abae1e241dd97'
VERSION = re.compile(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)')
MANIFEST = 'mailai-android-update.json'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def run(*args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def gh(*args):
    return run('gh', *args)


def metadata(source):
    android = source / 'mobile/android'
    version = (android / 'VERSION').read_text().strip()
    code = (android / 'VERSION_CODE').read_text().strip()
    require(VERSION.fullmatch(version), 'Android VERSION must be a formal semantic version')
    require(code.isdigit() and 0 < int(code) < 2100000000, 'Invalid Android VERSION_CODE')
    notes = (android / 'RELEASE.md').read_text()
    for label in ('基准版本', '变更类型', '目标版本', '判断依据'):
        require(label in notes, f'Android RELEASE.md is missing {label}')
    require(version in notes, 'Release notes do not describe the target version')
    return dict(version=version, code=int(code), tag=f'android-v{version}',
                sourceCommit=run('git', 'rev-parse', 'HEAD', cwd=source), notes=notes)


def compare_version(previous, target, change):
    require(VERSION.fullmatch(previous) and VERSION.fullmatch(target), 'Invalid formal version')
    old, new = tuple(map(int, previous.split('.'))), tuple(map(int, target.split('.')))
    expected = {'PATCH': (old[0], old[1], old[2] + 1),
                'MINOR': (old[0], old[1] + 1, 0),
                'MAJOR': (old[0] + 1, 0, 0)}
    require(change in expected and new == expected[change], 'Version does not match declared change class')


def check_plan(info, published, baseline=None):
    tag = info['tag']
    existing = next((r for r in published if r['tag_name'] == tag and not r['draft']), None)
    require(existing is None, 'Version already published; never overwrite a published APK or tag')
    if baseline:
        require(info['code'] > baseline['code'], 'Installation code must increase')
        match = re.search(r'变更类型[：:]\s*(MAJOR|MINOR|PATCH)', info['notes'])
        require(match, 'Release notes need a declared MAJOR/MINOR/PATCH')
        require(f"android-v{baseline['version']}" in info['notes'], 'Release baseline is stale')
        compare_version(baseline['version'], info['version'], match[1])


def remote_releases():
    pages = json.loads(gh('api', '--paginate', '--slurp', f'repos/{REPO}/releases?per_page=100'))
    return [r for page in pages for r in page]


def require_tag_source(tag, commit):
    result = subprocess.run(['gh', 'api', f'repos/{REPO}/git/ref/tags/{tag}'],
                            capture_output=True, text=True)
    if result.returncode:
        require('404' in result.stderr, 'Unable to resolve existing release tag')
        return
    value = json.loads(result.stdout)['object']
    for _ in range(4):
        if value['type'] == 'commit':
            require(value['sha'] == commit, 'Existing release tag points to a different source commit')
            return
        require(value['type'] == 'tag', 'Release tag does not reference a commit')
        value = json.loads(gh('api', f"repos/{REPO}/git/tags/{value['sha']}"))['object']
    raise ValueError('Unexpected nested release tags')


def remote_baseline():
    # Published_at is used rather than /releases/latest: the latter belongs to Web/desktop.
    releases = remote_releases()
    candidates = sorted((r for r in releases if not r['draft'] and not r['prerelease'] and
                         VERSION.fullmatch(r['tag_name'].removeprefix('android-v')) and
                         r['tag_name'].startswith('android-v')),
                        key=lambda r: r['published_at'], reverse=True)
    if not candidates:
        return releases, None
    with tempfile.TemporaryDirectory() as temp:
        gh('release', 'download', candidates[0]['tag_name'], '--repo', REPO,
           '--pattern', MANIFEST, '--dir', temp)
        value = json.loads((Path(temp) / MANIFEST).read_text())
        validate_manifest(value)
        return releases, value


def validate_manifest(value):
    version = value.get('version', '')
    require(VERSION.fullmatch(version), 'Update version is not formal')
    tag = f'android-v{version}'
    prefix = f'https://github.com/{REPO}/releases'
    require(value.get('schema') == 1 and value.get('applicationId') == PACKAGE,
            'Update schema/package mismatch')
    require(isinstance(value.get('code'), int) and 0 < value['code'] < 2100000000,
            'Invalid installation code')
    require(value.get('page') == f'{prefix}/tag/{tag}', 'Unexpected release page')
    require(value.get('url') == f'{prefix}/download/{tag}/MailAI-Android-{version}.apk',
            'Unexpected APK address')
    require(isinstance(value.get('size'), int) and 0 < value['size'] <= 100 * 1024 * 1024,
            'Invalid APK size')
    require(re.fullmatch(r'[a-f0-9]{64}', value.get('sha256', '')), 'Invalid APK hash')


def inspect_apk(apk, sdk, info):
    tools = sdk / 'build-tools/35.0.0'
    signed = run(str(tools / 'apksigner'), 'verify', '--verbose', '--print-certs', str(apk))
    signers = re.findall(r'Signer #\d+ certificate SHA-256 digest: ([a-fA-F0-9]+)', signed)
    require(len(signers) == 1 and signers[0].lower() == SIGNER, 'Fixed Android signer mismatch')
    run(str(tools / 'zipalign'), '-c', '-P', '16', '4', str(apk))
    badging = run(str(tools / 'aapt'), 'dump', 'badging', str(apk))
    package = re.search(r"package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'", badging)
    require(package and package[1] == PACKAGE and int(package[2]) == info['code'] and
            package[3] == info['version'], 'Signed APK metadata differs from Android VERSION files')
    require('application-debuggable' not in badging, 'Debuggable APK cannot be distributed')
    require("application-label:'MailAI'" in badging, 'Unexpected application label')
    import zipfile
    with zipfile.ZipFile(apk) as archive:
        require(not any(n.endswith(('.p12', '.jks', '.keystore')) for n in archive.namelist()),
                'APK contains signing material')


def package(source, sdk, output, publish):
    info = metadata(source)
    releases, baseline = remote_baseline()
    check_plan(info, releases, baseline)
    if publish:
        require(not re.search(r'本地开发与验收目标|尚未创建正式发布|尚未发布', info['notes']),
                'Finish release notes before publishing; development targets cannot be published')
        readme = (source / 'mobile/android/README.md').read_text()
        root_readme = (source / 'README.md').read_text()
        require(re.search(r'当前 Android 正式版本[^\n]*' + re.escape(info['version']), readme),
                'Android README formal version is not updated')
        require(re.search(r'Android[^\n]*' + re.escape(info['version']), root_readme),
                'Root README Android version is not updated')
    original = source / 'mobile/android/app/build/outputs/apk/release/app-release.apk'
    inspect_apk(original, sdk, info)
    output.mkdir(parents=True, exist_ok=True)
    apk = output / f"MailAI-Android-{info['version']}.apk"
    shutil.copyfile(original, apk)
    prefix = f'https://github.com/{REPO}/releases'
    value = dict(schema=1, applicationId=PACKAGE, version=info['version'], code=info['code'],
                 url=f"{prefix}/download/{info['tag']}/{apk.name}",
                 sha256=hashlib.sha256(apk.read_bytes()).hexdigest(), size=apk.stat().st_size,
                 notes=info['notes'][:12000], page=f"{prefix}/tag/{info['tag']}")
    validate_manifest(value)
    (output / MANIFEST).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    (output / 'RELEASE.md').write_text(info['notes'])
    (output / 'verification.json').write_text(json.dumps(dict(
        sourceCommit=info['sourceCommit'], version=info['version'], code=info['code'],
        signerSha256=SIGNER, apkSha256=value['sha256'], baseline=baseline,
        mode='publish' if publish else 'acceptance-only',
        checks=['JVM tests', 'release lint', 'APK metadata', 'fixed signer', 'zipalign',
                'update manifest', 'version progression']), ensure_ascii=False, indent=2) + '\n')
    (output / 'SHA256SUMS.txt').write_text(''.join(
        hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + p.name + '\n'
        for p in sorted(output.iterdir()) if p.is_file() and p.name != 'SHA256SUMS.txt'))
    print(f"Verified Android {info['version']} ({info['code']}), source {info['sourceCommit']}")


def verify_public(output, sdk):
    expected = json.loads((output / MANIFEST).read_text())
    validate_manifest(expected)
    tag = f"android-v{expected['version']}"
    release = json.loads(gh('api', f'repos/{REPO}/releases/tags/{tag}'))
    require(not release['draft'] and not release['prerelease'], 'Release not public/formal')
    evidence = json.loads((output / 'verification.json').read_text())
    require_tag_source(tag, evidence['sourceCommit'])
    assets = {a['name']: a for a in release['assets']}
    apk_name = Path(expected['url']).name
    require(apk_name in assets and MANIFEST in assets, 'Release assets incomplete')
    require(assets[apk_name]['size'] == expected['size'], 'Published APK size mismatch')
    with tempfile.TemporaryDirectory() as temp:
        gh('release', 'download', tag, '--repo', REPO, '--pattern', MANIFEST,
           '--pattern', apk_name, '--dir', temp)
        actual = json.loads((Path(temp) / MANIFEST).read_text())
        require(actual == expected, 'Public update manifest differs from verified build')
        apk = Path(temp) / apk_name
        require(hashlib.sha256(apk.read_bytes()).hexdigest() == expected['sha256'],
                'Public APK hash differs from update manifest')
        inspect_apk(apk, sdk, expected)
    print(f'PASS: public Android {expected["version"]} manifest, APK hash, metadata and signer')


def publish(output, sdk):
    value = json.loads((output / MANIFEST).read_text())
    validate_manifest(value)
    evidence = json.loads((output / 'verification.json').read_text())
    require(evidence['mode'] == 'publish', 'Acceptance build must never be published')
    apk = output / Path(value['url']).name
    inspect_apk(apk, sdk, value)
    require(hashlib.sha256(apk.read_bytes()).hexdigest() == value['sha256'], 'Artifact changed')
    tag = f"android-v{value['version']}"
    require_tag_source(tag, evidence['sourceCommit'])
    existing = next((r for r in remote_releases() if r['tag_name'] == tag), None)
    if existing:
        if not existing['draft']:
            # Retry only verifies the existing publication. It can never overwrite it.
            verify_public(output, sdk)
            return
        require(existing['target_commitish'] == evidence['sourceCommit'], 'Draft source mismatch')
    else:
        gh('release', 'create', tag, '--repo', REPO, '--draft', '--latest=false',
           '--target', evidence['sourceCommit'], '--title', f"MailAI Android {value['version']}",
           '--notes-file', str(output / 'RELEASE.md'))
    remote = next(r for r in remote_releases() if r['tag_name'] == tag)
    assets = {a['name']: a for a in remote['assets']}
    for file in sorted(output.iterdir()):
        if not file.is_file():
            continue
        if file.name in assets:
            digest = 'sha256:' + hashlib.sha256(file.read_bytes()).hexdigest()
            require(assets[file.name].get('digest') == digest, 'Existing draft asset differs; refusing overwrite')
        else:
            gh('release', 'upload', tag, str(file), '--repo', REPO)
    # No stable channel sees the candidate until every verified asset is uploaded.
    gh('release', 'edit', tag, '--repo', REPO, '--draft=false', '--prerelease=false', '--latest=false')
    verify_public(output, sdk)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['package', 'publish', 'verify'])
    parser.add_argument('--source', type=Path, default=Path('.'))
    parser.add_argument('--sdk', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--formal', action='store_true')
    args = parser.parse_args()
    if args.action == 'package':
        package(args.source.resolve(), args.sdk.resolve(), args.output.resolve(), args.formal)
    elif args.action == 'publish':
        publish(args.output.resolve(), args.sdk.resolve())
    else:
        verify_public(args.output.resolve(), args.sdk.resolve())


if __name__ == '__main__':
    main()
