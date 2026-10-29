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

### 日常检查与正式验证

| 模式 | 触发方式 | 检查范围 | 可用于正式发布 |
| --- | --- | --- | --- |
| quick | 普通 PR，按相对目标分支的实际改动选择 | 完整离线门禁、凭据扫描、受影响浏览器分组和必要平台检查 | 否 |
| full | 修改根 VERSION、未知影响／安全／依赖／构建／CI 改动，或手动触发 | 完整功能、Chromium／WebKit、全部主题／语言／窗口／字号与原生平台检查 | 是 |
| reuse | 主分支与已通过 full 的 Git 树完全一致 | 校验完整凭证，重新扫描提交历史中的凭据 | 引用原始 full 凭证 |

- **Quality gate** 是稳定的分支保护汇总检查，工作流本身始终触发；只按计划选择其中的任务。任意已选任务失败、取消或意外跳过都会阻止通过，未选任务必须确实跳过。
- `.github/ci/browser-suites.json` 保留测试与 fixture 的顺序依赖，`browser-jobs.json` 保留完整矩阵，`browser-coverage.json` 约束原有覆盖。快速模式由 `scripts/ci_plan.py` 选择分组：独立待办模块检查待办、提醒、来源往返及布局；公共 JS、公共主题等无法安全归因的改动回退 full。未识别的新文件和测试帮助函数也回退 full。
- 修改浏览器测试时检查其所在的全部分组。生成的 bundle/index 仅在存在对应前端源码改动时随源码归因；只改产物则回退 full。Android／iOS 沿用独立平台流程，Android 构建不再因根 VERSION 或桌面标签触发。
- 浏览器矩阵统一并发调度，默认最多 12 个分片，仓库变量 `CI_BROWSER_PARALLEL` 可设置为 1–16，并应匹配运行器额度。每片使用独立 runner、邮箱库和进程组；片内有依赖的测试继续顺序执行。邮件设置已拆为更新、待办工作区、导航、导入恢复、外观语言及分组待办六部分。
- Linux 浏览器任务使用 `.github/ci/browser-image.json` 中固定摘要的官方 Playwright 镜像，预装 Chromium、WebKit 和系统库；镜像版本必须与 package-lock 一致，开始测试前实际启动两种浏览器验证。更新 Playwright 时同步镜像版本及摘要。继续缓存 Python/npm 依赖；普通非容器执行保留有界的依赖安装回退。
- 不删除断言、不缩减正式矩阵、不忽略失败提速。执行计划、逐项耗时、日志和截图上传为运行附件，用实际耗时调整分片；5–10 分钟快速检查及 15–20 分钟完整检查是优化目标，不是未经实测的保证。

### 下次发布按以下顺序执行

1. 整合本次完整变更，先确定版本号、README 和发布记录，固定候选提交，再触发正式验证。修改根 VERSION 的 PR 自动执行 full。
2. 若候选版本已定稿但没有触发 full，可在 Actions 手动运行 **PR quality gate** 并选择候选分支，或使用下列命令；手动运行始终为 full：

   ```bash
   gh workflow run pr-check.yml --ref codex/your-release-branch
   ```

3. 等待该候选提交的 full 全部通过，再合并及创建不可覆盖的正式标签。主分支优先复用同树 full；没有有效凭证时自动进行完整集成检查。标签仍核对 VERSION/README、扫描发布历史、执行平台打包及签名／校验值检查，不重复执行已验证同树的浏览器矩阵。
4. 快速模式的 `quick-evidence-v2` **不能**充当发布凭证。只有同仓库、成功结束、七天内的原始 full，且测试提交、Git 树、运行 ID、重试次数和完整覆盖指纹均一致时，才能复用 `quality-evidence-v2`。fork、过期／缺失记录、API 查询失败、复用链或任意源码／测试／依赖／工作流变化均不能套用旧完整结果。
5. 同一提交遇到临时环境故障，先定位再仅重试失败任务：`gh run rerun <run-id> --failed`。GitHub 保留同一运行已成功的任务，汇总仍检查全部计划结果，并产生绑定新 attempt 的凭证；功能断言失败应先修复，提交变化后重新验证。重试不是一个新的产品版本。

本地先检查影响范围和复跑相关分组：

```bash
python scripts/ci_plan.py --base <目标分支的40位提交SHA>
python scripts/ci_browser.py todos
python scripts/ci_browser.py responsive-dialogs --browser webkit --shard 2/3
```

旧的 `python scripts/ci_browser.py mail-settings` 入口仍顺序执行拆分后的全部六组，便于兼容既有复跑习惯。同一 PR／主分支的新提交取消旧质量检查；正式标签的构建发布仍按标签串行，避免中断附件上传。

### 一条命令衔接正式发布

先按下文版本规则定稿候选 PR、根 VERSION、README 和发布记录；版本分类由发布者根据本次完整变更选择。候选必须来自本仓库、面向 main、包含最新主分支并已结束草稿状态。以下 PR 编号和目标版本是示例，使用时替换为本次候选。

```bash
# 默认只读，展示基准版本、目标版本、固定的 head/tree 和已有标签。
python scripts/release_desktop.py --pr 123 --version 3.6.1 --change-type patch

# 核对计划后执行；可用 --head 加上评审过的完整提交 SHA。
python scripts/release_desktop.py --pr 123 --version 3.6.1 --change-type patch --execute
```

脚本使用本机 `gh auth login` 的已登录身份，需要仓库合并、Actions 重试和新建标签权限。只在本地运行；默认 Actions `GITHUB_TOKEN` 创建的标签不会继续触发构建，参见 [GitHub 工作流触发规则](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)。需要可用的网络或命令行代理，以及项目 Python 依赖。

执行会固定启动时的候选提交，每 15 秒检查状态，先并行启动私有候选包构建与 full 验证，再衔接合并、主分支检查、创建全新正式标签、三平台安装包发布和国内镜像。候选构建通过 `release.yml` 的手动事件固定 head 与版本，分支移动或版本不一致立即失败；该事件不能发布 Release，也不会触发国内镜像。完整浏览器矩阵、各平台构建脚本内的离线门禁、原生启动、签名和校验和检查全部保留。

正式标签只复用同仓库、七天内、成功结束且 Git 树与产品版本完全一致的私有候选构建。再次检查所有平台和 full 质量任务成功，固定运行次数及不可变产物 ID，下载后先核对 GitHub 记录的归档 SHA-256，再校验文件集合与安装包校验和；包括 DMG 在内的所有归档字节都须一致。候选包不充当 full 验证凭证：标签仍独立扫描发布历史、核验原始 full，并生成、签名、核对正式更新清单，国内镜像仍验证公开完整字节。没有可用候选包时执行原有三平台完整构建；来源不符的包不会发布，下载校验失败直接停止。

成功的 quick 或过期／缺失的 full 记录会触发一次新的完整验证；正式发布仍只接受原始 full 的完全相同 Git 树。失败工作流仅重试失败任务一次；再次失败、取消、候选提交改变、主分支推进、版本记录不一致或标签冲突都会停止。合并后的树也必须与被验证的候选一致。脚本不会修改源码、自动猜测版本分类或移动已有标签。构建和验证的耗时可重叠，但不得将缺少的 full、原生检查或发布校验当作缓存命中。

超时或网络中断后，可用同一候选、版本和 `--head` 重跑。脚本重新读取远端状态，已合并的 PR 和指向同一合并提交的标签继续使用；正式附件已公开时，不自动重试可能改动这些附件的发布任务。最后检查签名清单、三平台附件大小和 SHA-256，以及国内匿名更新清单。输出 JSON 行日志，包含 UTC 时间、当前阶段、源码、运行 ID 和重试状态；默认总等待上限两小时，可用 `--timeout` 调整。

### 按历史耗时安排浏览器任务

34 个浏览器组沿用原有全量矩阵、断言和并发上限；调度只将预计耗时较长的组提前启动，减少长组集中在末尾的等待。`.github/ci/browser-timings.json` 保存最近成功运行的观测数据，计划附件同时记录覆盖矩阵与实际启动顺序。完整验证凭证的覆盖指纹仍按原始矩阵计算，不因任务顺序变化而改变。

在完整质量检查成功后，可显式刷新耗时数据，并随代码审查提交：

```bash
python scripts/ci_browser_timings.py --repository langjiahui/MailAI --run 40269577336
```

刷新只接受本仓库成功的质量工作流，并要求完整浏览器矩阵全部通过。新增组缺少历史时保留在矩阵中，历史中已经移除的组不会被重新加入。工具链调整本身不要求另发应用安装包，后续产品发布仍按实际变更分级。

国内镜像在正式发布成功后由独立工作流自动同步，单独展示安装包和静态更新入口的校验状态。失败不会把已成功的正式发布标成失败，也不重新构建、覆盖或改号已有安装包。可单独重试：

```bash
gh workflow run atomgit-sync.yml -f tag=v3.0.0
```

镜像仍验证公开附件的完整字节和签名，并保持版本单调递增。静态入口 401/403 等访问拒绝先检查同一官方仓库 updates 分支的文件 API，客户端与发布验证共用固定公钥验签；内容或签名错误立即停止。两个读取入口都拒绝访问时立即报告，404、限流和服务暂时不可用保留有上限的重试。独立镜像仅接受已公开的正式标签，并核对自动触发的发布提交与该标签一致。

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
