#!/bin/zsh
set -e
cd "${0:A:h}/.."

# 唯一版本号可防止 LaunchServices 把构建目录、挂载盘与正式安装目录里的
# 同标识应用误认为同一个临时副本。
export MAILAI_RELEASE_VERSION="${MAILAI_RELEASE_VERSION:-1.$(date +%Y%m%d).$(date +%H%M)}"
export MAILAI_BUILD_VERSION="${MAILAI_BUILD_VERSION:-$(date +%Y%m%d).$(date +%H%M%S)}"

# 每次仅保留本次正式发布物，避免旧 App 和 PyInstaller 中间目录混入 dist。
rm -rf "dist/MailAI" "dist/MailAI.app" "dist/MailAI 2.app"
rm -f "dist/.DS_Store" "dist/MailAI-macOS.zip" "dist/MailAI-macOS-arm64.dmg" "dist/MailAI-macOS-arm64.pkg"

PYTHON_BIN="${MAILAI_BUILD_PYTHON:-}"
if [[ -z "$PYTHON_BIN" ]]; then
  for candidate in python3.12 python3.13; do
    if command -v "$candidate" >/dev/null 2>&1; then
      PYTHON_BIN="$(command -v "$candidate")"
      break
    fi
  done
fi
if [[ -z "$PYTHON_BIN" ]]; then
  echo "构建失败：MailAI macOS 稳定版需要 Python 3.12 或 3.13（不再使用 Python 3.14）。"
  echo "也可以通过 MAILAI_BUILD_PYTHON=/完整路径/python3.12 指定解释器。"
  exit 1
fi
PYTHON_VERSION="$($PYTHON_BIN -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
if [[ "$PYTHON_VERSION" != "3.12" && "$PYTHON_VERSION" != "3.13" ]]; then
  echo "构建失败：当前解释器为 Python $PYTHON_VERSION，仅支持 3.12 或 3.13。"
  exit 1
fi
rm -rf .venv-build
"$PYTHON_BIN" -m venv .venv-build
.venv-build/bin/python -m pip install -q --upgrade pip
.venv-build/bin/python -m pip install -q -r requirements-build.txt
.venv-build/bin/python scripts/check_release.py
.venv-build/bin/python scripts/prepare_bundle_config.py "$@"
zsh scripts/prepare_macos_icon.command
.venv-build/bin/pyinstaller --noconfirm --clean MailAI.spec
.venv-build/bin/python scripts/smoke_macos_app.py dist/MailAI.app
rm -f mailai.defaults.env
ditto -c -k --sequesterRsrc --keepParent dist/MailAI.app dist/MailAI-macOS.zip

# 标准安装器固定写入 /Applications，并主动刷新系统应用索引。
PKG_SCRIPTS="$(mktemp -d)"
PKG_ROOT="$(mktemp -d)"
DMG_STAGE=""
cleanup_pkg_temp() {
  [[ -z "$DMG_STAGE" ]] || rm -rf "$DMG_STAGE"
  rm -rf "$PKG_ROOT" "$PKG_SCRIPTS"
}
trap cleanup_pkg_temp EXIT
cat > "$PKG_SCRIPTS/preinstall" <<'PREINSTALL'
#!/bin/zsh
# pkgbuild runs this script as root. Stop every running copy before Installer
# replaces the application bundle, including a copy hidden in the menu bar.
running_mailai() {
  /usr/bin/pgrep -x MailAI 2>/dev/null || true
}

PIDS="$(running_mailai)"
if [[ -n "$PIDS" ]]; then
  echo "正在退出运行中的 MailAI…"
  /bin/kill -TERM ${(f)PIDS} 2>/dev/null || true

  # Give the app a short chance to close its database and local mail service.
  for _ in {1..12}; do
    [[ -z "$(running_mailai)" ]] && break
    /bin/sleep 0.25
  done

  PIDS="$(running_mailai)"
  if [[ -n "$PIDS" ]]; then
    echo "MailAI 仍在运行，正在强制退出…"
    /bin/kill -KILL ${(f)PIDS} 2>/dev/null || true
  fi

  for _ in {1..12}; do
    [[ -z "$(running_mailai)" ]] && break
    /bin/sleep 0.25
  done
fi

if [[ -n "$(running_mailai)" ]]; then
  echo "无法退出旧版 MailAI，已停止安装以避免覆盖运行中的程序。" >&2
  exit 1
fi
exit 0
PREINSTALL
cat > "$PKG_SCRIPTS/postinstall" <<'POSTINSTALL'
#!/bin/zsh
APP="/Applications/MailAI.app"
REGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [[ -d "$APP" ]]; then
  /usr/bin/touch "$APP"
  [[ -x "$REGISTER" ]] && "$REGISTER" -f -trusted "$APP" >/dev/null 2>&1 || true
  /usr/bin/mdimport "$APP" >/dev/null 2>&1 || true
fi
exit 0
POSTINSTALL
chmod 755 "$PKG_SCRIPTS/preinstall" "$PKG_SCRIPTS/postinstall"
ditto dist/MailAI.app "$PKG_ROOT/MailAI.app"
pkgbuild \
  --root "$PKG_ROOT" \
  --component-plist scripts/macos-components.plist \
  --install-location /Applications \
  --identifier com.baosight.mailai.installer \
  --version "$MAILAI_RELEASE_VERSION" \
  --scripts "$PKG_SCRIPTS" \
  dist/MailAI-macOS-arm64.pkg >/dev/null

DMG_STAGE="$(mktemp -d)"
ditto dist/MailAI-macOS-arm64.pkg "$DMG_STAGE/安装 MailAI.pkg"
hdiutil create -quiet -volname MailAI -srcfolder "$DMG_STAGE" -ov -format UDZO dist/MailAI-macOS-arm64.dmg
rm -rf "dist/MailAI" "dist/MailAI.app"
echo "构建完成：dist/MailAI-macOS-arm64.dmg、dist/MailAI-macOS-arm64.pkg、dist/MailAI-macOS.zip"
