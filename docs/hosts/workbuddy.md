# WorkBuddy 宿主：实测事实与假设

适用版本：0.1.0（WorkBuddy 桌面版 + CodeBuddy Code CLI 同一套运行时，实测于 2026-11-19，Windows）。
本文回答 `PROJECT.md` 第 6 节的七个问题，并记录两个移植时绕不开的发现。移植步骤见 `PROJECT.md` 第 10 节。

安装与使用：见 `TUTORIAL.md`「WorkBuddy 版」一节。

---

## 0. 结论速览

第 10 节要求的「三件事」在 WorkBuddy 上的实测结果：

| 要做的事 | 结论 | 怎么做到的 |
|---|---|---|
| 读聊天历史 | ✅ 能，但**读不到助手的话** | 会话转录 `~/.workbuddy/projects/<会话>/<uuid>.jsonl` 里只有用户消息和工具调用；助手正文不在里面（见第 2 节）。助手写稿靠**落盘**（第 4 节） |
| 收到「回复完」的推送 | ✅ 能，而且是真推送 | `Stop` hook + `UserPromptSubmit` hook 打给本地中继；没有 hook 时退回轮询 |
| 用用户身份发消息 | ✅ 能（MCP App 版）／❌ 不能（本地网页版） | 面板做成 MCP App 后可以用 `ui/message` 直接发一条用户消息；本地网页版只能靠 `UserPromptSubmit` 钩子注入上下文 |

两种跑法，共用同一套 core / ui / 落盘逻辑：

| | 本地网页版 | MCP App 版（推荐） |
|---|---|---|
| 面板在哪 | 浏览器标签或结果区预览，`127.0.0.1:47831` | **客户端对话里**，工具卡片内渲染，可全屏 |
| 靠什么拿数据 | 本地中继 HTTP + SSE | `resources/read` 读 `ui://draft-canvas/*`（中继不需要了） |
| 怎么发消息 | 钩子 `additionalContext`（context-only） | `ui/message` 真发一条用户消息并唤醒模型 |
| 推送 | 钩子 + 轮询 | MCP 没有服务端推送，面板每 1.5 秒读一次资源 |
| 安装 | `install` + `start` | `mcp-install` + 重启客户端 + 信任服务器 |

**MCP App 版是怎么确定的**：客户端安装目录的 `resources/app.asar` 里能搜到 `text/html;profile=mcp-app`、
`_codebuddy.ai/mcpUiReadResource`、`_codebuddy.ai/mcpUiCallTool`、`codebuddy.ai/mcpUiIntercept`、
`ui/message`、`ui/open-link`、`ui/request-display-mode`、`sandbox_proxy`。内置的 Ardot 插件就是一个远端
MCP server，它的设计画布以 MCP App 面板的形式出现——同一套机制。

**已知变数**：面板 HTML 有 1.5 MB，超过文档里 256 KB 的「预取」阈值。超过时宿主只传 `resourceUri`，
由 widget 回拉一次。这条路没有实测过；如果面板出现空白，先退回本地网页版，并把现象记到 TROUBLESHOOTING。

---

## 1. 七个问题，逐条回答

### Q-1 插件读对话要什么权限？升级后会不会自动给？

**不需要权限申请，也没有权限系统。** WorkBuddy 没有 Crew 那种 `app.json` + `permissions.api` + 「待批准」机制。

面板能拿到的信息只有两类：

- **会话转录文件**：`~/.workbuddy/projects/<压缩后的工作目录>/<sessionId>.jsonl`，普通文件，谁都能读（面板的中继进程直接读）。
- **hook 载荷**：hook 从 stdin 收到 `session_id`、`transcript_path`、`cwd`、`permission_mode`、`generation_id` 和事件字段，这是唯一可靠的「我现在在哪个会话、转录文件在哪」的来源。

推论：**没有权限可以「没批准」**，所以 Crew 版那套「面板显示去应用页批准」的逻辑在这里没有对应物。取而代之的检查是「hooks 装没装」：没装时面板顶部提示「新回复不会自动显示」。

### Q-2 插件能不能收到「AI 回复完」的推送？

**能。** hook 事件里有 `Stop`（主代理响应结束）和 `UserPromptSubmit`（用户提交消息），都是同步执行、能从 stdin 拿到 `session_id` 和 `transcript_path`。

- `Stop` 不等于「助手消息已经写进转录」：实测消息落盘比 hook 晚一点，所以中继在 `Stop` 之后按 0 / 300 / 1200 / 2600 ms 再读几次。
- `Stop` 因用户中断而不触发（文档明说），所以还有每 1.2 秒的轮询兜底。

推送带不带回复全文？**不带**，只有会话编号和事件名。和 Crew 一样，不要只取「最后一条」。

### Q-3 能不能把文字放进用户的输入框？

**不能。** WorkBuddy 桌面版没有任何对插件开放的输入框 API（`wbipc` 是应用内部命名管道，带 ticket，不属于公开接口）。

可用的投递方式是 `UserPromptSubmit` hook 的 `additionalContext`：

```
hook stdout → {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"…"}}
```

它把文字喂给这一轮的模型，**不写进已保存的用户消息**。按 `ADAPTER_INTERFACE` 第 8 节，这就是 `fidelity: 'context-only'`，且 `requiresUserSend: false`（中继自己挂上去，用户只要正常发一句话）。发送判定走第 8.2 节那条路：下一条 `user_message` 到达即视为已发出。

### Q-4 能不能直接以用户身份发消息？

**不能。** 没有 `POST /api/chat` 之类的东西。`codebuddy --serve` 的 REST/ACP 接口是对**它自己进程里的会话**生效的，和桌面版正在聊的那个会话不是同一个，用它「发消息」等于在另一个会话里自言自语。

所以 `canSendNow: false`，`sendNow` 直接以 `unsupported` 拒绝。`ADAPTER_INTERFACE` 第 7 节规定：`canSendNow` 为 `false` 时，框选改写退回 `injectNextTurn`，面板会把按钮语义改成「放进下一条消息」。

### Q-5 面板知道自己属于哪个对话吗？能自己打开吗？

**不知道，也打不开。** 没有 tab、没有「当前会话 id」可查。中继的启发式：

1. 最近一个产生 hook 事件的会话（`UserPromptSubmit` / `Stop`）＝用户正在看的那个；
2. 面板里下拉框选过就听用户的；
3. 都没有就返回 `null`，面板显示会话选择框（列表来自 `projects/*` 扫描 + hook 记录）。

面板不能被宿主打开：`canAutoOpenPanel: false`，用户自己在浏览器或 WorkBuddy 结果区的预览里打开 `http://127.0.0.1:47831/`。

### Q-6 升级后已打开的面板会换新代码吗？

**会，而且比 Crew 省事。** 面板是普通网页，刷新即最新；中继给 `panel.js` 加了 `cache-control: no-store`。没有 Crew 那种「入口文件按版本命名 + 关标签重开」的坑。

### Q-7 网络/后台断一下会怎样？

同 Crew：浏览器报 `Failed to fetch`。面板的 `EventSource` 自己重连，重连成功后发 `connection: connected`，控制器会重读历史并清掉临时读失败提示（第 15 条逻辑照旧）。

### Q-8 怎么装技能？

`~/.workbuddy/skills/<name>/SKILL.md`（CodeBuddy Code 是 `~/.codebuddy/skills/`）。`draft-canvas-wb install` 会写进去，**新开对话才生效**。

---

## 2. 发现一：桌面版转录里没有助手消息

这是移植时最要紧的一条，直接影响「对话是唯一的真相」这条原则能不能照搬。

`draft-canvas-wb doctor` 对当前会话（1.8 MB）的输出：

```
  parsed     2/423 lines, 2 messages, 421 skipped
  shapes     session-meta, message, file-history-snapshot, ai-title, reasoning, function_call, function_call_result
  roles      user=2
  record shapes (types and lengths only, never values):
    session-meta ×4      SKIPPED
    message ×2  role=user  blocks=input_text  mapped
    file-history-snapshot ×55  SKIPPED
    ai-title ×1  SKIPPED
    reasoning ×83  SKIPPED        content:array(0)  rawContent:array(1)[type/text]
    function_call ×139  SKIPPED   name, arguments
    function_call_result ×138  SKIPPED   output{type,text}
```

也就是说：**423 条记录里，`role=assistant` 的聊天消息是 0 条。** 助手说过的话只以 `reasoning`（思考）+ `function_call` / `function_call_result`（工具）的形式存在，正文没有落盘。

`doctor --probe <一段助手说过的话>` 也能验证：命中的只有工具参数、工具结果、`reasoning.rawContent`，没有独立的助手消息记录。

剩下的可能来源都不适合插件：桌面版把正文放在它自己的渲染进程/云端会话里（`edge_sync_mapping` 表就是「本地会话 ↔ 云端会话」的对照），本地只有 `workbuddy.db` 的 `sessions` 元数据，没有消息表。

### 于是「真相」换了一个落地方式：草稿落盘

`draft` 块仍然写在聊天里（给人看），但**面板读的是落盘文件**：

```
~/.workbuddy/draft-canvas/drafts/current/<id>.md      ← 智能体写，覆盖即新版本
~/.workbuddy/draft-canvas/drafts/history.jsonl        ← 中继追加，一条一个版本
```

中继把 `history.jsonl` 的每一条变成一个**合成的助手消息**，正文是 `formatDraftFence()` 生成的完整 `draft` 块（转义规则与 `ADAPTER_INTERFACE` 第 10.4 节完全一致），再和转录里的用户消息按时间合并成 `getHistory`。

好处：

- 版本仍然可重建、可翻页、可对比，`core` 一行没改；
- 面板重开、换浏览器、甚至换机器（只要带上 state 目录）都能拿回全部版本；
- 文件变化就是 `assistant_done` 事件，跟推送走同一条路。

代价（必须写清楚）：

- 模型**必须**按技能要求落盘，忘了落盘就只有聊天里那一段、面板看不到；
- 落盘只在「技能已装 + 模型照做」时成立，属于约定，不是宿主的保证；
- 文件写入时间由中继观测，精度到轮询间隔（默认 1.2 秒）。

### 顺带得到的两个好处

- `canStreamTokens: false`：既然没有逐字正文，就别假装能流式。面板改为「发布即出现」。
- 用户消息照样能读：`message` 记录里的 `content` 是 `input_text` 块，正文外面包了一层 `<user_query>…</user_query>`，中继会把这层壳去掉（那是宿主标记，不是用户写的）。

---

## 3. 发现二：面板不该是 tab，而是一个本地页面 + 本地中继

Crew 版的面板是宿主里的一块 UI，事件走宿主 WebSocket，读历史走宿主 HTTP。WorkBuddy 两者都没有对插件开放，所以这一版把「宿主该提供的东西」自己实现了一遍：

```
浏览器（面板页）  ←HTTP/SSE→  中继 draft-canvas-wb（本地进程）  ←读文件、收 hook→  WorkBuddy
```

中继负责 Crew Gateway 的那部分：

| 能力 | Crew 里是谁 | WorkBuddy 里是谁 |
|---|---|---|
| 读历史 | `GET /api/chat/slots/{slot}` | 读转录 JSONL + 读草稿落盘 |
| 收推送 | WebSocket `chat_chunk` / `chat_done` | `Stop`/`UserPromptSubmit` hook + 转录轮询 |
| 发消息 | `POST /api/chat` | 无（`unsupported`） |
| 放进输入框 | `openChat({ message })` | 挂起队列 + `UserPromptSubmit` 的 `additionalContext` |
| 面板宿主 | 侧边栏 tab | 浏览器页面（`127.0.0.1`，只监听回环） |

安全边界：

- 只监听 `127.0.0.1`，不监听 `0.0.0.0`；
- 不发任何 CORS 头，别的来源读不到响应；
- 写接口要求 `x-draft-canvas-request: 1` 头（跨源必触发预检，而预检不被放行）；
- 有 `Origin` 时必须等于本机同端口来源，否则 403；
- 不记录稿子内容，诊断日志只记事件名、条数、错误码。

---

## 4. 接口映射

| `HostAdapter` | WorkBuddy 实现 |
|---|---|
| `connect()` | `GET /api/info`（协议号、会话列表、hook 是否装好）+ 订阅 `/api/events`（SSE） |
| `getActiveSession()` | 面板选过的会话 → 最近有 hook 的会话 → `null`（面板显示选择框） |
| `listSessions()` | `GET /api/sessions`，标题取转录里第一条用户消息首行（扫描时算好并缓存，不在每次列表时读文件） |
| `getHistory()` | 转录消息（用户）+ 草稿落盘合成的助手消息，按时间合并；`completeness` 取转录解析结果 |
| `subscribe()` | SSE 帧 `{type:'host', event}`，非当前会话的事件丢弃 |
| `injectNextTurn()` | `POST /api/sessions/:id/inject` 写挂起队列 → hook 打印 `additionalContext`；`fidelity: 'context-only'`、`requiresUserSend: false` |
| `sendNow()` | `unsupported` |
| `storage` | 面板页的 `localStorage`（`draft-canvas:v1:wc:*`，键结构同 Crew 版） |
| `info.hostVersion` | 未取到（宿主没有可读版本号）→ 字段省略 |

能力标记：

```ts
canReadFullHistory: true,          // 转录是全量的（压缩会补 compact_boundary，降为 window）
canStreamTokens: false,            // 没有逐字正文，见第 2 节
canSendNow: false,                 // Q-4
canRewritePersistedUserMessage: false, // Q-3：只进模型上下文，不进已保存消息
canAppendToComposer: false,        // Q-3
canAutoOpenPanel: false,           // Q-5
hasHostStorage: true,
```

---

## 5. 与 `ADAPTER_INTERFACE` 的偏差（有意为之，记录在案）

1. **`getHistory` 的助手消息来自插件自己维护的落盘历史，不是聊天记录。** 第 2 节说明了原因。`Message` 的形状不变，`core` 无感知；但第 2 节原则 1「版本必须能从会话历史重建」在这个宿主上等价于「从落盘历史重建」。
2. **不返回 `system` 和 `tool` 消息**（第 9.1 节建议返回）。面板每 5 秒重读一次，把几十 KB 的系统提示和工具结果塞进响应没有意义，`core` 也只用 user/assistant。
3. **用户消息去掉 `<user_query>` 外壳和 `<system-reminder>` / `<task-notification>` 块**。这些是宿主拼进去的标记；留着会让面板把「后台任务完成通知」当成用户说的话（实测确实会发生）。
4. **`assistant_done` 的触发点是落盘文件变化，不是「助手消息入库」**。语义上等价：一条完整的 `draft` 块出现即一版。

---

## 6. 在客户端里跑（MCP App）

```bash
node dist/workbuddy/bin/draft-canvas-wb.mjs mcp-install     # 写进 ~/.workbuddy/mcp.json，自动备份
```

然后：重启 WorkBuddy → 在连接器/插件页里**信任** `draft-canvas`（自己加的 MCP 服务器默认不受信）→ 在对话里说
「打开草稿面板」，或让模型写完稿后自己调 `draft_canvas_open`。

实现要点：

面板在对话里就是「那篇稿子」：技能改成**不写 `draft` 代码块**，而是调 `draft_canvas_publish(id, title, body)`；工具卡片本身就是面板，模型回复里不再重复一遍正文。发布时**服务器自己写落盘文件**（`drafts/current/<id>.md`），不再依赖模型记得写文件——这一步原来是最脆的。

三个工具：

| 工具 | 用途 |
|---|---|
| `draft_canvas_open` | 打开面板（`_meta.ui.resourceUri`），返回当前状态 |
| `draft_canvas_publish` | 写一版草稿：服务器落盘 + 返回版本号，面板当场刷新 |
| `draft_canvas_queue` | 兜底：宿主不允许 `ui/message` 时，把改动排进下一条消息 |

文件：

| 文件 | 作用 |
|---|---|
| `src/mcp/server.ts` | stdio MCP 服务器：`initialize` / `tools/list` / `tools/call` / `resources/read` |
| `src/mcp/service.ts` | 与本地中继同样的读逻辑（转录 + 落盘 + 挂起队列），无推送、无定时器 |
| `src/mcpTransport.ts` | 面板侧的 `Transport`：读资源、`ui/message` 发送、1.5 秒轮询差分出事件 |
| `src/mcpPanel.tsx` | widget 入口：`App.connect()`、跟主题、请求全屏 |
| `dist/workbuddy/panel/widget.html` | 整个面板内联成一个 HTML（沙箱 iframe 里相对路径不生效，必须内联） |

能力变化：`canSendNow: true`、`canRewritePersistedUserMessage: true`（`ui/message` 发的是真消息，所以「改动是否进历史」那条黄色横幅不该再出现），其余不变。发送失败会自动退回「排队 + 钩子」，不会丢改动。

### 面板尺寸（踩过两次）

结论：**高度必须交给宿主的测量（`autoResize: true`），不能用 `ui/notifications/size-changed` 自己报。**

- 第一版用 `autoResize: true` + 面板根节点 `height: 100%`：宿主测量文档时拿到的是 iframe 当前高度，卡片被压在 180 px，还带内部滚动条。
- 第二版改成 `autoResize: false` + 自己 `sendSizeChanged`：放大有效，**缩小无效** —— 收起时内容缩到 30 px，卡片还是 640 px，下面是整片空白（用户截图里的样子）。
- 现在：`autoResize: true`，并且**文档里任何地方都不写 `height: 100%`**（`html`/`body` 只留 `margin: 0`，`#root` 不设高度）。根节点用 px 定高（默认 640，可选 480 / 640 / 840，拖动分隔条微调，收起时 30），宿主按 `max-content` 量到多少就是多少，于是放大缩小都成立。

「全屏」按钮走 `ui/request-display-mode`，必须在点击手势里调；挂载时自动请求会被拒。

### 收起 / 展开

底部条上有「▾ 收起」：收起后只剩 30 px 一条「▸ 展开 · 草稿面板已收起」，`size-changed` 同时把 iframe 收到 30 px。**自动收起**发生在「新版本到达、而焦点不在面板里」的时候——用户可以一边看聊天一边让它自己让位，旧版本仍在版本翻页里；如果光标还在面板里（正在改、正在写意见），不收起。

### 「当前对话」怎么认

MCP 服务器拿不到会话 id（宿主的 MCP 环境变量白名单里没有，只有 `CODEBUDDY_CONVERSATION_MESSAGE_ID` 这种消息级 id）。所以按「**最近被写入的转录就是当前对话**」判断（15 分钟内有效），再用 hook 记录的会话兜底。面板因此不再要求用户先选对话。

`mcp-uninstall` 从 `mcp.json` 里摘掉这一条（备份在 `mcp.json.draft-canvas.bak.json`）。

## 7. 安装 / 使用 / 升级

```bash
# 在 app/ 下
npm.cmd install
npm.cmd run package:wb          # → dist/workbuddy/
node dist/workbuddy/bin/draft-canvas-wb.mjs install
node dist/workbuddy/bin/draft-canvas-wb.mjs start
```

`install` 做三件事（可回滚）：

1. 往 `~/.workbuddy/settings.json` 的 `hooks` 里加四个事件，命令指向 `dist/workbuddy/hooks/draft-canvas-hook.mjs`，`timeout: 5`；写之前备份到 `~/.workbuddy/draft-canvas-hook.mjs.settings-backup.json`，原有 hook 一条不动；
2. 把技能装到 `~/.workbuddy/skills/draft-fence/SKILL.md`，并把落盘目录的绝对路径替换进去；
3. 建好 `~/.workbuddy/draft-canvas/drafts/current/`。

`uninstall` 只摘掉自己那几条 hook，技能保留（手动删目录即可）。改完 settings 需要**重启 WorkBuddy 或新开对话**才生效——hook 快照在启动时抓一次。

升级：重新 `npm.cmd run package:wb`，重启 WorkBuddy，刷新面板页。落盘目录不在 `dist/` 里，不会丢。

---

## 8. 验证记录

| 项目 | 结果 | 依据 |
|---|---|---|
| 能读历史 | ✅ | 面板日志 `history demo-202: 2 messages (transcript, full)`；真实会话 `2/423 lines` |
| 能收推送 | ✅ | 中继日志 `sse: client connected`、`hook UserPromptSubmit`、`sink: trip-note` |
| 能发消息 | ❌ 按设计 | `sendNow` → `unsupported`；投递走 hook 上下文 |
| 一轮往返 | ✅ | 注入 changelog → 落盘新版本 → 历史 4 条、正文变成「我们周六一早出发」 |
| 面板渲染 | ✅ | 无头 Edge 截图：会话下拉、`出发前 · 第 1 版，共 1 版`、编辑区、`发给 AI` |
| 重载测试（8.1） | ⏳ 未做 | 结论取决于落盘路径（`fidelity: 'context-only'`），与 8.1 判定无关；需要用真实会话跑一次才能确认「下一条 user_message 到达 = 已发送」的判定 |

**未验证/不确定**：

- hook 在桌面版里是否每次都拿到 `transcript_path`（实测拿到过；文档只保证 CLI 会带）。
- 桌面版是否会改写或轮转转录文件（已按「文件变小 = 重写，整份重读」处理）。
- `SessionEnd` 在桌面版关闭窗口时是否触发（不影响正确性，只是少一次清理）。
- 会话标题扫描在超大转录上的耗时（已限制每次最多读 6 个文件的前 8 KB）。

---

## 9. 排查顺序（踩坑经验）

1. 面板说「正在连接 / 已断开」→ 中继没跑，或端口变了。看终端里的 `panel` 地址。
2. 面板说「新回复不会自动显示」→ hook 没装或没重启：`draft-canvas-wb status` 看 `hooks` 一行。
3. 面板一直「等待草稿」→ 按顺序查：`draft-canvas-wb status` 看会话在不在；`doctor` 看转录能不能读；`~/.workbuddy/draft-canvas/drafts/current/` 有没有文件（模型可能没按技能落盘）。
4. 点了「发给 AI」但模型没反应 → 面板顶部应显示「已排队」；发一句话后再看 `drafts/history.jsonl` 是否多了一条。
5. 一切正常但版本号不对 → 落盘文件内容没变就不算新版本（按内容 hash 判重）。
