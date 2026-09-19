#!/usr/bin/env bash
# 构建 Linux x86_64 AppImage（CI 验证路径；本机 macOS 无法运行）。
#
# 流程：venv → 发布门禁 → PyInstaller onedir（MailAI.linux.spec）→ 冒烟
# （独立 MAILAI_HOME 启动并探测 Web 面板）→ AppDir → appimagetool。
# Linux 版走 uvicorn + 系统浏览器路径，不依赖 GTK/WebKit。
set -euo pipefail
cd "$(dirname "$0")/.."

export MAILAI_RELEASE_VERSION="${MAILAI_RELEASE_VERSION:-$(tr -d '\r\n' < VERSION)}"
export MAILAI_BUILD_VERSION="${MAILAI_BUILD_VERSION:-$(date +%Y%m%d.%H%M%S)}"

PYTHON_BIN="${MAILAI_BUILD_PYTHON:-}"
if [[ -z "$PYTHON_BIN" ]]; then
  for candidate in python3.12 python3.13; do
    if command -v "$candidate" >/dev/null 2>&1; then PYTHON_BIN="$(command -v "$candidate")"; break; fi
  done
fi
[[ -n "$PYTHON_BIN" ]] || { echo "构建失败：需要 Python 3.12 或 3.13（可用 MAILAI_BUILD_PYTHON 指定）"; exit 1; }

rm -rf dist/MailAI dist/MailAI-AppDir dist/MailAI-Linux-x64.AppImage
rm -rf .venv-build
"$PYTHON_BIN" -m venv .venv-build
.venv-build/bin/python -m pip install -q --upgrade pip
.venv-build/bin/python -m pip install -q -r requirements-build.txt
.venv-build/bin/python scripts/check_release.py
.venv-build/bin/python scripts/prepare_bundle_config.py
.venv-build/bin/pyinstaller --noconfirm --clean MailAI.linux.spec
rm -f mailai.defaults.env

# 冒烟：隔离数据目录启动，等待 Web 面板应答后正常停止。
SMOKE_HOME="$(mktemp -d)"
SMOKE_LOG="$SMOKE_HOME/smoke.log"
MAILAI_HOME="$SMOKE_HOME" WEB_PORT=18931 AUTO_OPEN_BROWSER=0 dist/MailAI/MailAI >"$SMOKE_LOG" 2>&1 &
SMOKE_PID=$!
smoke_cleanup() { kill "$SMOKE_PID" 2>/dev/null || true; rm -rf "$SMOKE_HOME"; }
trap smoke_cleanup EXIT
for _ in $(seq 1 45); do
  if curl -fsS -o /dev/null "http://127.0.0.1:18931/static/i18n.js" 2>/dev/null; then break; fi
  sleep 1
done
curl -fsS -o /dev/null "http://127.0.0.1:18931/static/i18n.js" || { echo "冒烟失败：Web 面板未应答"; tail -20 "$SMOKE_LOG"; exit 1; }
# 诊断等接口需要账号鉴权（401），冒烟只探测匿名可达的页面与静态资源。
curl -fsS -o /dev/null "http://127.0.0.1:18931/" || { echo "冒烟失败：首页未应答"; tail -20 "$SMOKE_LOG"; exit 1; }
kill "$SMOKE_PID" 2>/dev/null || true
wait "$SMOKE_PID" 2>/dev/null || true
echo "冒烟通过：onedir 可启动并应答"

# AppDir：AppRun + desktop + 图标 + onedir。
APPDIR=dist/MailAI-AppDir
mkdir -p "$APPDIR/usr/bin"
cp -R dist/MailAI "$APPDIR/usr/bin/MailAI"
# build/ 不入库，图标直接使用已提交的源资产（与 Windows/macOS 图标同源）。
cp app/web/static/assets/mailai-icon-256.png "$APPDIR/mailai.png"
cat > "$APPDIR/AppRun" <<'APPRUN'
#!/usr/bin/env bash
exec "$APPDIR/usr/bin/MailAI/MailAI" "$@"
APPRUN
chmod +x "$APPDIR/AppRun"
cat > "$APPDIR/mailai.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=MailAI
Comment=Local-first AI mail security and productivity assistant
Exec=MailAI
Icon=mailai
Categories=Office;Network;
Terminal=false
DESKTOP

APPIMAGETOOL="${APPIMAGETOOL:-}"
if [[ -z "$APPIMAGETOOL" ]]; then
  APPIMAGETOOL="$(mktemp -d)/appimagetool"
  curl -fsSL -o "$APPIMAGETOOL" \
    "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage"
  chmod +x "$APPIMAGETOOL"
fi
# CI 容器通常没有 FUSE，用解包直跑模式。
ARCH=x86_64 "$APPIMAGETOOL" --appimage-extract-and-run "$APPDIR" "dist/MailAI-Linux-x64.AppImage"
chmod 0644 dist/MailAI-Linux-x64.AppImage
.venv-build/bin/python scripts/write_sha256.py dist/MailAI-Linux-x64.AppImage
echo "完成：dist/MailAI-Linux-x64.AppImage"
