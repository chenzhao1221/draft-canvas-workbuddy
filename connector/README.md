# Draft Canvas（WorkBuddy 连接器）

在对话里打开草稿面板：助手把稿子发布到面板，你直接改，改动随下一条消息回到模型。

## 包里有什么

| 文件 | 说明 |
|---|---|
| `connector-meta.json` | 连接器元数据（`source` = `draft-canvas`，无认证） |
| `mcp.json` | stdio 传输，`npx -y draft-canvas-workbuddy` 启动，Node ≥ 20，npm 源为 npmmirror |
| `icon.svg` | 64×64 图标 |
| `skills/draft-fence/SKILL.md` | 教模型调用 `draft_canvas_publish` / `draft_canvas_open` 的技能（与 MCP App 版同一份） |
| `mcp/server.mjs` | MCP 服务器（无第三方运行时依赖） |
| `panel/widget.html` | 内联的草稿面板（MCP App widget） |

## 注意

- npm 包名是 `draft-canvas-workbuddy`；`mcp.json` 的 `args` 与 `package.json` 的 `name`/`bin` 都由
  `scripts/package-workbuddy.mjs` 的 `PACKAGE_NAME` 派生，改包名只需改这一处再重新打包。
- 连接器不自带认证、不写任何本机绝对路径；草稿状态写到宿主自己的 `~/.workbuddy/draft-canvas`。

## 许可

Apache-2.0，见包内 `LICENSE`。与 Kiro Crew 版同源。
