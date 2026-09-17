"""Offline update contract: device matching, version gating and checksum enforcement."""
import hashlib
import io
import os
import ssl
import subprocess
import sys
import tempfile
import time
import plistlib
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import release_update
from scripts.create_release_manifest import release_body, release_notes_from_readme


class Response(io.BytesIO):
    def __init__(self, value: bytes):
        super().__init__(value)
        self.headers = {"Content-Length": str(len(value))}

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def manifest(version="1.1.0", digest="a" * 64):
    return {
        "version": version,
        "release_url": "https://github.com/langjiahui/MailAI/releases/tag/v1.1.0",
        "notes": "Security and reliability fixes",
        "assets": {
            "windows-x64": {"url": "https://github.com/langjiahui/MailAI/releases/download/v1.1.0/MailAI-Windows-x64-Setup.exe", "sha256": digest},
            "macos-arm64": {"url": "https://github.com/langjiahui/MailAI/releases/download/v1.1.0/MailAI-macOS-arm64.pkg", "sha256": digest},
        },
    }


def main():
    static_dir = Path(__file__).resolve().parents[1] / "app" / "web" / "static"
    update_ui = (static_dir / "index.html").read_text(encoding="utf-8")
    update_js = (static_dir / "app.js").read_text(encoding="utf-8")
    assert 'id="app-device-label"' in update_ui
    assert 'id="app-release-link"' in update_ui
    assert 'id="btn-share-app"' in update_ui and 'id="share-app-dialog"' in update_ui
    assert 'id="btn-copy-share-app"' in update_ui and 'id="btn-native-share-app"' in update_ui
    assert "const MAILAI_SHARE_URL = 'https://github.com/langjiahui/MailAI/releases/latest'" in update_js
    assert 'navigator.clipboard.writeText(MAILAI_SHARE_URL)' in update_js
    assert 'navigator.share({title:' in update_js
    assert 'id="app-release-summary-notes"' in update_ui
    assert 'id="update-download-progress"' in update_ui
    assert '/api/system/update/install/status' in update_js
    assert 'formatUpdateBytes' in update_js and 'update-progress-fill' in update_js
    assert "GitHub Releases" in update_ui
    assert "https://github.com/langjiahui/MailAI/releases/latest" in update_ui
    assert "https://github.com/langjiahui/MailAI" in update_ui
    mac_components = (Path(__file__).resolve().parents[1] / "scripts" / "macos-components.plist").read_text(encoding="utf-8")
    assert "BundleIsVersionChecked" in mac_components and "<false/>" in mac_components
    assert "BundleHasStrictIdentifier" in mac_components and "<false/>" in mac_components
    assert "BundleOverwriteAction" in mac_components and "upgrade" in mac_components
    postinstall = Path(__file__).resolve().parents[1] / "scripts" / "macos_postinstall"
    postinstall_text = postinstall.read_text(encoding="utf-8")
    assert "MailAI.localized/MailAI.app" in postinstall_text
    assert 'launchctl asuser' in postinstall_text and '/usr/bin/open -a "$APP"' in postinstall_text
    windows_installer = (Path(__file__).resolve().parents[1] / "scripts" / "mailai.iss").read_text(encoding="utf-8")
    run_line = next(line for line in windows_installer.splitlines() if line.startswith('Filename: "{app}\\MailAI.exe"'))
    assert "postinstall" in run_line and "skipifsilent" not in run_line
    workflow = (Path(__file__).resolve().parents[1] / ".github/workflows/release.yml").read_text(encoding="utf-8")
    assert "--readme README.md" in workflow and "--notes-file release-notes.md" in workflow
    assert "--generate-notes" not in workflow
    readme = Path(__file__).resolve().parents[1] / "README.md"
    notes = release_notes_from_readme(readme)
    assert notes and notes != "请查看本版本发布说明。"
    assert notes in release_body(release_update.current_version(), notes)
    if sys.platform == "darwin":
        with tempfile.TemporaryDirectory() as folder:
            applications = Path(folder)
            old_app = applications / "MailAI.app"
            new_app = applications / "MailAI.localized" / "MailAI.app"
            for app, identifier, version in ((old_app, "com.legacy.mailai", "1.0.2"), (new_app, "com.langjiahui.mailai", "1.0.4")):
                (app / "Contents" / "MacOS").mkdir(parents=True)
                (app / "Contents" / "MacOS" / "MailAI").write_bytes(b"app")
                with (app / "Contents" / "Info.plist").open("wb") as output:
                    plistlib.dump({"CFBundleDisplayName": "MailAI", "CFBundleExecutable": "MailAI", "CFBundleIdentifier": identifier, "CFBundleShortVersionString": version}, output)
            subprocess.run(["zsh", str(postinstall)], env={**os.environ, "MAILAI_APPLICATIONS_DIR": folder}, check=True)
            with (old_app / "Contents" / "Info.plist").open("rb") as source:
                installed = plistlib.load(source)
            assert installed["CFBundleIdentifier"] == "com.langjiahui.mailai"
            assert installed["CFBundleShortVersionString"] == "1.0.4"
            assert not (applications / "MailAI.localized").exists()
    tls = release_update._ssl_context()
    assert tls.verify_mode == ssl.CERT_REQUIRED and tls.check_hostname
    assert tls.cert_store_stats()["x509_ca"] > 0
    assert release_update.device_key("Windows", "AMD64") == "windows-x64"
    assert release_update.device_key("Darwin", "arm64") == "macos-arm64"
    assert release_update.device_key("Darwin", "x86_64") == "darwin-x86_64"
    with patch.dict(os.environ, {"MAILAI_APP_VERSION": "1.0.0"}), patch.object(release_update, "FROZEN", True):
        result = release_update.evaluate_manifest(manifest(), device="windows-x64")
        assert result["available"] and result["installable"]
        assert result["latest_version"] == "1.1.0"
        assert result["release_url"].endswith("/releases/tag/v1.1.0")
        assert not release_update.evaluate_manifest(manifest("1.0.0"), device="windows-x64")["available"]
        try:
            release_update.evaluate_manifest(manifest(digest="bad"), device="windows-x64")
        except ValueError as exc:
            assert "SHA-256" in str(exc)
        else:
            raise AssertionError("invalid digest accepted")

    payload = b"verified installer bytes"
    asset = {"url": "https://downloads.example.test/MailAI.exe", "sha256": hashlib.sha256(payload).hexdigest()}
    with tempfile.TemporaryDirectory() as folder, patch.object(
        release_update.urllib.request, "urlopen", side_effect=lambda *_args, **_kwargs: Response(payload)
    ):
        target = Path(folder) / "MailAI.exe"
        progress = []
        release_update._download(asset, target, progress=lambda **state: progress.append(state))
        assert target.read_bytes() == payload
        assert {item["phase"] for item in progress} >= {"downloading", "verifying", "verified"}
        assert progress[-1]["downloaded"] == len(payload)
        asset["sha256"] = "0" * 64
        try:
            release_update._download(asset, target)
        except ValueError as exc:
            assert "SHA-256" in str(exc)
        else:
            raise AssertionError("tampered installer accepted")
    def fake_install(progress=None):
        progress(phase="downloading", downloaded=5, total=10, speed_bps=5, message="downloading")
        time.sleep(.03)
        return {"ok": True, "version": "1.1.0", "message": "installer launched"}
    with patch.object(release_update, "download_and_launch", side_effect=fake_install):
        started = release_update.start_install()
        assert started["ok"] and started["running"]
        deadline = time.monotonic() + 2
        while release_update.install_status()["running"] and time.monotonic() < deadline:
            time.sleep(.01)
        state = release_update.install_status()
        assert state["status"] == "completed" and state["phase"] == "launched"
        assert state["version"] == "1.1.0"
    print("PASS release update device selection, version gate and checksum")


if __name__ == "__main__":
    main()
