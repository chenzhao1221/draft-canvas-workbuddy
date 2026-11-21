# NOTES（交接）

## 这个仓库是什么

`draft-canvas-workbuddy`：从 Kiroween Crew App 仓库（`draft-canvas-kiro-crew`，源目录
`.kiro/crew/workspace/draft-canvas/app`）拷出的 **WorkBuddy 宿主独立版**。只保留 WorkBuddy 需要的部分，
不含 Kiro Crew 宿主、不含 `.kiro`、不连任何远程。

拷入的是**工作区当前文件**（包括当时未提交的 15 个修改文件和 4 个未跟踪文件），不是 HEAD。

## 已有文件

- `packages/core`：围栏/版本/changelog/框选改写，与 Crew 版相同。
- `packages/ui`：React 面板（CodeMirror、版本翻页、对比、审阅），含工作区未提交的 i18n/icons/styles 改动。
- `packages/hosts/workbuddy`：本地中继、浏览器面板、`UserPromptSubmit` hook、MCP App 服务器与 widget、技能原文。
- `fixtures/conformance`：core 的一致性测试数据（缺了 core 会有一个测试文件失败）。
- `docs/`：`ADAPTER_INTERFACE.md`、`FENCE_SPEC.md`、`PROJECT.md`、`TROUBLESHOOTING.md`、`TUTORIAL.md`、`hosts/workbuddy.md`。
- `scripts/package-workbuddy.mjs`：构建 `dist/workbuddy/`，并生成 `dist/connector/`。
- `scripts/verify-connector.mjs`：不安装、无窗口地验证 tarball 能否按连接器配置启动 MCP。
- `connector/`：连接器模板（meta、mcp.json、icon、README），打包时并入 `dist/connector/`。
- `README.md`、`LICENSE`（Apache-2.0）、`NOTICE`（已按 WorkBuddy 实际打包情况改了 React / MCP SDK 的条目）。

## 测试结果（2026-11-21，Windows）

```
npm run build   OK
npm test        411 passed, 3 skipped  （24 个测试文件）
  packages/core            266 passed, 3 skipped
  packages/ui               80 passed
  packages/hosts/workbuddy  65 passed
npm run package:wb         OK（dist/workbuddy 9 个文件；dist/connector 11 个文件）
npm pack                   draft-canvas-workbuddy-tbd-0.1.0.tgz（11 个文件，约 453 KB）
node scripts/verify-connector.mjs   38/38 通过
```

3 个 skipped 是 core 里原有的、按平台跳过的用例，不是本次改动引入。

`verify-connector` 的做法：`tar` 解包到临时目录 → 读 `mcp.json` → 用解出的包代替未发布的占位包名 →
从别的 cwd 启动 → 完成 initialize / tools/list / resources/list / resources/read（面板 HTML 1.4 MB 内联）/
`draft_canvas_publish` 后读回 state → 关闭 stdin 退出 0 → 复查 PID 已消失。草稿写到临时 state 目录，
`~/.workbuddy` 没被写；没有跑 `npm install`，没有装 hook，没有启动浏览器或桌面程序。

## 连接器包里已经有的东西

`connector-meta.json`（source `draft-canvas`，中英双语，无认证，minWorkbuddyVersion 5.0.0）、
`mcp.json`（stdio + npx + runtime.type=node + npmmirror，无本机路径）、`icon.svg`（64×64）、
`skills/draft-fence/SKILL.md`（MCP App 版技能，与宿主里那份逐字节相同）、`mcp/server.mjs`、
`panel/widget.html`、`bin/draft-canvas.mjs`、去掉 `private` 的 `package.json`、README/LICENSE/NOTICE。

## 还缺什么

1. **npm 包名未定**：现在是占位 `draft-canvas-workbuddy-tbd`。定名后改
   `scripts/package-workbuddy.mjs` 的 `PACKAGE_NAME` 一处，重跑 `npm run package:wb` 和 `npm pack`。
   包名确定前 `npx` 解析不到，连接器无法真正安装——本地验证用 tarball 代替了这一步。
2. 未发布 npm、未建公开仓库、未做开放平台认证、未提交上架（按约定等拍板）。
3. 连接器在真实 WorkBuddy 客户端里的加载与信任流程未实测（只在本地跑了 MCP 协议）。
4. 面板 widget 1.48 MB，超过规范里 256 KB 的预取阈值；宿主只传 `resourceUri`、由 widget 回拉的路径
   在桌面版没实测过（`docs/hosts/workbuddy.md` 已记录）。
5. `connector-meta.json` 的 `version` 与宿主同步为 0.1.0；上架前建议改成 1.0.0 并从此独立递增。

## 需要辰萧拍板

- **npm 包名**（决定 `PACKAGE_NAME`、`mcp.json` 的 args、`package.json` 的 name/bin）。
- **是否公开发布 npm 包 / 是否建公开仓库**（当前只有本地 git，无 remote）。
- **是否走开放平台认证与上架**（涉及账号、审核、`server_auth` 等；当前 `auth_mode` 省略，无认证）。
- 连接器对外展示名：现在中英都是 `Draft Canvas`，中文名写作 `Draft Canvas 草稿面板`。
