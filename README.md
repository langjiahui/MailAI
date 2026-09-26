# MailAI · 邮件安全与效率助手

MailAI 是一款**本地运行、AI 驱动**的邮件安全与效率助手。它通过 IMAP 接入邮箱，在邮件落箱后自动完成**规则+上下文+行为+LLM 四层检测**，实现钓鱼/垃圾邮件识别、攻击链路溯源、发件人行为画像、多轮会话关联分析、自动隔离与审计反馈闭环，显著降低人工研判工作量，提升反诈防护能力。

[![最新版本](https://img.shields.io/github/v/release/langjiahui/MailAI?label=最新版本)](https://github.com/langjiahui/MailAI/releases/latest)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

当前版本：**v2.2.25**

本次更新：优化附件中心紧凑列表，修正文件图标未随容器缩小的问题，缩小图标与行高，长文件名单行省略，保留下载按钮的点击面积及风险提示。优化小邮面板，压缩顶部头像与操作区，减轻背景与边框，统一推荐入口、邮件参考范围和输入框的呈现。同步适配深浅色、侧栏和浮动窗口，并验证小窗口、放大字号、历史会话与长文本输入等交互。

## 下载 MailAI

| 系统 | 支持设备 | 最新安装包 |
|---|---|---|
| Windows | Windows 10/11 x64 | [下载 Windows 安装程序](https://github.com/langjiahui/MailAI/releases/latest/download/MailAI-Windows-x64-Setup.exe) |
| macOS | Apple Silicon（M1/M2/M3/M4） | [下载 PKG 安装程序](https://github.com/langjiahui/MailAI/releases/latest/download/MailAI-macOS-arm64.pkg) · [下载 DMG 镜像](https://github.com/langjiahui/MailAI/releases/latest/download/MailAI-macOS-arm64.dmg) |
| Linux | x64（AppImage，免安装） | [下载 Linux AppImage](https://github.com/langjiahui/MailAI/releases/latest/download/MailAI-Linux-x64.AppImage) |

也可以进入 [最新版本发布页](https://github.com/langjiahui/MailAI/releases/latest)，查看安装包、SHA-256 校验文件和版本说明。

> **安装提示：**当前安装包尚未配置代码签名，Windows SmartScreen 或 macOS 可能显示安全警告。安装包不会内置邮箱密码或模型 API Key，首次使用时由用户在本机配置。

### 大附件分享

写信时添加附件，单个不超过 20 MB 且总量不超过 25 MB 的文件照常随邮件发送；超出限制的文件在已配置 COS 时自动上传并插入 7 天有效的下载链接。首次未配置时，应用会在选择大附件后打开连接存储界面。已有云盘链接可直接粘贴到邮件正文。COS 需要你自己的私有存储桶，以及具备该桶上传和下载权限的腾讯云密钥；SecretKey 保存在本机系统凭据库，不写入邮件数据库。下载链接是持有者可访问的临时链接；链接失效后文件不会自动删除，建议给桶内 `mailai-shares/` 前缀配置[生命周期规则](https://cloud.tencent.com/document/product/436/14605)。当前单文件上限为 2 GB。文件完整保存到本机后，云端上传失败可保存关闭草稿，重开后继续上传；链接成功保存后清理本机暂存文件。任务恢复不等同于字节级断点续传。

## 版本更新

支持自动更新的 MailAI 会定期读取 GitHub Releases，识别 Windows x64、Apple Silicon Mac 或 Linux x64，并匹配对应安装包。发现新版本后会先提示用户；只有用户确认，才会下载安装。安装包下载完成后还会进行 SHA-256 校验，校验失败将停止更新。

手动检查入口：**设置 → 关于与隐私 → 版本与更新 → 检查更新**。

更新只替换应用程序，邮件、账号配置、草稿和其他本地数据会继续保留。较早且不包含自动更新功能的版本，需要先从发布页手动安装一次最新版，无需提前卸载旧版。

[查看全部历史版本](https://github.com/langjiahui/MailAI/releases)

### 界面偏好的本地保存

主题（浅色/暗色/跟随系统）、语言、字号、界面密度、小邮动效、助手浮窗与布局、三栏宽度、服务器文件夹显示、当前浏览账号、邮箱别名与折叠状态、秘书视图和引导进度，保存在应用用户目录的 `ui-preferences.sqlite3`，不上传云端，也不包含密码或 API Key。

- macOS：`~/Library/Application Support/MailAI/`
- Windows：`%LOCALAPPDATA%/MailAI/`
- Linux：`$XDG_DATA_HOME/MailAI/`（默认 `~/.local/share/MailAI/`）
- 源码运行默认使用项目目录；设置 `MAILAI_HOME` 可指定隔离目录。

升级时会迁移当前 WebView 仍可读取的旧偏好；旧版私密模式已经清除的设置无法恢复，需重新设置一次。通知与语义搜索配置仍使用原有数据库，邮箱和模型配置沿用配置文件及凭据库。

> 发布约定：每个版本发布前必须同步更新 README 中的当前版本与更新内容；发布工作流会校验版本号，未更新时停止构建。

---

## 一、风险现状调研

### 1.1 行业与企业安全态势

随着公司智能体平台、企业个人助理、智能客服等自研 AI 应用规模化落地，新型数智化业务持续拓宽企业安全风险边界。AI 技术同时被攻击者滥用，社工钓鱼攻击呈现以下趋势：

- **攻击门槛降低**：生成式 AI 可快速批量生成高度定制化的钓鱼话术，模仿领导/同事口吻；
- **传播渠道多元**：除传统钓鱼邮件外，银狐木马、仿冒工作群组、IM 私聊等新型社工渠道层出不穷；
- **隐蔽性增强**：攻击者使用 lookalike 域名、短链跳转、伪装的 Office 附件、多轮会话铺垫等手段绕过传统网关；
- **危害面扩大**：一旦员工点击恶意链接或启用宏，可能导致凭证泄露、内网横向移动、核心数据外泄。

### 1.2 当前人工处置痛点

- **响应慢**：安全运营人员需逐封人工查看、研判，日均邮件量大时难以覆盖；
- **覆盖窄**：传统邮件网关主要依赖 SPF/DKIM/DMARC 和黑名单，对语义变形、上下文诱导、行为漂移检测不足；
- **依赖经验**：新入职员工或业务繁忙时对高仿钓鱼邮件识别能力弱，容易误点；
- **闭环弱**：误判/漏判缺乏便捷反馈通道，难以形成持续优化的检测模型。

### 1.3 典型攻击场景

| 场景 | 攻击手法 | 目标 |
|---|---|---|
| 仿冒领导 | 使用 `examp1e.com` 等 lookalike 域名，显示名冒称「王总监」 | 诱导点击绩效/合同链接 |
| 账号异常紧急话术 | 伪造「密码即将过期」「账号冻结」通知 | 骗取账号密码/短信验证码 |
| 银狐木马/恶意附件 | 发送带宏的「发票确认单」或双扩展名文件 | 植入木马、横向移动 |
| 多轮会话诱导 | 在已有邮件往来中突然插入恶意链接或索要敏感信息 | 降低收件人警惕性 |
| 营销垃圾邮件 | 大量促销、培训推广信息 | 占用注意力、潜在钓鱼载体 |

---

## 二、整体方案设计

### 2.1 设计目标

- **自动识别**：在邮件进入收件箱前/后自动完成风险识别，无需人工逐封查看；
- **深度研判**：不仅检测单封邮件特征，还结合多轮会话上下文、发件人行为基线、URL 跳转链进行综合研判；
- **攻击溯源**：记录 URL 跳转链、附件哈希、最终落地域名/IP，辅助后续追踪；
- **自动处置**：高置信钓鱼邮件自动移入「隔离区」，垃圾邮件移入「垃圾邮件」文件夹，全部可逆；
- **反馈闭环**：提供「误报」「漏报」反馈按钮，形成持续优化素材；
- **本地存储，按需调用模型**：邮件与分析记录保存在本机；启用 AI 时，所需内容会按配置发送到模型服务。上传图片及选择分析的附件也会发送到所配置的服务，企业使用前应确认其数据处理范围。

### 2.2 处置闭环

```
┌──────────┐   ┌──────────┐   ┌─────────────────────────────────────┐
│ IMAP 邮件 │   │ IM 机器人 │   │ 统一输入适配器（InputAdapter）      │
│（已接入） │   │（已预留） │ → │ 输出标准 email dict                │
└──────────┘   └──────────┘   └─────────────────────────────────────┘
                                        │
┌───────────────────────────────────────┴─────────────────────────────┐
│ 四层检测层                                                            │
│  ├─ 规则引擎：认证/域名/URL/附件/话术/黑名单                         │
│  ├─ 上下文分析：thread 历史 + 多轮会话摘要                           │
│  ├─ 行为基线：sender_profile 异常评分                                │
│  └─ LLM 复核：大模型语义理解、诱导识别、证据抽取                     │
└───────────────────────────────────────┬─────────────────────────────┘
                                        │
┌───────────────────────────────────────┴─────────────────────────────┐
│ 处置与溯源                                                            │
│  ├─ 自动隔离/垃圾/收件箱                                              │
│  ├─ 攻击链路图：URL 跳转链 + 附件哈希 + 最终落地页                    │
│  ├─ 审计日志：所有人工/自动操作可追溯                                 │
│  └─ 反馈闭环：fp/fn 反馈 → 模型/规则持续优化                          │
└───────────────────────────────────────┬─────────────────────────────┘
                                        │
┌───────────────────────────────────────┴─────────────────────────────┐
│ 展示层                                                                │
│  ├─ Web 邮件面板：三栏式浏览、风险等级、一键恢复                      │
│  ├─ 统计看板：拦截量、误报/漏报、处理时效、降本估算                  │
│  ├─ 阅读区增强：攻击链路、上下文线索、发件人画像、附件分析            │
│  └─ 周报/日报：自动生成运营报告                                       │
└───────────────────────────────────────┘
```

### 2.3 人机协同策略

| 风险等级 | 规则分区间 | 处置策略 |
|---|---|---|
| 高置信钓鱼 | score ≥ 70 | 自动移入隔离区，面板高亮告警 |
| 中置信可疑 | 35 ≤ score < 70 | 触发 LLM 复核，复核为钓鱼则隔离 |
| 低置信正常 | score < 35 | 留在收件箱，自动生成摘要/待办 |
| 垃圾营销 | spam_score ≥ 25 | 移入垃圾邮件文件夹 |

---

## 三、技术架构说明

### 3.1 技术栈

- **IMAP 接入**：imapclient，支持 SSL、UID 增量同步、文件夹移动；
- **解析层**：mailparser + 自定义提取，支持正文、URL、附件元数据、认证头、threading 头；
- **存储层**：SQLite，本地文件 `data/mailai.db`，支持 Schema 迁移；
- **后端**：FastAPI + Uvicorn，RESTful API；
- **前端**：原生 HTML/CSS/JS 单页应用，按工作区、写信、助手、附件预览、通讯录等能力拆分，无外部 CDN；
- **LLM 适配**：基于 `urllib.request` 的 OpenAI 兼容客户端，支持自定义部署、DeepSeek、Kimi、通义千问等 OpenAI 兼容网关；
- **桌面与发布**：PyInstaller 封装 Windows、macOS、Linux 桌面程序，GitHub Actions 按版本标签构建安装包、校验文件和自动更新清单；
- **后台任务**：APScheduler 驱动定时同步，发件箱、垃圾箱、已读状态和链路分析任务独立排队并支持失败恢复；
- **文档预览**：本机解析 PDF、Word、Excel、文本和图片，危险旧格式默认不直接打开；
- **输入适配器**：预留 `app/adapters/` 接口，未来可接入企业微信、钉钉等 IM 渠道。

### 3.2 核心模块关系

```
run.py
 └── app/
      ├── config.py             # 环境、路径和运行配置
      ├── pipeline.py           # 邮件检测、处置与审计主管道
      ├── mailbox_jobs.py       # 多账号同步、后台任务与恢复
      ├── imap_client.py        # IMAP 拉取、文件夹与 UID 管理
      ├── smtp_client.py        # SMTP 发送
      ├── outbox.py             # 可恢复发件队列与结果核对
      ├── parser.py             # MIME、threading 与正文解析
      ├── db/                   # SQLite Schema 与领域数据访问
      ├── security/             # 规则、证据、策略、攻击链与附件分析
      ├── llm/                  # 模型厂商、客户端、多模态与提示词
      ├── mail_assistant.py     # 小邮问答、摘要和邮件材料编排
      ├── assistant_*.py        # 助手受控动作、附件与视觉输入
      ├── draft_lifecycle.py    # 草稿一致性与恢复
      ├── portable_backup.py    # 跨平台备份、校验与加密迁移
      ├── release_update.py     # GitHub Release 更新检查与安装
      ├── desktop.py            # macOS 桌面壳
      ├── windows_desktop.py    # Windows 桌面壳
      ├── adapters/             # 输入渠道抽象
      └── web/
           ├── server.py        # FastAPI 组装与兼容导出
           ├── routes/          # 按系统、邮件、写信、助手等域拆分的 API
           ├── schemas.py       # API 请求模型
           └── static/          # 单页应用与前端功能模块
```

运行时数据流为：桌面壳或浏览器访问本机 FastAPI → 路由调用邮件/助手/安全领域服务 → SQLite 保存状态与审计记录 → IMAP、SMTP 或用户配置的模型服务执行外部操作。邮箱账号切换由请求守卫隔离，前端不会直接读取本地数据库或邮箱凭据。

### 3.3 四层检测技术细节

#### 3.3.1 规则引擎

覆盖 9 大类 30+ 检测项，输出 0-100 风险分与结构化证据：

- **认证结果**：SPF/DKIM/DMARC 失败检测；
- **发件人一致性**：Reply-To 与 From 域名不一致；
- **域名仿冒**：公司域 lookalike（相似度 ≥0.8）、常用联系人域仿冒；
- **显示名冒称**：外部邮件显示名含公司名/管理员/IT 部等内部身份；
- **URL 风险**：短链、IP 直连、锚文本与 href 不一致、punycode、可疑后缀、本地黑名单；
- **附件风险**：危险扩展名、双扩展名伪装、宏检测、压缩包内容分析；
- **话术风险**：紧急/恐吓用语、诱导提供凭据；
- **DNS 体检**：发件域 MX/SPF/DMARC 缺失；
- **行为基线**：首次发件人、异常发送时段、附件/URL 模式突变、语言风格漂移。

#### 3.3.2 多轮上下文关联分析

- 解析 `In-Reply-To` / `References` 头生成 `thread_id`；
- 同一线程历史邮件聚合，生成会话摘要；
- LLM 复核时注入 thread_summary，识别「先正常沟通、后突然诱导」的多轮攻击；
- 每处理完一封邮件，自动更新该线程的 LLM 摘要。

#### 3.3.3 发件人行为基线

- 维护 `sender_profiles` 表，记录每个发件人的首次/最近出现时间、发送时段分布、附件率、URL 率、历史分类、语言签名；
- 基于统计偏离度输出 `FIRST_TIME_SENDER`、`OFF_HOUR_SENDER`、`NEW_ATTACHMENT_TYPE`、`URL_ANOMALY`、`LINGUISTIC_DRIFT` 等异常 findings；
- 画像随邮件持续更新，实现动态基线。

#### 3.3.4 LLM 安全复核

- 仅对中高风险邮件调用 LLM，降低 token 消耗；
- 输入包含邮件主题、正文（已脱敏）、URL 列表、附件信息、thread 摘要、发件人画像、规则命中证据；
- LLM 输出 phishing 概率、理由、关键证据、建议处置；
- 支持国产/私有 LLM 网关，确保数据不出内网。

### 3.4 攻击链路溯源

- 对短链/可疑 URL 使用 HEAD/GET 跟踪跳转（最多 5 跳，5 秒超时）；
- 记录每一跳的 URL、状态码、Location 头、最终落地域名/IP；
- 最终域名命中本地黑名单或 lookalike 时进一步加权；
- 附件计算 SHA256、magic byte 真实类型、宏检测、压缩包内容列表；
- 所有链路数据持久化到 `url_chains` 和 `attachment_analysis`。

---

## 四、功能测试数据

### 4.1 测试数据集

在 `tests/datasets/` 下构建了 9 封合成样本，覆盖正常邮件、钓鱼邮件、垃圾邮件三类：

| 样本 | 类别 | 主要风险点 |
|---|---|---|
| clean_01_project_update.eml | clean | 正常项目周报 |
| clean_02_meeting_invite.eml | clean | 正常会议邀请 |
| clean_03_system_notice.eml | clean | 正常系统通知 |
| phish_01_spoof_leader.eml | phishing | 仿冒领导 + 短链 + 紧迫话术 |
| phish_02_account_expired.eml | phishing | lookalike 域名 + 账号异常 + 凭据诱导 |
| phish_03_macro_attachment.eml | phishing | lookalike 域名 + 启用宏附件 |
| phish_04_multi_turn.eml | phishing | lookalike 域名 + 多轮会话诱导 + 验证码索要 |
| spam_01_marketing.eml | spam | 促销优惠 + 营销关键词 + 群发头 |
| spam_02_training.eml | spam | 免费课程 + 团购优惠 + 群发头 |

### 4.2 离线评估结果

使用 `tests/evaluate.py` 在独立临时数据库上运行规则引擎（含行为基线、URL、附件、话术检测），结果如下：

```json
{
  "total": 9,
  "accuracy": 1.0,
  "precision": 1.0,
  "recall": 1.0,
  "f1": 1.0,
  "false_positive_rate": 0.0,
  "false_negative_rate": 0.0,
  "avg_process_time_ms": 4019.5
}
```

关键指标解读：

- **准确率 100%**：9 封样本全部正确分类；
- **精确率 100% / 召回率 100%**：4 封钓鱼全部检出，无漏报；
- **误报率 0%**：3 封正常邮件未被误隔离；
- **平均处理时延约 4 秒/封**：主要消耗在发件域 DNS 体检，后续可通过缓存/异步进一步优化。

> 注：测试集为合成样本，用于验证检测逻辑正确性；生产环境中建议持续补充真实脱敏样本并定期重评估。

---

## 五、合规管控措施

### 5.1 数据安全

- **本地存储**：邮件元数据、分析结果、审计日志及原始邮件按账号独立保存在本机；AI 分析会将必要内容发送到所配置的模型服务，不能等同于完全离线处理；
- **敏感信息脱敏**：送 LLM 前默认对手机号、身份证号、银行卡号进行打码（`REDACT_BEFORE_LLM=true`）；
- **LLM 私有网关**：支持接入自定义部署的内网 OpenAI 兼容网关，数据边界由实际部署和网络策略决定；
- **隔离可逆**：自动隔离只是 IMAP `move_to` 文件夹操作，面板可一键恢复，不会删除邮件。

### 5.2 运行安全

- **审计日志**：所有自动/人工操作（隔离、恢复、确认、反馈）写入 `audit_logs` 表，便于追溯；
- **权限最小化**：IMAP 账户仅需读取收件箱、写入隔离区/垃圾邮件文件夹权限；
- **失败软化**：URL 跳转、DNS 查询、LLM 调用均带超时与异常捕获，不会阻塞邮件处理；
- **无破坏性操作**：不删除、不修改邮件内容，不涉及账号封禁或 IP 封禁。

### 5.3 法规符合性

- 符合《网络安全法》《数据安全法》《个人信息保护法》关于数据处理本地化、最小必要、可追溯的要求；
- 演示与测试数据均为合成数据，不使用未脱敏真实客户数据或生产敏感数据。

---

## 六、落地效益分析

### 6.1 人工减负估算

以 1000 人团队、日均人均 30 封外部邮件估算：

- 日外部邮件总量：约 30,000 封；
- 按 1% 钓鱼/垃圾风险率估算：约 300 封需人工关注；
- 传统方式每封人工研判约 3 分钟，日消耗 15 人时；
- MailAI 自动识别并隔离高风险邮件，仅对中低风险邮件保留人工复核，预计可减少 **70% 以上** 人工研判工作量，日节省 **10+ 人时**，月节省 **220+ 人时**。

### 6.2 安全价值

- **降低钓鱼成功率**：在邮件落箱后秒级识别并隔离高仿钓鱼邮件，显著压缩攻击窗口；
- **提升响应速度**：从「员工举报/安全运营发现」转变为「智能体主动发现、自动处置」；
- **积累情报资产**：攻击链路、恶意域名、附件哈希持续沉淀，为后续威胁狩猎提供数据基础。

### 6.3 推广实施路径

| 阶段 | 周期 | 目标 |
|---|---|---|
| 试点运行 | 1-2 周 | 在 1-2 个部门部署，收集误报/漏报反馈，调优阈值 |
| 模板化部署 | 1 个月 | 形成标准 .env 配置包与部署脚本，覆盖各事业部 |
| 持续运营 | 长期 | 每月基于反馈数据更新规则/黑名单，季度重评估指标 |

### 6.4 后续迭代方向

- **IM 渠道接入**：通过 `app/adapters/` 接入企业微信、钉钉消息，实现跨渠道统一防控；
- **模型微调**：基于反馈闭环积累的 fp/fn 样本，对本地/私有 LLM 进行后训练，提升场景语义理解；
- **威胁情报联动**：与 SOC/邮件网关联动，自动下发恶意域名、附件哈希到集团级黑名单；
- **多模态检测**：扩展对二维码图片、PDF 内嵌链接、语音消息等输入模态的分析能力。

---

## 七、快速开始

```powershell
# 1. 安装依赖（已创建 .venv 则跳过前两行）
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt

# 2. 配置环境变量
# copy .env.example .env   # 按需修改 IMAP/LLM 参数

# 3. 运行
.\.venv\Scripts\python.exe run.py
```

打开浏览器访问 http://127.0.0.1:8787

### 7.1 常用 LLM 网关配置示例

| 平台 | LLM_BASE_URL | LLM_MODEL |
|---|---|---|
| 自定义部署 | `https://model-gateway.example.com/v1` | `your-model-id` |
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` |
| Kimi | `https://api.moonshot.cn/v1` | `kimi-k2-0905-preview` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |

### 7.2 离线评估

```powershell
.\.venv\Scripts\python.exe tests\generate_dataset.py
.\.venv\Scripts\python.exe tests\evaluate.py
```

### 7.3 目录结构

```
run.py                         应用入口、调度器与本地 Web 服务
VERSION                        唯一发布版本号
app/
  db/                          SQLite Schema、迁移与领域仓储
  security/                    认证、域名、URL、附件、策略和攻击链分析
  llm/                         OpenAI 兼容模型、多模态和厂商预设
  adapters/                    IMAP/未来消息渠道适配接口
  web/
    routes/                    FastAPI 领域路由
    static/
      index.html               页面结构
      app.js                   邮箱与阅读区主交互
      workspace.js             设置、任务和工作区行为
      mail-library.js          联系人、分组与备份交互
      attachment-preview.js    本地附件预览
      assistant-*.js           小邮图片和材料附件能力
      style.css                基础布局与组件
      theme.css                浅色/暗色及可访问性收敛层
      bundle.js                由 build_frontend.py 生成，请勿手改
scripts/
  build_frontend.py            合并并校验前端 bundle
  check_release.py             离线发布门禁
  build_macos.command          macOS arm64 构建
  build_linux_appimage.sh      Linux x64 AppImage 构建
  build_windows.bat            Windows x64 安装程序构建
tests/
  datasets/                    合成安全邮件样本与标签
  workspace_preview.py         隔离浏览器验收夹具
  prepublish_browser.cjs       发布前真实浏览器主流程
  test_*.py / test_*.cjs       后端、前端和跨平台回归
.github/workflows/
  pr-check.yml                 PR 离线门禁与浏览器检查
  release.yml                  标签触发三平台构建与 GitHub Release
```

### 7.4 开发与发布检查

```powershell
# 前端源码修改后重新生成 bundle
py scripts\build_frontend.py

# 完整离线发布门禁（不连接真实邮箱或模型）
py scripts\check_release.py

# 浏览器主流程；先在另一个终端启动隔离夹具
py tests\workspace_preview.py
node tests\prepublish_browser.cjs
```

正式版本以 `vX.Y.Z` Git 标签触发 `.github/workflows/release.yml`。工作流会核对 `VERSION` 与 README 版本号，分别构建 Windows x64、macOS arm64 和 Linux x64 安装包，生成 SHA-256 文件及 `latest.json` 更新清单，最后发布 GitHub Release。

---

## 八、演示脚本（建议）

1. 启动服务并打开 Web 面板；
2. 导入/拉取测试数据集；
3. 展示「统计看板」：总邮件数、拦截钓鱼数、隔离数、误报率；
4. 点开一封钓鱼邮件：展示风险分、命中证据、发件人画像、会话上下文、URL 跳转链；
5. 一键隔离/恢复，查看审计日志；
6. 对正常邮件点击「误报」或对可疑邮件点击「漏报」，展示反馈闭环；
7. 展示周报/日报自动生成效果。

---

*本作品所有测试与演示数据均为合成生成，未使用真实客户数据或生产环境敏感数据。*
