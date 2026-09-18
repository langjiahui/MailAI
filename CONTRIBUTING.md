# 参与贡献 MailAI

感谢你愿意为 MailAI 贡献代码！本文档说明本地开发、提交与发布的基本流程。

## 本地开发环境

```bash
# 1. 克隆并创建虚拟环境
git clone https://github.com/langjiahui/MailAI.git
cd MailAI
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt

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

单元测试：

```bash
python -m pytest tests/ -q       # 或 python -m pytest tests/test_xxx.py -q
```

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
  db.py              SQLite 数据层（每个邮箱账号独立库）
  web/               FastAPI 接口与前端静态资源
tests/               Python 测试 + .cjs 浏览器测试
scripts/             发布门禁、打包、构建脚本
docs/                设计文档与审查报告
```

## 报告 Bug / 提需求

- 普通问题走 [Issues](https://github.com/langjiahui/MailAI/issues)，按模板填写
- **安全漏洞请走私有渠道**，见 [SECURITY.md](SECURITY.md)，不要开公开 issue

## 许可证

所有贡献默认按 [Apache License 2.0](LICENSE) 授权。提交 PR 即表示你同意以该许可证发布你的贡献。
