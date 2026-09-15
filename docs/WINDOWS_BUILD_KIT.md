# Windows EXE 构建包

1. 将最新的 `MailAI-Windows-BuildKit-*.zip` 复制到任意一台联网的 Windows 10/11 x64 电脑。
2. 完整解压，不能直接在压缩包预览窗口里运行。
3. 双击 `BUILD_WINDOWS_EXE.bat`。
4. 脚本会优先使用本机 Python 3.12–3.14 x64 和 Node.js 18+；只有缺失或版本不兼容时才下载备用环境，然后安装项目依赖并打包。
5. 构建完成后取得 `dist\MailAI-Windows-x64-Setup.exe` 和对应 SHA-256。

构建已改为可检查的目录式程序，不再生成运行时自解压的 `--onefile` 文件，
并关闭 UPX 与最高强度固实压缩，以降低杀毒软件启发式误报。若公司已提供
Windows 代码签名证书，可先在 PowerShell 设置证书指纹再运行构建：

```powershell
$env:MAILAI_SIGN_SHA1 = "证书的 SHA-1 指纹"
```

构建脚本会用 SHA-256 和可信时间戳同时签署主程序及安装包。没有证书时仍可
生成安装包，但“未知发布者”和基于信誉的误报无法仅靠改代码彻底消除；应把
生成的 SHA-256 提交公司终端安全团队复核，而不是让用户关闭杀毒软件。

构建窗口会在成功或失败后停留，并将完整过程保存到解压目录下的
`MailAI-Windows-build.log`。若构建未完成，请发送这个日志，不必依赖截图定位。

使用本机 Python 时，依赖只安装到解压目录的 `.venv-build-win`，不会污染系统环境；备用环境也只存放在 `.build-python` 和 `.build-node`。脚本会执行离线回归，并在临时空白账号目录中真正启动生成的 EXE；只有健康接口、首次配置状态与 Logo 资源全部正常才会继续生成安装包。最终安装包会把 MailAI 安装到当前用户应用目录，创建开始菜单入口，并可选创建桌面快捷方式和登录自启动。应用使用原生窗口，关闭后驻留系统托盘继续收信。安装包不包含开发者邮箱账号、邮箱授权码、数据库或原始邮件。

默认构建包不包含模型 API Key。安装后可在模型服务配置中选择自部署、DeepSeek、Kimi、Kimi Code 或其他厂商，再填写对应 API Key。

正式分发应使用公司的 Windows 代码签名证书，并将安装包 SHA-256 纳入内部软件发布白名单。


## 安装与更新（同一 Windows 用户）

首次运行 `MailAI-Windows-x64-Setup.exe` 安装程序；更新时直接运行新版同名安装程序，无需先卸载。
安装器保留固定 AppId，自动沿用已有安装目录、快捷方式和开机启动选择。
更新清理安装目录中的旧 `_internal` 运行文件，然后安装新版程序，完成后可启动 MailAI。
不会删除 `%LOCALAPPDATA%\MailAI` 中的邮件、草稿、附件、账号配置，也不会删除 Windows 凭据管理器中的 MailAI 登录凭据。
更新前请保存正在编辑的邮件，因为安装器会关闭运行中的 MailAI。
便携版程序本身不是安装器；需运行 Setup.exe 才执行覆盖更新。

安装器行为依据：[沿用安装目录](https://jrsoftware.org/ishelp/topic_setup_usepreviousappdir.htm)、[安装前清理](https://jrsoftware.org/ishelp/topic_installdeletesection.htm)。
