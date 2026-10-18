# MailAI Android 测试版

当前 Android 版本：**2.10.0-beta.4**（versionCode **2100004**），最低 Android 10。

[下载安装包](https://github.com/langjiahui/MailAI/releases/download/android-v2.10.0-beta.4/MailAI-Android-2.10.0-beta.4.apk) · [发布说明](https://github.com/langjiahui/MailAI/releases/tag/android-v2.10.0-beta.4)

Kotlin + Jetpack Compose 原生客户端。手机直接通过 IMAP/SMTP 连接邮箱，电脑关机后仍可工作，不需要桌面服务或 Google Play 服务。设计遵循简洁图形、原生按压反馈、清楚的等待与恢复状态。

## 已实现

- 多个公网邮箱、QQ/163 参数快捷填入、通用 IMAP/SMTP 配置，TLS 或强制 STARTTLS。添加前验证收发登录，可更新授权码。
- 收件箱、文件夹、未读筛选、本地搜索、缓存阅读、分批加载、已读同步、中文收发和回复。
- 多附件发送、下载进度、打开与分享；私有副本不依赖原文件临时权限。附件单个/发送总计 25 MB，正文 2 MB；HTML 安全转文本，不执行脚本或加载远程图片。
- 自动保存本地草稿与附件、发送前确认、重复提交保护、连接失败重试、发送结果不确定时禁止直接重发。
- **后台收信**：WorkManager 周期任务，15/30/60 分钟可选；网络恢复后调度、失败退避、每个账号独立状态。后台更新缓存，返回应用时重新读取。
- **新邮件通知**：首次同步与 UIDVALIDITY 改变只建立基准，后续按 UID 去重；默认隐藏发件人与主题，锁屏隐藏内容，支持系统通知权限/声音设置。通知点击进入正确账号，保留编辑中的草稿。
- **应用更新**：每日检查 GitHub Android 测试通道，可自动在不限流量网络（通常为 Wi-Fi）下载；手动下载确认流量，显示真实进度、取消、失败重试。核对 SHA-256、大小、包名、版本和与当前应用相同的签名证书，再交给系统安装器验证并确认安装。
- “通知与更新”页面展示最近收信、权限状态、检查结果与安装反馈；小屏选项自动换行，支持深色、大字号和键盘避让。

## 安装与升级

下载 APK 后按手机提示允许浏览器安装应用。进入 MailAI 添加邮箱，再到“通知与更新”开启邮件通知。系统可能需要单独允许 MailAI 安装后续更新；返回应用后点击“安装更新”。普通应用不能保证静默安装，最终安装由系统与用户确认。

本通道包名 `com.mailai.mobile`，使用固定分发签名；后续同包名、同签名且 versionCode 更高的版本覆盖安装，保留数据。此前本地调试包 `com.mailai.mobile.dev` 是独立应用，不能覆盖或自动迁移其邮箱数据；可并存，首次切换需重新添加邮箱。

签名私钥与密码保存在开发机仓库之外，不能提交或作为 Release 附件。安全备份整个签名目录；丢失密钥会失去同包覆盖更新能力。CI 调试 APK 不能替代这个分发安装包。

## 后台与隐私边界

- WorkManager 是省电定期收取，不是秒级推送。Doze、系统省电策略和手机厂商管理可能延迟执行；系统“强行停止”后需再次打开应用。未要求常驻前台服务、精确闹钟或豁免电池优化。
- Android 13+ 必须授予通知权限；权限拒绝不妨碍收信，设置页面会持续提供系统设置入口。当前只通知 INBOX 新到未读邮件；最新窗口外的大批历史邮件不保证逐封通知。
- 凭据用 Android Keystore AES-GCM 加密；邮件、草稿在各账号独立 SQLite 与应用私有目录中，依赖系统沙箱与设备加密，没有宣称全数据库应用层加密。备份/自动设备迁移禁用。
- 只连接公网邮箱，DNS 固定到验证过的公网 IP，TLS 验证原始服务器名。更新请求仅允许 GitHub 官方指定域名，逐次验证重定向与公网 DNS。下载与安装不上传邮箱凭据。
- SMTP 成功仅代表发件服务器接受；当前保留本机发送记录，不主动 APPEND 到服务端已发送文件夹。OAuth、服务端草稿同步、富 HTML、实时 IMAP IDLE、AI/小邮、归档/移动/删除、账号移除仍未实现。
- 尚未完成真实 QQ/163 等服务商、用户实体机触感、厂商省电策略与长时间后台耗电验收。

## 源码、版本与构建

```text
app/src/main/java/com/mailai/mobile/
  data/        Keystore、账号隔离、草稿与发送状态、通知游标迁移
  mail/        IMAP/SMTP、MIME、公网/TLS 校验、网络取消
  background/  WorkManager、通知、权限和偏好
  update/      GitHub 发布清单、下载、完整性与升级校验
  ui/          Compose 页面与状态
app/src/test/           JVM 协议、数据库、故障与更新策略测试
app/src/androidTest/    Android 系统、通知、后台执行及交互测试
scripts/               固定签名构建与更新清单生成
```

JDK 17、Gradle 8.11.1（分发 SHA-256 固定）、AGP 8.9.2、Kotlin 2.1.20、Compose BOM 2025.04.01、compile/target SDK 35。版本来自本目录 `VERSION`，Git 标签为 `android-v<版本>`，测试构建序号与产品版本分开。

将 SDK 路径写入忽略的 `local.properties`，运行：

```bash
./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
./gradlew :app:connectedDebugAndroidTest  # 专用测试模拟器，写入合成数据
python3 scripts/build_distribution.py  # 使用仓库外的固定签名配置
```

签名配置默认路径 `~/.local/share/mailai/android/signing.json`（权限 0600，父目录 0700），格式为 `keystore`（绝对路径）、`password`；可通过 `MAILAI_ANDROID_SIGNING_CONFIG` 指定。脚本只把秘密通过环境传给 Gradle。CI 如需分发构建，配置对应的三个 `MAILAI_ANDROID_*` 环境变量，直接执行 `assembleRelease`；不要运行会生成新身份的临时签名步骤。

每次发布先核对最近正式版本和 Android 测试版本，按 CONTRIBUTING 判断版本变化，保持 Android VERSION、README、标签与 APK 元数据一致。运行仓库既有门禁及 Android 测试；固定签名构建，生成 `mailai-android-update.json` 与 SHA256SUMS，发布为 GitHub **Pre-release**，不替换桌面 Latest 或历史安装包。具体记录见 [本次发布说明](RELEASE.md)。

## beta.4 弱网与恢复修订

离线时仍能阅读已缓存正文、打开已下载附件和编辑草稿；网络恢复不会自动重发邮件。等待超过 8 秒会显示慢连接提示，断网、连接超时和本地保存失败分别说明。草稿保存失败保留编辑内容并提供明确重试。

发送内容与开始发送状态在同一数据库事务中记录。连接失败可以人工重试；提交后确认丢失则保留“结果待确认”，锁定直接重发；切后台或系统回收进程后继续保持保护。Android 保存的任务状态只记录导航和草稿 ID，返回原任务时从本地数据库恢复编辑内容。

## 验收

- JVM：33 项通过，包含 TLS/STARTTLS、中文附件往返、错误证书/域名、发送确认丢失、账号隔离、草稿重开、v1→v2 无损迁移、通知基准/去重/重启、更新清单安全和取消阻塞操作。
- Android 15 AOSP ARM64：13 项设备测试，覆盖 Keystore、附件副本、草稿恢复、真实系统通知栏点击与隐私、偏好恢复/检查反馈、后台任务失败保留草稿，以及窄屏/大字号、真实键盘焦点与长正文可见性、快速取消与重试。以本次发布验收记录为最终执行结果。
- 项目既有离线发布门禁：244/244 通过（项目 `.venv-build` 环境）。
- 实体机、真实邮箱、厂商后台保活仍需测试；不把模拟器验收等同所有设备稳定性。

全部邮件测试使用合成数据，没有向外部收件人发送测试邮件。第三方许可随 APK 放在 `assets/licenses/`。
