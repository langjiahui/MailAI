#!/usr/bin/env python3
"""Build a real arm64 iOS app and package an explicitly unsigned, re-signable IPA."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def run(*args):
    subprocess.run(args, cwd=ROOT, check=True)


def version_metadata():
    version = (ROOT / "VERSION").read_text().strip()
    build = (ROOT / "BUILD_NUMBER").read_text().strip()
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version) or not build.isdecimal() or int(build) < 1:
        raise SystemExit("Invalid independent iOS version/build number")
    spec = (ROOT / "project.yml").read_text()
    if f"MARKETING_VERSION: '{version}'" not in spec or f"CURRENT_PROJECT_VERSION: '{build}'" not in spec:
        raise SystemExit("project.yml must match iOS VERSION and BUILD_NUMBER")
    return version, build


def package(app, output, version, build):
    info = plistlib.loads((app / "Info.plist").read_bytes())
    expected = {"CFBundleIdentifier": "com.mailai.ios", "CFBundleShortVersionString": version,
                "CFBundleVersion": build, "CFBundleSupportedPlatforms": ["iPhoneOS"]}
    for key, value in expected.items():
        if info.get(key) != value:
            raise SystemExit(f"Unexpected application metadata: {key}")
    executable = app / info["CFBundleExecutable"]
    architectures = subprocess.check_output(["lipo", "-archs", str(executable)], text=True).split()
    if architectures != ["arm64"]:
        raise SystemExit("Expected an arm64 device executable")
    output.mkdir(parents=True, exist_ok=True)
    ipa = output / f"MailAI-iOS-{version}-unsigned.ipa"
    if ipa.exists():
        raise SystemExit("Refusing to overwrite an existing IPA")
    with zipfile.ZipFile(ipa, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(app.rglob("*")):
            if path.is_file():
                archive.write(path, Path("Payload") / app.name / path.relative_to(app))
    digest = hashlib.sha256(ipa.read_bytes()).hexdigest()
    ipa.with_suffix(".ipa.sha256").write_text(f"{digest}  {ipa.name}\n")
    manifest = {"platform": "ios", "channel": "beta", "version": version, "build": build,
                "bundle_id": "com.mailai.ios", "minimum_ios": "18.0", "architecture": "arm64",
                "signing": "unsigned-requires-device-signing", "installable_directly": False,
                "file": ipa.name, "size": ipa.stat().st_size, "sha256": digest,
                "source_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()}
    (output / "ios-build-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    shutil.copy2(ROOT / "INSTALL.md", output / "INSTALL-iOS.md")
    print(json.dumps(manifest, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "build" / "distribution")
    args = parser.parse_args()
    version, build = version_metadata()
    # CI retries get a distinct internal build number, without advancing the product version.
    if os.environ.get("GITHUB_RUN_NUMBER"):
        build = str(int(os.environ["GITHUB_RUN_NUMBER"]) * 100 + int(os.environ.get("GITHUB_RUN_ATTEMPT", "1")))
    run("xcodegen", "generate")
    lock = ROOT / "Dependencies.resolved"
    resolved = ROOT / "MailAI.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"
    if lock.exists():
        resolved.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(lock, resolved)
    derived = ROOT / "build/DerivedData"
    run("xcodebuild", "-project", "MailAI.xcodeproj", "-scheme", "MailAI", "-configuration", "Release",
        "-destination", "generic/platform=iOS", "-derivedDataPath", str(derived),
        "CODE_SIGNING_ALLOWED=NO", "CODE_SIGNING_REQUIRED=NO", "CODE_SIGN_IDENTITY=",
        f"CURRENT_PROJECT_VERSION={build}", f"MARKETING_VERSION={version}", "build")
    if resolved.exists(): shutil.copy2(resolved, ROOT / "build/Dependencies.resolved")
    package(derived / "Build/Products/Release-iphoneos/MailAI.app", args.output.resolve(), version, build)


if __name__ == "__main__":
    main()
