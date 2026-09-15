"""Create the update manifest from verified release assets."""
import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--notes", default="请查看本版本发布说明。")
    args = parser.parse_args()
    version = args.version.lstrip("v")
    tag = args.version if args.version.startswith("v") else f"v{version}"
    names = {
        "windows-x64": "MailAI-Windows-x64-Setup.exe",
        "macos-arm64": "MailAI-macOS-arm64.pkg",
    }
    assets = {}
    for device, name in names.items():
        path = args.assets / name
        if not path.is_file():
            raise SystemExit(f"Missing release asset: {path}")
        assets[device] = {
            "url": f"https://github.com/{args.repository}/releases/download/{tag}/{name}",
            "sha256": digest(path),
            "size": path.stat().st_size,
        }
    manifest = {
        "version": version,
        "published_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "notes": args.notes,
        "assets": assets,
    }
    args.output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
