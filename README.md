# Draft Canvas（WorkBuddy 版）

在对话里改稿：助手把稿子发布到 **Draft Canvas 面板**，你直接在面板里改，改动随下一条消息回到模型。
面板是 MCP App，渲染在 WorkBuddy / CodeBuddy Code 的对话卡片里。

**与 Kiro Crew 版同源**：`packages/core`（围栏解析、版本、changelog、框选改写）和 `packages/ui`（编辑器、版本翻页、
对比与审阅视图）来自同一个 Kiroween Crew App 仓库，这里只保留 WorkBuddy 宿主与连接器打包。
两个版本各自演进，但格式与适配器契约仍以 [`docs/ADAPTER_INTERFACE.md`](docs/ADAPTER_INTERFACE.md)、
[`docs/FENCE_SPEC.md`](docs/FENCE_SPEC.md) 为准。

许可：[Apache-2.0](LICENSE)。第三方组件见 [NOTICE](NOTICE)。

## 它做什么

1. 你让助手写一段东西，助手调用 `draft_canvas_publish(id, title, body)` 把**全文**放进面板。
2. 面板在对话里展开，你直接改；每一版都留在版本翻页里，可以对比、按 hunk 审阅。
3. 你点「发给 AI」后，改动以 `draft-changelog`（SEARCH/REPLACE）随下一条消息发出；框选一段则发
   `draft-rewrite`，只带选中的文字和位置。
4. 助手按改动生成下一版，再次发布，面板当场刷新。

## 两种跑法

| | 连接器（MCP App，推荐） | 本地网页版 |
|---|---|---|
| 面板在哪 | 对话里的工具卡片，可全屏 | 浏览器标签，`127.0.0.1:47831` |
| 怎么装 | `dist/connector` 或 npm 包 | `dist/workbuddy install` + `start` |
| 发消息 | `ui/message` 真发一条 | `UserPromptSubmit` 钩子注入上下文 |
| 需要 hook | 不需要 | 需要 |

连接器不需要 hook、不需要权限、不写任何本机绝对路径；草稿状态在 `~/.workbuddy/draft-canvas/`。

## 开发

需要 Node.js 20+。依赖走 npmmirror（见 `.npmrc`）。

```bash
npm install
npm run build          # tsc -b，core/ui/workbuddy 的 dist
npm test               # 三个 workspace 的 vitest
npm run package:wb     # → dist/workbuddy/ 与 dist/connector/
```

测试全部无窗口（Node + jsdom），不会启动浏览器或桌面程序。

## 打连接器包

```bash
npm run package:wb
cd dist/connector
npm pack               # → draft-canvas-workbuddy-0.1.0.tgz
cd ../..
node scripts/verify-connector.mjs
```

`dist/connector/` 就是上架用的目录：

```
connector-meta.json      source=draft-canvas，中英名称/描述/示例，minWorkbuddyVersion 5.0.0
mcp.json                 stdio，npx -y draft-canvas-workbuddy，runtime.type=node，npmmirror
icon.svg                 64×64
skills/draft-fence/SKILL.md   MCP App 版技能，原样拷入
mcp/server.mjs           MCP 服务器（无第三方运行时依赖）
panel/widget.html        内联面板（MCP App widget）
bin/draft-canvas.mjs     npx 实际执行的入口
package.json             已去掉 private；包名是占位
README.md / LICENSE / NOTICE
```

`verify-connector.mjs` 不解包安装：它用 `tar` 把 tarball 解到临时目录，按 `mcp.json` 的配置从**别的 cwd**
启动 MCP，跑完 `initialize` / `tools/list` / `resources/read` / `draft_canvas_publish` 后按 PID 关掉进程。

### 包名与发布

- npm 包名：`draft-canvas-workbuddy`（v0.1.0）。改包名只需改 `scripts/package-workbuddy.mjs` 的
  `PACKAGE_NAME` 一处（`package.json` 的 `name`/`bin` 与 `mcp.json` 的 `args` 都由它派生），再重新打包。
- 仓库：[github.com/chenzhao1221/draft-canvas-workbuddy](https://github.com/chenzhao1221/draft-canvas-workbuddy)。
- 安装连接器时，`npx -y draft-canvas-workbuddy` 会从 npmmirror 拉包；不需要 hook、不需要全局安装。
  npm 发布尚未完成（发布前需在本机登录 npm 官方源）。
- 开放平台认证与上架尚未提交，等辰萧确认后再走。

## 本地网页版（保留）

```bash
node dist/workbuddy/bin/draft-canvas-wb.mjs install   # 写 hooks + 技能，先备份 settings.json
node dist/workbuddy/bin/draft-canvas-wb.mjs start     # 打印 127.0.0.1 面板地址
```

`install` 会改 `~/.workbuddy/settings.json` 和 `~/.workbuddy/skills/`，需要重启 WorkBuddy 或新开对话才生效。
不需要时用 `uninstall` 摘掉 hook。宿主细节见 [`docs/hosts/workbuddy.md`](docs/hosts/workbuddy.md)。
