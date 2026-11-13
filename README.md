# MailAI · 本地优先的 AI 邮件客户端与安全效率助手

MailAI 是一款**本地优先（Local-First）、AI 驱动**的开源跨平台邮件客户端与个人工作助手。它通过标准 IMAP / SMTP 协议直连邮箱，在本地完成邮件同步、钓鱼与垃圾风险研判、往来脉络梳理、待办提取、附件表格填写以及回信草稿准备，同时内置陪伴式桌宠「小邮」与免公网端口的手机远程控制能力。

[![最新版本](https://img.shields.io/github/v/release/langjiahui/MailAI?label=最新版本)](https://github.com/langjiahui/MailAI/releases/latest)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

当前版本：**v4.5.1**

本次更新：修复订阅降噪批处理越出列表周期及误改星标、收藏、跟进/稍后提醒邮件的问题；修复日程时间线与批量 `.ics` 导出忽略 `TZID` 跨时区换算及截断多日全天日程的问题；将 6 项新增功能端到端测试接入 Chromium/WebKit CI 矩阵并更新贡献文档参数。[发布说明](docs/发布-v4.5.1-订阅批处理与日程解析修复.md) · [完整版本历史](https://github.com/langjiahui/MailAI/releases)

---

## 多端下载与版本状态

### 桌面端（Windows / macOS / Linux）

| 系统 | 支持设备 | 最新安装包 |
|---|---|---|
| Windows | Windows 10/11 x64 | [下载 Windows 安装程序](https://github.com/langjiahui/MailAI/releases/latest/download/MailAI-Windows-x64-Setup.exe) |
| macOS | Apple Silicon（M1/M2/M3/M4） | [下载 PKG 安装程序](https://github.com/langjiahui/MailAI/releases/latest/download/MailAI-macOS-arm64.pkg) · [下载 DMG 镜像](https://github.com/langjiahui/MailAI/releases/latest/download/MailAI-macOS-arm64.dmg) |
| Linux | x64（AppImage，免安装） | [下载 Linux AppImage](https://github.com/langjiahui/MailAI/releases/latest/download/MailAI-Linux-x64.AppImage) |

- 中国大陆用户可访问 [AtomGit 国内官方发布页](https://atomgit.com/langjiahui2011/MailAI/releases) 下载安装包。GitHub 与 AtomGit 发布同一份安装包字节和 SHA-256 校验值，无需注册账号。
- 也可前往 [GitHub 最新版本发布页](https://github.com/langjiahui/MailAI/releases/latest) 查看安装包、校验文件与详细更新说明。

> **安装提示：**macOS 应用使用固定自签名证书（暂未配置 Apple Developer ID 公证），Windows 安装包暂未配置商业代码签名，首次打开时系统可能弹出安全提示。安装包不内置任何邮箱密码或模型 API Key，所有凭据均在首次使用时由用户保存在本机。

### Android

安卓独立客户端 **1.4.0 正式版**：[下载 Android APK](https://github.com/langjiahui/MailAI/releases/download/android-v1.4.0/MailAI-Android-1.4.0.apk) · [国内 APK](https://atomgit.com/langjiahui2011/MailAI/releases/download/android-v1.4.0/MailAI-Android-1.4.0.apk)。基于 Jetpack Compose 与 Kotlin 独立构建，手机直连 IMAP / SMTP 与模型服务，不依赖桌面端在线。支持国内签名更新清单与安装包镜像自动选路，修复局域网／自建 HTTP 接口、Qwen 空工具调用字段及 Kimi 推理输出兼容问题；覆盖升级保留本地邮件、草稿和附件。Android 与 Web／桌面各自独立维护版本号，详见 [Android 源码与说明](mobile/android/README.md)。

### iOS

iOS 原生客户端正在首版 **1.0.0** 测试验收，支持 iOS 18+（iPhone / iPad）。基于 SwiftUI 与 SwiftMail 独立收发，包含多账号管理、真实文件夹同步、离线缓存阅读、本地草稿、纯文本发送与回复。当前提供待签名 IPA，需使用个人或设备证书签名后安装；附件、小邮助手与后台推送将在后续版本移植。详见 [iOS 源码与范围说明](mobile/ios/README.md) · [测试安装说明](mobile/ios/INSTALL.md)。

---

## 核心特性

### 1. 本地优先的全功能邮件工作台
- **多账号隔离与统一收件箱**：每个邮箱账号拥有独立的 SQLite 数据库与本地原始邮件目录（`raw/`），通过运行时上下文守卫严格隔离；支持在统一收件箱视图下聚合浏览，或一键切换不同账号。
- **主流邮箱与 Gmail 接入**：内置常见邮件服务商配置自动发现；Gmail 支持 Google OAuth 2.0 官方浏览器授权登录或[应用专用密码](https://myaccount.google.com/apppasswords)接入（详见应用内「配置官方登录」向导）。
- **可恢复队列与离线容错**：发件箱（`outbox`）、已读状态回写（`seen_sync_jobs`）、回收站删除墓碑（`trash_tombstones`）均采用本地事务队列与指数退避重试，进程重启或网络闪断后自动核对恢复；所有移动、隔离与删除操作支持一键撤销。
- **全文、拼音与本地语义检索**：支持联系人姓名拼音检索、高级搜索语法（`from:`、`to:`、`subject:`、`after:`、`before:`、`filename:`、`has:attachment`、`is:unread`、`state:`），以及基于 `fastembed`（`BAAI/bge-small-zh-v1.5`）的可选本地向量语义检索（覆盖邮件正文与 PDF/Word/Excel 附件正文切片）。
- **订阅降噪与自动分流规则中心**：自动识别含退订协议（`List-Unsubscribe`）或高频通知的订阅源，支持一键批量整理或创建多条件自动分流规则（新邮件入库时自动归档、标为已读、打星标或添加标签）。
- **应用内附件预览与大附件分享**：支持在应用内直接预览 PDF、Word（DOCX）、Excel（XLS/XLSX）、图片与文本附件；写信时若单个附件超过 20 MB 或总量超过 25 MB，可按需连接用户自有的腾讯云 COS 私有存储桶，自动上传并插入 7 天有效的临时下载链接（单文件上限 2 GB，见 `mailai-shares/` [生命周期规则建议](https://cloud.tencent.com/document/product/436/14605)）。
- **Foxmail 导入与服务器空间清理**：支持扫描导入导出的 EML、MBOX 或邮件目录至「本地归档」（自动去重、可暂停续传，不回传服务器，见 [导入操作说明](docs/Foxmail旧邮件导入.md)）；支持手动或按日/周定期清理过期服务器邮件，执行前自动备份本机副本并始终保留收藏与星标邮件（见 [服务器邮件清理说明](docs/服务器邮件清理.md)）。

### 2. 「小邮」AI 邮件与办公助手
- **带来源引用的邮箱与附件问答**：基于本地已同步邮件、会话历史脉络及附件内容回答查找、汇总、金额核对与风险解释等问题。每条邮件事实均附带 `[email_id:数字]` 来源标记，点击即可回溯原信；严格将邮件正文与附件视为不可信材料，防范间接提示词注入（Indirect Prompt Injection）。
- **待办全流程闭环与发信跟进催办**：自动从邮件中提取待办事项、截止日期与重要程度，同时支持在待办中心手动快速新建待办、一键快捷推迟（明天 / +3 天 / 下周一）及设置每周/每月重复周期；将「已发送等待回复跟进」整合至待办中心（收到回信自动消警，超时支持按礼貌/直接/正式语气由 AI 一键生成催办草稿）。
- **多源日程时间线与周期工作简报**：在「日程时间线」中聚合待办截止、发信跟进、`.ics` 会议邀请与自建日程，自动检测时段冲突，支持批量导出 `.ics` 或直写 macOS 系统「日历」；支持按本周、本月、上月或自定义范围自动聚合收发邮件与已完成事项，流式生成结构化周报/月报并一键转为写信草稿。
- **联系人沟通画像与受控事项记忆**：支持为单封邮件或线程记录专属背景笔记，并结合通讯录与工作记忆为「领导 / 客户 / 同事 / 合作方」配置分角色默认语气、称呼习惯与专属签名，写信时自动匹配套用。长期记忆仅响应用户本人的明确保存指令，绝不从邮件正文自动写入。
- **附件表格与文档智能填表**：打开带有 `.xlsx`、`.xls`（兼容保留旧版 BIFF 打印排版）、`.docx` 或可填写 `.pdf`（AcroForm）附件的邮件，可调用「帮我填写附件并回复」。系统会预先做安全检查（拦截宏、外部对象与压缩炸弹），提取空白单元格候选位置，仅填入邮件正文或用户指令中有明确依据的内容，生成经 HMAC 签名的填表计划供预览核对，确认后自动生成新附件与回复草稿。

### 3. 四层反社工钓鱼引擎与发件防呆
- **四层入站风险检测**：
  1. **静态与协议规则层**：覆盖 9 大类 30+ 启发式规则，包括 SPF / DKIM / DMARC 认证校验、发件域实时 DNS（MX / SPF / DMARC）体检、Reply-To 与发件域不一致、相似域名仿冒（Lookalike）、显示名冒充、Punycode / 高危顶级域名 / 锚文本伪装、基于文件头 Magic Bytes 的真实类型校验、Office / OLE 宏脚本检测、压缩包内可执行文件扫描，以及紧迫恐吓与索要凭据话术识别。
  2. **短链展开与威胁聚类层**：对短链和可疑链接执行带 SSRF 防护（强制校验公网全局 IP 并绑定连接地址，防止探测内网或 DNS 重绑定）的重定向跟踪，记录完整跳转链与最终落地页；同时使用并查集算法对共享附件哈希、落地链接或高相似话术的多封邮件自动聚类为威胁簇。
  3. **发件人行为画像与会话守护层**：在本地维护发件人历史画像（`sender_profiles`，记录发信时段分布、常用附件类型、链接频率与中文词频签名），检测异常发信时间、首次携带附件、语言风格漂移，以及同一邮件会话中途更换发件域或突然提出转账/索要验证码等会话劫持信号（`thread_guard`）。
  4. **LLM 语义与多模态视觉复核层**：仅对中高风险或可疑邮件按需触发大模型复核（发送前自动支持对手机号、身份证号、银行卡号脱敏）；开启多模态时可一并识别图片附件中的二维码目标与仿冒登录页面。
- **灵活处置与熔断保护**：支持「仅观察（observe）」「人工确认（review）」「自动处置（auto）」三种策略，自动处置模式内置单轮移动上限熔断机制；所有隔离、移入垃圾箱与误报（FP）/ 漏报（FN）反馈均记录本地审计日志（`audit_logs`）并可一键恢复。
- **非阻断发件前多维自检（Outgoing Guard）**：写信过程中在本地毫秒级核查常见失误，包括「正文提及附件但未添加」「身份证号/银行卡号/密钥口令等敏感信息外发」「正文提及相对日期与当天星期冲突」「回复全部包含外部域名收件人」及「回复高风险邮件」，通过正文行内高亮与悬停脉冲聚光轻提示定位问题区域，不打断正常写信流。

### 4. 免公网端口的微信 / 钉钉远程控制
- **个人微信通道**：基于腾讯公开的 iLink Bot 协议连接，在桌面端设置中生成二维码，使用本人微信扫码确认即可绑定（无需额外部署中转服务、无需浏览器自动化或公网回调端口）。
- **钉钉通道**：基于 `dingtalk-stream` 建立出站 WebSocket 长连接，无需暴露本地端口。
- **安全边界与幂等回执**：远程通道仅响应已绑定本人身份的单聊指令（采用常数时间摘要比对），密钥保存在系统凭据库，并在 `remote-control.sqlite3` 中持久化发送确认回执，防止网络重连导致重复发信。

### 5. 小邮空间：桌宠养成与主题收藏
- **日常陪伴与成长**：在阅读邮件、发送回信、完成待办或使用小邮工具的过程中自动通过事务发件箱累积经验值（共 7 个成长阶段）与邮票，完成每日轻量任务。
- **套系穿搭与全局主题**：在「小邮 → 小邮空间」中可查看晨光邮局、云间远航、星海巡邮等收藏套系，支持头饰、颈饰、身体/邮包、背饰、配色与特效自由搭配，并可兑换全局工作区主题。养成进度保存在本机 `companion.sqlite3`，跨所有本地邮箱账号共享。详见 [小邮养成说明](docs/小邮长期养成.md)。

---

## 系统架构与代码结构

### 架构数据流

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────────────────────┐
│ 标准 IMAP / SMTP │     │ 微信 iLink / 钉钉 │     │ 本地文件导入（EML / MBOX / 目录） │
└────────┬─────────┘     └────────┬─────────┘     └────────────────┬─────────────────┘
         │                        │                                │
         ▼                        ▼                                ▼
┌────────────────────────────────────────────────────────────────────────────────────┐
│ 接入与多账号上下文隔离层（AccountContext + AccountGuard + 可恢复收发任务队列）       │
└─────────────────────────────────────────┬──────────────────────────────────────────┘
                                          │
         ┌────────────────────────────────┼────────────────────────────────┐
         ▼                                ▼                                ▼
┌─────────────────────────┐  ┌──────────────────────────┐  ┌─────────────────────────┐
│ 四层安全检测与溯源管道   │  │ 小邮 AI 与效率引擎        │  │ 本地存储与系统安全层     │
│ · 9类30+静态与DNS规则   │  │ · 带来源引用的检索问答    │  │ · 账号级 SQLite + 原始信│
│ · 防SSRF短链跳转追踪    │  │ · 待办提取与多视角简报    │  │ · 界面偏好库 / 伴侣库   │
│ · 行为基线与会话守护    │  │ · 受控事项记忆与写作偏好  │  │ · macOS 原生凭据代理    │
│ · LLM 语义与多模态复核  │  │ · Excel/Word/PDF安全填表 │  │ · 加密便携备份与恢复    │
└────────────┬────────────┘  └────────────┬─────────────┘  └────────────┬────────────┘
             └────────────────────────────┼─────────────────────────────┘
                                          ▼
┌────────────────────────────────────────────────────────────────────────────────────┐
│ 展示与交互层                                                                        │
│ · 桌面原生壳（macOS AppKit + WebKit / Windows WinRT + WebView2 / Linux AppImage）  │
│ · 本地 Web 工作台（原生 JS/CSS 单页应用 + Three.js 3D 徽标 + 双语国际化）           │
│ · 独立移动端（Android Jetpack Compose 原生客户端 / iOS SwiftUI 原生客户端）         │
└────────────────────────────────────────────────────────────────────────────────────┘
```

### 目录结构

```text
run.py                         桌面与本地 Web 服务启动入口、后台调度器与单实例锁
VERSION                        桌面与 Web 端版本号
app/
  config.py                    动态多账号作用域配置加载
  account_context.py           基于 ContextVar 的多账号运行时快照隔离
  pipeline.py                  邮件拉取、四层安全检测、自动处置与审计主管道
  mailbox_jobs.py              多账号并发同步、发件箱后台工作线程与优雅停机
  imap_client.py / smtp_client.py  IMAP 增量同步、IDLE 监听与 SMTP 发信封装
  oauth_mail.py                Google OAuth 2.0 桌面授权与令牌刷新
  outbox.py / outgoing_guard.py    持久化发件队列与发送前本地防呆检查
  parser.py                    MIME 解析、正文净化、敏感信息脱敏与附件提取
  profiles.py                  发件人历史行为基线画像与异常评分
  mail_assistant.py            小邮问答、来源引用编排与防注入控制
  work_assistant.py / work_memory.py  事项背景记录、长期写作偏好与记忆管理
  secretary.py                 只读工作简报（今天先做 / 等待反馈 / 待确认 / 安全关注）
  document_fill.py             Word (DOCX) 与 PDF (AcroForm) 空白字段识别与安全回填
  assistant_document_reply.py  Excel (XLS/XLSX)/Word/PDF 填表计划签名与回复草稿生成
  semantic.py                  基于 fastembed (ONNX) 的可选本地向量语义检索（含附件切片）
  productivity.py / sent_followups.py  邮件工作流状态、已发送跟进追踪与 AI 催办草稿
  mail_calendar.py             多源日程时间线聚合、冲突检测、批量 ICS 导出与 macOS 日历同步
  periodic_briefing.py         周报/月报多维工作数据聚合与流式生成
  recipient_profiles.py        联系人沟通画像与分角色写作签名预设
  triage_rules.py              订阅推送扫描、批量降噪与多条件自动分流规则引擎
  remote_control.py            手机远程控制会话管理、权限校验与幂等回执
  weixin_remote.py / dingtalk_remote.py  个人微信 iLink 协议与钉钉 Stream 远程通道
  companion_growth.py          小邮桌宠养成、经验邮票与装扮衣橱
  macos_credential_vault.py    macOS AES-256-GCM 加密凭据库与钥匙串主密钥管理
  release_update.py / update_routing.py  GitHub 与 AtomGit 双源竞速更新与断点续传
  desktop.py / windows_desktop.py  macOS 与 Windows 原生窗口、托盘、菜单与系统通知
  db/                          SQLite Schema、自动迁移与领域数据访问层
  security/                    认证头、域名相似度、URL、短链追踪、威胁聚类与附件静态分析
  llm/                         OpenAI 兼容客户端、多模态视觉分析、厂商预设与提示词
  web/
    server.py                  FastAPI 应用组装、本地 Origin 防护中间件与路由挂载
    routes/                    按邮件、写信、助手、安全、联系人、远程控制等域拆分的 API
    static/                    原生 JS/CSS 单页前端、小邮动画、中英词典与打包产物 bundle.js
native/
  macos_credential_agent.c     校验父进程代码签名的 macOS Keychain 原生读取守护程序
  macos_credential_migration.swift  本地加密凭据库平滑迁移工具
mobile/
  android/                     Android 独立原生客户端（Kotlin + Jetpack Compose + JavaMail）
  ios/                         iOS 独立原生客户端（Swift + SwiftUI + SwiftMail）
scripts/
  build_frontend.py            确定性拼接生成 bundle.js 并更新 index.html 缓存哈希
  check_release.py             完整离线发布门禁（Python 单测 + Node/Playwright 语法与UI检查）
  release_desktop.py           桌面端候选构建、CI 证据核验与多源发布自动化脚本
tests/
  datasets/                    合成正常/钓鱼/垃圾邮件测试样本
  evaluate.py                  安全检测准确率、召回率与误报率离线评估脚本
  test_*.py / test_*.cjs       近 400 个后端单测与 Playwright 浏览器回归测试
```

---

## 隐私、凭据安全与自动更新

### 本地数据与隐私边界
- **本地存储**：所有邮件元数据、正文、原始 `.eml`、审计日志、待办与小邮养成记录均保存在本机用户目录，无中心化业务服务器：
  - macOS：`~/Library/Application Support/MailAI/`
  - Windows：`%LOCALAPPDATA%/MailAI/`
  - Linux：`$XDG_DATA_HOME/MailAI/`（默认 `~/.local/share/MailAI/`）
  - 源码运行默认使用项目下的 `data/` 目录；可通过环境变量 `MAILAI_HOME` 指定独立隔离目录。
- **凭据加密保护**：邮箱密码、OAuth 令牌、模型 API Key、COS 密钥及远程通道密钥均存储在系统安全凭据库（macOS 使用原生签名守护进程守护的 `AES-256-GCM` 凭据库 + Keychain 主密钥，Windows 使用系统凭据管理器），不写入邮件数据库或便携备份文件。
- **按需调用 AI 与脱敏**：未配置大模型时，邮件收发、本地搜索与静态安全规则依然完整可用；启用 AI 后，仅在触发安全复核、摘要生成或小邮对话时将必要上下文发送至用户自行配置的模型接口，并支持开启发送前敏感信息自动打码（`REDACT_BEFORE_LLM=true`）。

### 双源自动更新机制
- 默认更新通道并行检查 **AtomGit 已签名静态更新清单**（通过内置公钥验签，并在静态入口不可用时自动回退至同仓库 `updates` 分支官方文件 API 重新验签）与 **GitHub 官方 Releases**，不查询用户地理位置，通过小体积 `Range` 请求实测下载链路速率并自动选用更快的可达源。
- 下载过程严格核对清单中的文件字节大小与 SHA-256 摘要，支持网络中断或应用重启后的断点续传；校验通过并由用户确认后才启动系统安装器完成覆盖升级（保留全部本地邮件、账号与偏好配置）。
- 手动检查更新入口：**设置 → 关于与隐私 → 版本与更新 → 检查更新**。
- *历史版本升级提示*：若使用 v2.10.1 之前的旧版本且无法连接 GitHub，或 v3.4.0 及更早版本遇到静态清单 403，请从 [AtomGit 国内官方发布页](https://atomgit.com/langjiahui2011/MailAI/releases) 手动下载覆盖安装一次最新版，后续即可直接使用应用内国内更新；macOS 升级后若遇到系统通知旧图标缓存问题，可参考 [通知旧图标处理流程](docs/邮件更多菜单与图标排查-2026-10-16.md#通知旧图标处理流程)。

---

## 快速开始（从源码运行）

首次启动后可按应用内「设置 → 使用帮助」完成邮箱连接、阅读与小邮配置；完整操作说明见 [新用户引导与功能指南](docs/新用户引导与功能指南.md)。

### 1. 环境准备与启动

**macOS / Linux：**
```bash
# 1. 创建虚拟环境并安装核心依赖
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 2. （可选）安装本地向量语义检索依赖
pip install -r requirements-semantic.txt

# 3. 启动本地服务（默认监听 http://127.0.0.1:8787，端口占用时自动顺延）
python run.py
```

**Windows (PowerShell)：**
```powershell
# 1. 创建虚拟环境并安装核心依赖
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt

# 2. （可选）安装本地向量语义检索依赖
.\.venv\Scripts\python.exe -m pip install -r requirements-semantic.txt

# 3. 启动本地服务
.\.venv\Scripts\python.exe run.py
```

启动后在浏览器访问 `http://127.0.0.1:8787` 即可在设置界面图形化添加邮箱与配置 AI 模型（也可事先复制 `.env.example` 为 `.env` 进行预配置）。

### 2. 常用 OpenAI 兼容模型配置示例

可以在应用内「设置 → AI 模型服务」直接选择预设，或在 `.env` 中配置任意兼容 OpenAI Chat Completions 协议的服务：

| 服务类型 | `LLM_BASE_URL` 示例 | `LLM_MODEL` 示例 | 说明 |
|---|---|---|---|
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` / `deepseek-v4-flash` | 通用文本分析与问答 |
| Kimi（月之暗面） | `https://api.moonshot.cn/v1` | `kimi-k2.6` | 支持多模态图片与二维码分析 |
| 通义千问（百炼） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | OpenAI 兼容接口 |
| Ollama（本机离线） | `http://localhost:11434/v1` | `qwen2.5:7b-instruct` | 无需 API Key，数据完全不出本机 |
| 自建兼容网关 | `https://your-gateway.example.com/v1` | `your-model-id` | 支持自定义推理网关与扩展参数 |

---

## 开发、测试与构建

```bash
# 修改 app/web/static/ 下的前端脚本后，重新生成 bundle.js 并同步 index.html 哈希
python scripts/build_frontend.py

# 生成合成测试邮件集并运行安全检测离线评估
python tests/generate_dataset.py
python tests/evaluate.py

# 运行完整离线发布门禁（含百余项 Python 回归测试与前端语法/UI 校验，不连接外部网络）
python scripts/check_release.py

# 运行真实浏览器端到端验收（需先安装 npm install 与 Playwright 浏览器）
python tests/workspace_preview.py
node tests/prepublish_browser.cjs
```

### 版本与贡献约定
- 本项目开发、测试门禁与多端独立版本规则详见 [CONTRIBUTING.md](CONTRIBUTING.md#版本号与发布规则)。
- 安全漏洞报告流程详见 [SECURITY.md](SECURITY.md)。
- 开源许可协议：[Apache License 2.0](LICENSE)。
