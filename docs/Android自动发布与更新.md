# Android 自动发布与更新

Android 与 Web/桌面的发布和版本号独立。正式 Android 下载仍以 GitHub 上最近发布的 `android-v<版本>` 为准；本流程自身不升级应用版本，也不把验收包自动公开。

## 完整链路

1. 在 Android 源码分支完成改动、设备验收，并按 `CONTRIBUTING.md` 确定版本。更新 Android VERSION、持续递增的 VERSION_CODE、RELEASE.md 和两处 README。发布记录写清基准版本、变更类型、目标版本、判断依据。
2. 打开 GitHub Actions 的 **Android signed release**，选择工作流所在的 `main` 分支，`source_ref` 填 Android 源码分支或提交。`publish=false` 只生成签名验收附件；`publish=true` 自动正式发布。工作流开始检出后固定源码提交，不随分支后续移动。
3. CI 执行 Android JVM/协议测试、release lint、正式包构建，并核对固定签名、包名、版本、安装序号、对齐、发布记录和更新清单。验收包不能通过发布步骤。
4. 正式发布先建立草稿并上传全部 APK、更新清单、校验文件和验收信息，完成后才公开；设置 `latest=false`，保留 Web/桌面的 Latest。上传失败只留下草稿，不进入手机正式更新通道。
5. 发布后重新从公开地址下载清单和 APK，核对大小、哈希、版本和固定签名。回读失败会让工作流失败，不能把“上传完成”当成验收成功。已公开版本只读校验，永不覆盖；失败任务可重试，不能为重试随意改产品版本。
6. 已安装的正式 Android 客户端默认每天检查 GitHub Android 正式发布，可手动“检查更新”。默认在不限流量网络下载，校验后提醒安装；安装由用户在系统页确认。系统省电/后台限制可能延后检查，GitHub 不能连通时显示失败并允许重试。

当 Android 源码分支也包含本工作流后，推送 `android-v*` 标签可直接触发同一流程。Android 完整源码与发布工具统一进入主线后，默认以 main 为源码；开发分支仍可用 Actions 的 source_ref 生成独立验收附件，publish=false 不影响正式通道。

## 签名配置

GitHub Actions Secrets 保存 `ANDROID_SIGNING_KEYSTORE_B64`、`ANDROID_SIGNING_STORE_PASSWORD`、`ANDROID_SIGNING_KEY_PASSWORD`。沿用已发布 Android 的固定签名；不生成替代签名，私钥和密码不进入源码、日志、APK 或验收附件。CI 只在临时目录还原签名文件，构建后删除。

固定公开证书 SHA-256：`415c2ff611048d705ec4f516b6156dbbd4af8c2ad75d0feab81abae1e241dd97`。

只有受信任的仓库维护者可以运行带签名的构建。PR 只运行无密钥的发布工具测试；不会读取签名或发布。`publish=true` 表示明确发布意图，代码提交本身不直接推送一个新版本。

## 验收与实际边界

工具测试覆盖更新清单、独立语义版本、安装序号、验收/正式隔离、发布不可覆盖、草稿恢复、上传失败和固定签名拒绝。CI 的 `Android-signed-acceptance` 附件用于覆盖安装验收，`Android-release-test-reports` 保存协议测试和 lint 报告。

发布自动化不等于系统静默安装；它也不能替代小米实体机上的锁屏收信、通知和能耗测试。只有完整签名发布和公开回读成功后，才能说本次版本已进入自动更新通道。
