"""Offline update contract: device matching, version gating and checksum enforcement."""
import hashlib
import io
import os
import ssl
import subprocess
import sys
import tempfile
import plistlib
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import release_update


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
    assert 'id="app-device-label"' in update_ui
    assert 'id="app-release-link"' in update_ui
    assert "GitHub Releases" in update_ui
    assert "https://github.com/langjiahui/MailAI/releases/latest" in update_ui
    assert "https://github.com/langjiahui/MailAI" in update_ui
    mac_components = (Path(__file__).resolve().parents[1] / "scripts" / "macos-components.plist").read_text(encoding="utf-8")
    assert "BundleIsVersionChecked" in mac_components and "<false/>" in mac_components
    assert "BundleHasStrictIdentifier" in mac_components and "<false/>" in mac_components
    assert "BundleOverwriteAction" in mac_components and "upgrade" in mac_components
    postinstall = Path(__file__).resolve().parents[1] / "scripts" / "macos_postinstall"
    assert "MailAI.localized/MailAI.app" in postinstall.read_text(encoding="utf-8")
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
        release_update._download(asset, target)
        assert target.read_bytes() == payload
        asset["sha256"] = "0" * 64
        try:
            release_update._download(asset, target)
        except ValueError as exc:
            assert "SHA-256" in str(exc)
        else:
            raise AssertionError("tampered installer accepted")
    print("PASS release update device selection, version gate and checksum")


if __name__ == "__main__":
    main()
