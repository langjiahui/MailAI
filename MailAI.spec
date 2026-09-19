# -*- mode: python ; coding: utf-8 -*-

import os


release_version = os.environ.get('MAILAI_RELEASE_VERSION', '1.0.12')
build_version = os.environ.get('MAILAI_BUILD_VERSION', '1')


a = Analysis(
    ['run.py'],
    pathex=[],
    binaries=[],
    datas=[('app/web/static', 'app/web/static'), ('mailai.defaults.env', '.'), ('VERSION', '.')],
    hiddenimports=['webview.platforms.cocoa', 'fastembed', 'onnxruntime'],
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
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['build/mailai.icns'],
)
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
    icon='build/mailai.icns',
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
