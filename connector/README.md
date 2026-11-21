# Draft Canvas（WorkBuddy 连接器）

在对话里打开草稿面板：助手把稿子发布到面板，你直接改，改动随下一条消息回到模型。

## 包里有什么

| 文件 | 说明 |
|---|---|
| `connector-meta.json` | 连接器元数据（`source` = `draft-canvas`，无认证） |
| `mcp.json` | stdio 传输，`npx -y draft-canvas-workbuddy-tbd` 启动，Node ≥ 20，npm 源为 npmmirror |
| `icon.svg` | 64×64 图标 |
| `skills/draft-fence/SKILL.md` | 教模型调用 `draft_canvas_publish` / `draft_canvas_open` 的技能（与 MCP App 版同一份） |
| `mcp/server.mjs` | MCP 服务器（无第三方运行时依赖） |
| `panel/widget.html` | 内联的草稿面板（MCP App widget） |

## 注意

- **包名是占位**：`draft-canvas-workbuddy-tbd`。正式发布前必须由辰萧确定 npm 包名，并同步改
  `mcp.json` 的 `args`、`package.json` 的 `name` 与 `bin`。
- 未发布到 npm 之前，`npx` 无法解析这个包名；本地验证走 `npm pack` 出的 tarball（见仓库 `scripts/verify-connector.mjs`）。
- 连接器不自带认证、不写任何本机绝对路径；草稿状态写到宿主自己的 `~/.workbuddy/draft-canvas`。

## 许可

Apache-2.0，见包内 `LICENSE`。与 Kiro Crew 版同源。
