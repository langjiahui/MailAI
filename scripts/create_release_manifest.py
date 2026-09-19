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


def release_notes_from_readme(path: Path) -> str:
    """Use README's current-update paragraph as the single release-note source."""
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith("本次更新："):
            notes = stripped.removeprefix("本次更新：").strip()
            if notes:
                return notes
    raise ValueError("README 缺少非空的“本次更新：”说明")


def release_body(version: str, notes: str) -> str:
    return f"## MailAI {version} 更新内容\n\n{notes}\n\n安装包会根据 Windows x64、Apple Silicon macOS 或 Linux x64 自动匹配。\n"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--readme", type=Path, default=Path("README.md"))
    parser.add_argument("--notes-output", type=Path)
    parser.add_argument("--notes")
    args = parser.parse_args()
    version = args.version.lstrip("v")
    tag = args.version if args.version.startswith("v") else f"v{version}"
    notes = args.notes.strip() if args.notes else release_notes_from_readme(args.readme)
    names = {
        "windows-x64": "MailAI-Windows-x64-Setup.exe",
        "macos-arm64": "MailAI-macOS-arm64.pkg",
        "linux-x64": "MailAI-Linux-x64.AppImage",
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
        "release_url": f"https://github.com/{args.repository}/releases/tag/{tag}",
        "published_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "notes": notes,
        "assets": assets,
    }
    args.output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.notes_output:
        args.notes_output.write_text(release_body(version, notes), encoding="utf-8")


if __name__ == "__main__":
    main()
