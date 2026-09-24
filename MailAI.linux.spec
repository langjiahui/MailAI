# -*- mode: python ; coding: utf-8 -*-

# Linux onedir 构建：run.py 在 Linux 上走 uvicorn + 系统浏览器路径，
# 不依赖 pywebview/GTK，因此不需要平台 hiddenimports 或 BUNDLE。

import os


release_version = os.environ.get('MAILAI_RELEASE_VERSION', '1.0.12')
build_version = os.environ.get('MAILAI_BUILD_VERSION', '1')


a = Analysis(
    ['run.py'],
    pathex=[],
    binaries=[],
    datas=[('app/web/static', 'app/web/static'), ('mailai.defaults.env', '.'), ('VERSION', '.')],
    hiddenimports=['fastembed', 'onnxruntime', 'qcloud_cos'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # run.py 里 darwin/win32 的桌面壳分支在 Linux 不会执行；排除以免
    # 静态分析拉入未安装的 pywebview / pyobjc / pystray。
    excludes=['webview', 'pyobjc', 'pystray', 'app.desktop', 'app.windows_desktop'],
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
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='MailAI',
)
