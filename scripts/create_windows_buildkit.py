"""Create a clean internal Windows builder without user mail data or source secrets."""
from pathlib import Path
import argparse
import os
import subprocess
import tempfile
import zipfile


ROOT = Path(__file__).resolve().parent.parent
INCLUDE_DIRS = ("app",)
INCLUDE_FILES = (
    "run.py", "requirements.txt", "requirements-build.txt", "README.md",
    "scripts/BUILD_WINDOWS_EXE.bat", "scripts/check_release.py",
    "scripts/smoke_macos_app.py", "scripts/build_macos.command", "scripts/create_windows_buildkit.py",
    "scripts/create_release_manifest.py",
    "scripts/macos-components.plist", "scripts/macos_postinstall",
    "scripts/prepare_bundle_config.py",
    "scripts/prepare_app_icon.py", "scripts/verify_windows_artifact.py",
    "scripts/prepare_windows_version.py", "VERSION",
    "scripts/windows_runtime_hook.py", "scripts/find_inno_setup.py",
    "scripts/mailai.iss",
    ".github/workflows/release.yml",
    "build/mailai.ico",
    "docs/WINDOWS_BUILD_KIT.md",
    "docs/开发者架构与运行机制.md",
)
EXCLUDED_PARTS = {"__pycache__", ".pytest_cache", ".git"}
EXCLUDED_SUFFIXES = {".pyc", ".pyo", ".db", ".eml", ".log"}
TEST_FILES = tuple(sorted(
    path.name for path in (ROOT / "tests").iterdir()
    if path.is_file() and path.name.startswith("test_") and path.suffix in (".py", ".cjs")
))


def allowed(path):
    return (
        "files" not in path.parts
        and not (set(path.parts) & EXCLUDED_PARTS)
        and path.suffix.lower() not in EXCLUDED_SUFFIXES
    )


def verify_archive(archive_path: Path) -> None:
    """Run the release gate from the archive, not from the source checkout.

    This catches tests that accidentally depend on a file omitted from the
    Windows BuildKit before the archive is handed to a Windows machine.
    """
    with tempfile.TemporaryDirectory(prefix="mailai-windows-kit-") as folder:
        extracted = Path(folder) / "kit"
        with zipfile.ZipFile(archive_path) as archive:
            archive.extractall(extracted)
        python = ROOT / ".venv-build" / "bin" / "python"
        environment = os.environ.copy()
        environment["MAILAI_HOME"] = str(Path(folder) / "profile")
        subprocess.run(
            [str(python), str(extracted / "scripts" / "check_release.py")],
            cwd=extracted,
            env=environment,
            check=True,
        )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", default="r6", help="artifact suffix, for example r6")
    args = parser.parse_args()
    version = "".join(ch for ch in args.version if ch.isalnum() or ch in "-._")
    if not version:
        parser.error("version must contain a letter or number")
    output = ROOT / "dist" / f"MailAI-Windows-BuildKit-{version}.zip"
    temporary_output = output.with_suffix(".zip.part")

    build_python = str(ROOT / ".venv-build" / "bin" / "python")
    subprocess.run([build_python, str(ROOT / "scripts" / "prepare_bundle_config.py")], check=True)
    subprocess.run([build_python, str(ROOT / "scripts" / "prepare_app_icon.py")], check=True)
    defaults = ROOT / "mailai.defaults.env"
    try:
        output.parent.mkdir(parents=True, exist_ok=True)
        temporary_output.unlink(missing_ok=True)
        with zipfile.ZipFile(temporary_output, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            archive.write(defaults, "mailai.defaults.env")
            archive.write(ROOT / "scripts" / "BUILD_WINDOWS_EXE.bat", "BUILD_WINDOWS_EXE.bat")
            for relative in INCLUDE_FILES:
                if relative == "scripts/BUILD_WINDOWS_EXE.bat":
                    continue
                archive.write(ROOT / relative, relative)
            for name in TEST_FILES:
                archive.write(ROOT / "tests" / name, f"tests/{name}")
            for directory in INCLUDE_DIRS:
                for path in (ROOT / directory).rglob("*"):
                    if path.is_file() and allowed(path.relative_to(ROOT)):
                        archive.write(path, path.relative_to(ROOT).as_posix())
        verify_archive(temporary_output)
        temporary_output.replace(output)
        print(f"Created clean internal build kit: {output}")
    finally:
        temporary_output.unlink(missing_ok=True)
        defaults.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
