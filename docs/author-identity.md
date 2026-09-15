# langjiahui 作者标识

入口：设置 → 关于与隐私。保留 MailAI 产品图标，不新增引导弹窗。

素材：`app/web/static/assets/langjiahui-avatar.png`。使用内置 imagegen 从用户批准的概念稿整理，非 CLI。绿色 LJH 交织字母、暖白底、陶瓷质感；署名以 HTML 文本呈现。

最终生成提示词：

> Use case: precise-object-edit. Input is the approved langjiahui personal identity concept board. Produce ONE production avatar only: isolate and faithfully retain the large left-hand ivory rounded square tile with the intertwined forest-green and sage LJH ceramic ribbon symbol. Square canvas, tile fills 94% of frame, centered. Preserve the approved symbol geometry and colors and soft sculptural depth; simplify tiny texture for readability at 96px. Solid warm ivory background #F5F4EC, no transparency needed. Remove the entire right-hand wordmark and swatches and all text. No additional elements. This is an avatar asset for the MailAI author profile.

数据说明依据：`app/config.py` 中数据库与原文目录、`app/db.py` 的 SQLite 连接、`app/llm/client.py` 的配置 API 请求。明确区分本机保存与联网处理，不宣称全离线、磁盘加密、无遥测或绝对安全；不虚构联系方式或认证。

检查：`tests/test_author_browser.cjs` 隔离加载页面与真实导航处理代码，不访问邮箱或模型服务。截图输出到 `build/author-{light,dark,mobile}.png`。
