# -*- mode: python ; coding: utf-8 -*-

import os
import hashlib
from pathlib import Path

from PyInstaller.utils import osx as osxutils


release_version = os.environ.get('MAILAI_RELEASE_VERSION', '1.0.12')
build_version = os.environ.get('MAILAI_BUILD_VERSION', '1')
icon_hash = hashlib.sha256(Path('app/web/static/assets/mailai-app-icon-1024.png').read_bytes()).hexdigest()[:12]
macos_icon = f'build/mailai-{icon_hash}.icns'


a = Analysis(
    ['run.py'],
    pathex=[],
    binaries=[],
    datas=[('app/web/static', 'app/web/static'), ('app/native', 'app/native'), ('mailai.defaults.env', '.'), ('VERSION', '.')],
    hiddenimports=['webview.platforms.cocoa', 'UserNotifications', 'fastembed', 'onnxruntime', 'qcloud_cos', 'dingtalk_stream', 'qrcode.image.pil', 'xlutils.filter', 'xlwt', 'xlrd', 'olefile', 'lxml.etree'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='MailAI',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=os.environ.get('MAILAI_MACOS_BUILD_ARCH'),
    codesign_identity=None,
    entitlements_file=None,
    icon=[macos_icon],
)

# PyInstaller caps the launcher's SDK at Python's SDK for Tk compatibility.
# MailAI uses AppKit via PyObjC. Preserve the SDK linked by the bootloader so
# macOS can select its native window controls without raising the deployment target.
bootloader_sdk = osxutils.get_macos_sdk_version(exe.exefiles[0][1])
if bootloader_sdk < (26, 0, 0):
    raise SystemExit('MailAI requires a PyInstaller bootloader linked with macOS SDK 26 or newer.')
if osxutils.get_macos_sdk_version(exe.name) != bootloader_sdk:
    osxutils.set_macos_sdk_version(exe.name, *bootloader_sdk)
    osxutils.sign_binary(exe.name, exe.codesign_identity, exe.entitlements_file)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='MailAI',
)
app = BUNDLE(
    coll,
    name='MailAI.app',
    icon=macos_icon,
    bundle_identifier='com.langjiahui.mailai',
    info_plist={
        'CFBundleDisplayName': 'MailAI',
        'CFBundleShortVersionString': release_version,
        'CFBundleVersion': build_version,
        'LSApplicationCategoryType': 'public.app-category.productivity',
        'LSMultipleInstancesProhibited': True,
        'NSHighResolutionCapable': True,
    },
)
