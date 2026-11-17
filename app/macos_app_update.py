"""Prepare a verified macOS application and hand it off after MailAI exits."""
import json
import logging
import os
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

from .paths import APP_DIR, FROZEN, USER_DIR

log = logging.getLogger(__name__)
IDENTIFIER = 'com.langjiahui.mailai'


def _installed_bundle():
    from . import desktop
    if not FROZEN or sys.platform != 'darwin' or not desktop._runtime or desktop._runtime.quitting:
        return None
    executable = Path(sys.executable).resolve()
    if len(executable.parents) < 3:
        return None
    bundle = executable.parents[2]
    if (executable.relative_to(bundle).parts != ('Contents', 'MacOS', 'MailAI')
            or bundle.suffix != '.app' or not os.access(bundle.parent, os.W_OK | os.X_OK)
            or bundle.stat().st_uid != os.getuid() or not os.access(bundle, os.W_OK)
            or not (bundle / 'Contents' / '_CodeSignature' / 'CodeResources').is_file()):
        return None
    return bundle


def eligible():
    try:
        saved = json.loads((USER_DIR / 'updates/ready-update.json').read_text(encoding='utf-8'))
        from .release_update import current_version, _version_tuple
        if saved.get('requires_installer') and _version_tuple(saved['version']) > _version_tuple(current_version()):
            return False
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        pass
    return _installed_bundle() is not None


def _run(*command, timeout=60):
    return subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT, check=True, timeout=timeout).stdout


def _verify_bundle(current, updated, version):
    with (updated / 'Contents' / 'Info.plist').open('rb') as stream:
        info = plistlib.load(stream)
    if (info.get('CFBundleIdentifier') != IDENTIFIER or info.get('CFBundleExecutable') != 'MailAI'
            or info.get('CFBundleShortVersionString') != version):
        raise ValueError('应用更新包与目标版本不一致。')
    _run('/usr/bin/codesign', '--verify', '--strict', str(current))
    requirement_output = _run('/usr/bin/codesign', '-d', '-r-', str(current)).decode('utf-8')
    requirement = next((line.removeprefix('designated => ') for line in requirement_output.splitlines()
                        if line.startswith('designated => ')), '')
    if not requirement:
        raise ValueError('无法确认当前应用的签名身份。')
    _run('/usr/bin/codesign', '--verify', '--deep', '--strict', '-R', '=' + requirement, str(updated))


def install(archive, version):
    from . import desktop
    from .account_guard import guard
    from .draft_lifecycle import request_safe_exit

    current = _installed_bundle()
    if not current:
        raise ValueError('当前安装位置无法自动更新，请从发布页运行 PKG 安装包。')
    runtime = desktop._runtime
    stage = Path(tempfile.mkdtemp(prefix='.mailai-update-', dir=current.parent))
    update_dir = USER_DIR / 'updates'
    pending = update_dir / 'install-pending.json'
    outcome = update_dir / 'install-outcome.txt'
    boot_token = uuid.uuid4().hex
    checkpoint = update_dir / f'.install-pending-{boot_token}.json'
    started = False
    reserved = False
    try:
        try:
            _run('/usr/bin/ditto', '-x', '-k', str(archive), str(stage), timeout=180)
            _verify_bundle(current, stage / 'MailAI.app', version)
        except (OSError, subprocess.SubprocessError, plistlib.InvalidFileException) as exc:
            raise ValueError('应用更新包校验失败，请从发布页下载 PKG 安装包。') from exc
        helper = stage / 'apply.zsh'
        shutil.copyfile(APP_DIR / 'app' / 'native' / 'apply_macos_update.zsh', helper)
        # Wait before closing editors. The final lease is taken immediately
        # after saving, so a long-running operation cannot leave time for a
        # newly opened editor to gain unsaved changes before shutdown.
        deadline = time.monotonic() + 15
        while not guard.acquire(exclusive=True):
            if time.monotonic() >= deadline:
                raise ValueError('邮件仍在处理，请稍后重试更新。')
            time.sleep(.2)
        guard.release(exclusive=True)
        saved, completed = threading.Event(), threading.Event()

        def drafts_saved():
            saved.set()
            completed.set()

        request_safe_exit(runtime, drafts_saved, on_cancel=completed.set)
        if not completed.wait(22) or not saved.is_set():
            raise ValueError('草稿尚未保存，更新已暂缓。')

        # The shared account lease covers SMTP delivery, sync and account
        # operations. Retain the exclusive lease until the process exits.
        reserved = guard.acquire(exclusive=True)
        if not reserved:
            raise ValueError('邮件仍在处理，请稍后重试更新。')
        for path in (outcome, update_dir / 'install-output.log'):
            path.unlink(missing_ok=True)
        checkpoint.write_text(json.dumps({
            'version': version, 'started_at': time.time(), 'method': 'mac-app',
        }), encoding='utf-8')
        checkpoint.replace(pending)
        try:
            with (update_dir / 'install-output.log').open('ab') as output:
                helper_process = subprocess.Popen(
                    ['/bin/zsh', '-f', str(helper), str(os.getpid()), str(current), str(stage),
                     str(update_dir), boot_token],
                    stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
                    start_new_session=True, close_fds=True,
                )
        except OSError:
            pending.unlink(missing_ok=True)
            raise
        started = True
        guard.set_stopping(True)

        def release_failed_handoff():
            # Only reachable if the old process is still alive after the helper
            # timed out waiting for it. Restore normal API and update controls.
            helper_process.wait()
            guard.set_stopping(False)
            guard.release(exclusive=True)
            runtime.quitting = False
            from .release_update import _set_install_state
            _set_install_state(status='failed', phase='failed', running=False,
                               error='MailAI 未能退出，请稍后重试更新。')

        threading.Thread(target=release_failed_handoff, daemon=True, name='mailai-update-handoff').start()
        runtime._finish_quit()
    finally:
        if not started:
            if reserved:
                guard.release(exclusive=True)
            shutil.rmtree(stage, ignore_errors=True)
            checkpoint.unlink(missing_ok=True)


def confirm_startup(window):
    """Confirm that the updated window has loaded the application scripts."""
    token = os.environ.get('MAILAI_UPDATE_BOOT_TOKEN', '')
    if re.fullmatch(r'[a-f0-9]{32}', token):
        try:
            if window.evaluate_js('typeof window.mailaiPrepareExit === "function"') is not True:
                return
            window.show()
            (USER_DIR / 'updates' / f'boot-{token}').touch(mode=0o600, exist_ok=False)
            os.environ.pop('MAILAI_UPDATE_BOOT_TOKEN', None)
        except Exception:
            log.exception('无法确认更新后启动')
