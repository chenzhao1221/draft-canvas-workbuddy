# Draft Canvas（WorkBuddy 版）

在 WorkBuddy / CodeBuddy Code 的对话里直接改 AI 写的稿子。**Draft Canvas** 把草稿放进可编辑的对话卡片（MCP App），你可以把修改发回给助手，并对照新旧版本，逐处审阅改动。

[安装连接器](#安装) · [下载 GitHub Release ZIP](https://github.com/chenzhao1221/draft-canvas-workbuddy/releases/tag/v0.1.0) · [查看 npm 包](https://www.npmjs.com/package/draft-canvas-workbuddy)

连接器需要 **Node.js 20+**，在 WorkBuddy 设置中添加并信任后即可使用。

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
| 怎么装 | npm 包（npx）或 GitHub Release 的 zip | `dist/workbuddy install` + `start` |
| 发消息 | `ui/message` 真发一条 | `UserPromptSubmit` 钩子注入上下文 |
| 需要 hook | 不需要 | 需要 |

连接器不需要 hook、不需要权限、不写任何本机绝对路径；草稿状态在 `~/.workbuddy/draft-canvas/`。

## 安装

前置条件：Node.js 20 或更高版本。npm 包：[draft-canvas-workbuddy](https://www.npmjs.com/package/draft-canvas-workbuddy)。

### 方式一：npx（推荐）

1. 打开 WorkBuddy 的**设置 → 连接器**（有的版本叫「MCP 服务器」或「扩展」），点「添加自定义连接器」。
2. 传输方式选 `stdio`，名称填 `draft-canvas`。
3. 命令填 `npx`，参数填 `-y draft-canvas-workbuddy`。
4. 保存后重启 WorkBuddy，在连接器页里**信任** `draft-canvas`（自己添加的 MCP 服务器默认不受信）。
5. 在对话里说「打开草稿面板」，或让助手写完稿后调用 `draft_canvas_open`。

如果界面支持直接粘贴 JSON，等价配置是：

```json
{
  "mcpServers": {
    "draft-canvas": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "draft-canvas-workbuddy"],
      "runtime": { "type": "node", "version": ">=20.0.0" },
      "timeout": 30000
    }
  }
}
```

**国内网络**：默认源慢或不通时，给 npx 指定 npmmirror。二选一：

- 参数里带源：`npx --yes --registry=https://registry.npmmirror.com draft-canvas-workbuddy`（JSON 里写成
  `"args": ["--yes", "--registry=https://registry.npmmirror.com", "draft-canvas-workbuddy"]`）；
- 或用环境变量：设置 `npm_config_registry=https://registry.npmmirror.com` 后再启动 WorkBuddy/命令；JSON 配置可在
  server 项里加 `"env": { "npm_config_registry": "https://registry.npmmirror.com" }`。

也可以全局安装后用命令直接启动：`npm i -g draft-canvas-workbuddy`，命令填 `draft-canvas-workbuddy`。

### 方式二：GitHub Release 的 zip（本地连接器）

1. 到 [Releases · v0.1.0](https://github.com/chenzhao1221/draft-canvas-workbuddy/releases/tag/v0.1.0) 下载
   `draft-canvas-workbuddy-connector.zip`。
2. 解压到一个固定目录。zip 的**根目录**就是 `connector-meta.json`、`mcp.json`、`bin/`、`mcp/`、`panel/`、
   `skills/`，没有再套一层目录。
3. 在 WorkBuddy 连接器页选择「添加本地连接器 / 从文件夹导入」，指向解压后的目录；如果没有这个入口，就按
   `mcp.json` 手动添加：传输 `stdio`，命令 `node`，参数填解压目录下的 `bin/draft-canvas.mjs` 的**绝对路径**。
4. 重启并信任 `draft-canvas`。

本地方式不经过 npm，移动过目录后要回来改一次绝对路径。

### 技能 draft-fence

技能 **draft-fence 已在 WorkBuddy 技能市场**，搜索安装即可；连接器包里的 `skills/draft-fence/SKILL.md` 是同一份，
用 zip 方式安装时随目录一起生效，不必重复装。

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

`dist/connector/` 就是发布用的目录（npm 包与 GitHub Release 的 zip 都由它生成）：

```
connector-meta.json      source=draft-canvas，中英名称/描述/示例，minWorkbuddyVersion 5.0.0
mcp.json                 stdio，npx -y draft-canvas-workbuddy，runtime.type=node，npmmirror
icon.svg                 64×64
skills/draft-fence/SKILL.md   MCP App 版技能，原样拷入
mcp/server.mjs           MCP 服务器（无第三方运行时依赖）
panel/widget.html        内联面板（MCP App widget）
bin/draft-canvas.mjs     npx 实际执行的入口
package.json             已去掉 private；包名 draft-canvas-workbuddy，bin 路径不带 ./ 前缀
README.md / LICENSE / NOTICE
```

`verify-connector.mjs` 不解包安装：它用 `tar` 把 tarball 解到临时目录，按 `mcp.json` 的配置从**别的 cwd**
启动 MCP，跑完 `initialize` / `tools/list` / `resources/read` / `draft_canvas_publish` 后按 PID 关掉进程。

### 包名与分发

- npm 包名：`draft-canvas-workbuddy`（v0.1.0），已发布到官方源：
  [npmjs.com/package/draft-canvas-workbuddy](https://www.npmjs.com/package/draft-canvas-workbuddy)。国内用 npmmirror
  时首次拉取可能晚几分钟同步。
- 仓库：[github.com/chenzhao1221/draft-canvas-workbuddy](https://github.com/chenzhao1221/draft-canvas-workbuddy)，
  Release `v0.1.0` 附 `draft-canvas-workbuddy-connector.zip`。
- 改包名只需改 `scripts/package-workbuddy.mjs` 的 `PACKAGE_NAME` 一处（`package.json` 的 `name`/`bin` 与
  `mcp.json` 的 `args` 都由它派生），再重新打包。
- 安装连接器时，`npx -y draft-canvas-workbuddy` 会从 npm 源拉包；不需要 hook、不需要全局安装。
- WorkBuddy 开放平台目前不允许个人开发者创建连接器，因此不提交市场；分发走 npm 与 GitHub Release。
  技能 `draft-fence` 走 WorkBuddy 技能市场。

## 本地网页版（保留）

```bash
node dist/workbuddy/bin/draft-canvas-wb.mjs install   # 写 hooks + 技能，先备份 settings.json
node dist/workbuddy/bin/draft-canvas-wb.mjs start     # 打印 127.0.0.1 面板地址
```

`install` 会改 `~/.workbuddy/settings.json` 和 `~/.workbuddy/skills/`，需要重启 WorkBuddy 或新开对话才生效。
不需要时用 `uninstall` 摘掉 hook。宿主细节见 [`docs/hosts/workbuddy.md`](docs/hosts/workbuddy.md)。
