"""Linux AppImage 打包链路的静态守卫：脚本、spec 与工作流保持一致。"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def main():
    script = (ROOT / "scripts" / "build_linux_appimage.sh").read_text(encoding="utf-8")
    spec = (ROOT / "MailAI.linux.spec").read_text(encoding="utf-8")
    workflow = (ROOT / ".github" / "workflows" / "release.yml").read_text(encoding="utf-8")
    manifest = (ROOT / "scripts" / "create_release_manifest.py").read_text(encoding="utf-8")

    # 打包脚本：门禁 → PyInstaller → 冒烟 → AppDir → appimagetool → 校验和
    for needle in ["check_release.py", "MailAI.linux.spec", "MAILAI_HOME", "AppRun",
                   "appimagetool", "write_sha256.py", "MailAI-Linux-x64.AppImage",
                   "mailai.desktop"]:
        assert needle in script, f"build_linux_appimage.sh 缺少 {needle}"
    assert "set -euo pipefail" in script
    # 冒烟在打包之前：先验证 onedir 能启动再产出 AppImage
    assert script.index("curl -fsS") < script.index("APPDIR=dist/MailAI-AppDir")

    # spec：与 macOS spec 同样的数据载荷；排除桌面壳以免拉入 pywebview
    for needle in ["('app/web/static', 'app/web/static')", "('VERSION', '.')",
                   "'app.desktop'", "'app.windows_desktop'", "'webview'"]:
        assert needle in spec, f"MailAI.linux.spec 缺少 {needle}"
    assert "BUNDLE(" not in spec, "Linux 构建不得使用 macOS BUNDLE"

    # 工作流：linux-x64 任务产出 AppImage，发布任务依赖它
    assert "linux-x64:" in workflow
    assert "bash scripts/build_linux_appimage.sh" in workflow
    assert "dist/MailAI-Linux-x64.AppImage" in workflow
    assert "needs: [windows-x64, macos-arm64, linux-x64]" in workflow

    # 更新清单覆盖 Linux 资产
    assert '"linux-x64": "MailAI-Linux-x64.AppImage"' in manifest

    # 签名挂钩保持可选：未配置密钥时不得失败
    assert 'if [ -z "$MACOS_CERTIFICATE" ]' in workflow
    assert "steps.windows-cert.outputs.enabled == 'true'" in workflow

    print("✅ Linux AppImage 打包链路与可选签名挂钩守卫通过")


if __name__ == "__main__":
    main()
