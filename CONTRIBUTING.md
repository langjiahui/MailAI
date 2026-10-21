# 参与贡献 MailAI

感谢你愿意为 MailAI 贡献代码！本文档说明本地开发、提交与发布的基本流程。

## 本地开发环境

```bash
# 1. 克隆并创建虚拟环境
git clone https://github.com/langjiahui/MailAI.git
cd MailAI
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt -r requirements-dev.txt

# 2. 配置（不会进 git）
cp .env.example .env             # 按需填写 IMAP / LLM 参数；也可以不填，纯离线开发

# 3. 启动
python run.py                    # 打开 http://127.0.0.1:8787
```

浏览器端测试需要 Node.js（>= 18），部分 `.cjs` 测试会驱动无头浏览器。

## 提交前必做：跑发布门禁

```bash
python scripts/check_release.py
```

这是项目的离线质量门禁（100+ 项检查），**PR 合并前必须通过**。门禁不需要真实邮箱、不需要模型 API Key，全部离线运行。

**改了 `app/web/static/` 下的 JS 源码后必须重新打包**：

```bash
python scripts/build_frontend.py
```

它按 `frontend/sources.txt` 的顺序把脚本拼成 `app/web/static/bundle.js`，并按内容哈希更新 `index.html` 的缓存版本号；`bundle.js` 与 `index.html` 的改动要和源码一起提交（门禁会校验产物新鲜度）。

单元测试：

```bash
python -m pytest tests/ -q       # 跑完整离线套件；可用 -k 过滤，如 -k test_contacts
```

pytest 通过 `tests/test_offline_suite.py` 以子进程方式逐个运行脚本式测试，清单与 `scripts/check_release.py` 共用同一份 `TESTS`——新增离线测试只需在门禁清单里登记一处。注意 pytest 只覆盖 Python 套件，前端 `.cjs`/打包检查仍以 `check_release.py` 为准。

## CI 与发布流程

- 同一 PR 或主分支有新提交时，自动取消旧质量检查；正式标签的构建和发布按标签串行，避免中断附件上传。
- 浏览器回归按功能分组，在独立 runner 和临时邮箱上并行。响应式检查按完整弹窗分成三组，两种浏览器分别覆盖全部主题、语言和窗口组合；不通过减少断言、跳过失败或缩减矩阵提速。
- `.github/ci/browser-suites.json` 声明测试与 fixture 的顺序依赖，`browser-jobs.json` 声明并行矩阵，`browser-coverage.json` 约束原有测试覆盖。新增或调整测试时一起维护这些清单。每组记录逐项耗时，日志和截图可在对应任务附件中查看。
- PR 执行完整门禁，最终统一由 **Quality gate** 汇总；任意必需任务失败、取消或意外跳过都会阻止通过。分支保护应要求这个稳定的汇总检查。
- 只有同仓库、成功结束、七天内的完整门禁，才可为**完全一致的 Git 树**提供验证记录。记录同时绑定测试提交、运行 ID、重试次数和所有必需任务，Git 树包含应用代码、测试、依赖及工作流。fork、缺失/过期记录、API 查询失败或任何源码变化都会回退完整检查。主分支可复用这样的 PR 结果，并重新扫描提交历史中的凭据。
- 正式标签仍核对 VERSION/README、重新扫描发布提交历史中的凭据，并执行平台打包和签名/校验值检查；质量门禁校验上述完整源码记录，避免 PR、合并和标签对同一源码重复执行整套浏览器检查。找不到有效记录时等待完整主分支检查，无法验证则停止发布。
- Python/npm/Playwright 缓存只缓存依赖，不代替测试结果；Playwright 缓存绑定操作系统、架构、浏览器及 `package-lock.json`。

本地复跑一个分组：

```bash
python scripts/ci_browser.py search
python scripts/ci_browser.py responsive-dialogs --browser webkit --shard 2/3
```

国内镜像在正式发布成功后由独立工作流自动同步，单独展示安装包和静态更新入口的校验状态。失败不会把已成功的正式发布标成失败，也不重新构建、覆盖或改号已有安装包。可单独重试：

```bash
gh workflow run atomgit-sync.yml -f tag=v3.0.0
```

镜像仍验证公开附件的完整字节和签名，并保持版本单调递增。静态入口 401/403 等访问拒绝立即报告；404、限流和服务暂时不可用保留有上限的重试。独立镜像仅接受已公开的正式标签，并核对自动触发的发布提交与该标签一致。

## 版本号与发布规则

正式版本采用 `MAJOR.MINOR.PATCH`（主版本.次版本.修订号），Git 标签加 `v` 前缀。**版本号由改动对用户和兼容性的影响决定，不能默认只将最后一位加 1**，也不按提交次数、代码行数、发布时间或构建次数决定。

| 类型 | 判断依据 | 以已发布的 `2.8.22` 为基准举例 |
| --- | --- | --- |
| 修订号 PATCH | 修复错误、补齐已有功能的异常处理、性能优化、界面排版与交互细节调整，未增加独立的新能力，且保持兼容 | `2.8.23` |
| 次版本 MINOR | 增加向后兼容的用户能力，例如邮件标签、自动打标、批量管理、新筛选入口、新增语言支持；旧配置和数据可以继续使用或自动迁移 | `2.9.0` |
| 主版本 MAJOR | 破坏兼容性，例如移除受支持能力、对外接口或配置不兼容且无兼容迁移、现有用户必须手动转换数据或重新配置才能继续正常使用 | `3.0.0` |

补充判断：修正已有语言的翻译属于 PATCH；新增完整语言支持属于 MINOR。兼容的数据库表结构扩展或自动迁移，不单独构成 MAJOR。界面重排和内部重构的规模再大，也应按实际功能与兼容性影响分类；安全修复同样按影响分类。

每次发布按以下顺序执行：

1. 核对 GitHub 最近已发布的正式版本作为基准，检查从该版本以来本次要交付的全部变更；不能只根据本地可能过期的 `VERSION` 或最后一个提交判断。若维护旧版本分支，则以该维护线最近的正式发布为基准并在记录中注明。
2. 按本次变更中影响最高的一类决定版本：MAJOR 优先于 MINOR，MINOR 优先于 PATCH。升级次版本时修订号归零；升级主版本时后两位归零。从 v3.0.0 起，先按变更影响判断版本级别，再应用编号上限：次版本或修订号达到 10 时，主版本加 1，次版本和修订号归零；例如本次由 v2.10.3 发布为 v3.0.0。此进位仅调整产品编号，不表示存在破坏兼容性变更。历史标签和安装包不追溯改号，各端仍独立计算。
3. 在发布记录中写明基准版本、变更类型、目标版本和判断依据。例如：`基准 v2.8.22；MINOR；目标 v2.9.0；新增邮件标签及自动打标，旧数据兼容迁移。`
4. 同步 `VERSION`（不带 `v`）、README 当前版本和更新内容、Git 标签、安装包元数据及更新清单。遵守现有质量门禁；版本分类由发布者或执行发布的代理判断，当前 CI 只校验已实现的版本一致性项目，不会自动决定该升哪一位。
5. 已发布版本的标签和安装包保持不变；发布后修改源码或交付内容，应使用新的版本号。未成功发布时，同一源码的构建重试可以沿用目标版本号；CI 构建序号独立递增，不等于产品版本递增。仅修改文档无需单独发布应用版本。

这套分级规则从 `v2.8.22` 之后的发布开始执行，历史发布不追溯改号。`v2.8.22` 的邮件标签属于新增能力，按本规则原本应从 `v2.8.21` 升为 `v2.9.0`；保留已发布的 `v2.8.22`，后续依据实际变更选择新版本。

### Android 与 Web 独立版本

Android 与 Web/桌面是两条独立产品版本线，分别依据各自最近正式发布和完整变更判断 MAJOR/MINOR/PATCH；不得借用另一端的版本号，也不因同仓库、同日发布而强制统一版本。根目录 `VERSION` 与 `v<版本>` 标签表示 Web/桌面；Android 使用 `mobile/android/VERSION` 与 `android-v<版本>`，其当前版本、更新内容和安装包元数据在 Android README 与 RELEASE 中维护。根 README 分别列出两端当前版本。

Android 独立版本从 **1.0.0** 开始。已发布的 `android-v2.10.0` 与此前 beta 属于历史共用编号，保留原标签和附件，不覆盖、不追溯改号。`1.0.0` 是用户明确要求的版本线分离，功能与数据保持兼容，不代表回退旧功能；之后只以独立 Android 版本作为分级基准。

`mobile/android/VERSION_CODE` 单独记录 Android 内部安装序号，必须高于所有已发布 Android 包（包括历史共用编号），不得从用户可见的版本号重新计算或归零；应用内更新按 versionCode 比较新旧，仍核对 versionName、包名、哈希、大小与固定签名。当前分离发布使用 versionName `1.0.0`、versionCode `2100101`，可覆盖 `2.10.0`（2100100）并保留数据。

Android 正式发布不标 Pre-release，使用 `latest=false` 保留 Web/桌面下载入口；测试发布在 Android 自己的目标版本后追加 `-beta.N`，标 Pre-release。正式客户端只订阅正式 Android 发布。更新清单附件名固定为 `mailai-android-update.json`，清单与 APK 元数据必须一致，执行现有门禁及移动端测试。旧 beta 客户端首次进入正式通道需手动覆盖安装。

### iOS 独立版本

iOS 从 `1.0.0` 建立第三条独立产品版本线，产品版本在 `mobile/ios/VERSION`，本地内部构建号在 `mobile/ios/BUILD_NUMBER`，同步 `project.yml`、iOS README、构建清单与 IPA 元数据。测试发布使用 `ios-v<版本>-beta.N`，正式发布使用 `ios-v<版本>`；均保留 Web/桌面的 Latest 入口。后续仅以 iOS 自己最近正式发布为分级基准，不沿用 Android 或根 VERSION。

执行根发布门禁、iOS 核心测试、模拟器测试及 arm64 真机构建。未签名 IPA 必须明确标记待签名，不能宣称可直接安装或已完成正式签名发布；正式版还需目标设备安装验收。签名证书、私钥、描述文件、密码与 UDID 不进入源码或公开发布附件。

## 分支与 PR 规范

- 从 `main` 切分支，命名：`feat/xxx`、`fix/xxx`、`docs/xxx`、`chore/xxx`
- **小步提交**：一个 PR 只做一件事，方便审查和回滚
- Commit message 沿用现有风格：`feat: ...` / `fix: ...` / `docs: ...`（英文小写开头）
- PR 必须满足：
  1. `python scripts/check_release.py` 全绿
  2. 新增/修改行为有对应测试（`tests/test_*.py` 或 `tests/*.cjs`）
  3. 不引入新的硬编码域名/凭据/企业内部信息

## 安全红线（重要）

- **绝不提交**：`.env`、真实邮件（`data/`）、任何账号密码、API Key、企业内部域名/网关地址
- 测试数据使用合成邮件（`tests/datasets/`）；真实邮件样本必须经过脱敏且默认不入库
- 改动涉及**发送邮件、移动邮件、删除邮件**的代码，必须在 PR 描述里说明已用模拟 IMAP/SMTP 验证，不得只在真实邮箱上验证
- 涉及网络请求的新代码（如 URL 跟踪、远程图片）必须带 SSRF 防护：禁止回环/私网目标，参考 `app/security/chains.py`

## 项目结构速查

```
app/
  pipeline.py        邮件处理主管道（同步 → 解析 → 检测 → 处置）
  security/          规则引擎、URL 链、附件分析、活动关联、策略
  llm/               模型客户端、提示词、多模态
  db/                SQLite 数据层（按域拆分模块，每个邮箱账号独立库）
  web/               FastAPI 接口（routes/ 按域拆分）与前端静态资源
tests/               Python 测试 + .cjs 浏览器测试
scripts/             发布门禁、打包、构建脚本
docs/                设计文档与审查报告
```

## 报告 Bug / 提需求

- 普通问题走 [Issues](https://github.com/langjiahui/MailAI/issues)，按模板填写
- **安全漏洞请走私有渠道**，见 [SECURITY.md](SECURITY.md)，不要开公开 issue

## 许可证

所有贡献默认按 [Apache License 2.0](LICENSE) 授权。提交 PR 即表示你同意以该许可证发布你的贡献。
