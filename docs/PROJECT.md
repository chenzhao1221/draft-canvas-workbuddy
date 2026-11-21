# Draft Canvas 项目书

版本：0.1.15（Kiro Crew 版）。本文给要把 Draft Canvas 移植到别的宿主（比如 WorkBuddy）的人看。

相关文档：

| 文档 | 内容 |
|---|---|
| `docs/TUTORIAL.md` | 用户教程：安装、使用 |
| `docs/TROUBLESHOOTING.md` | 0.1.1 到 0.1.15 遇到的每个问题、原因、解决办法 |
| `docs/FENCE_SPEC.md` | 三种代码块格式的正式规格 |
| `docs/ADAPTER_INTERFACE.md` | 核心和宿主之间的接口规格（移植必读） |
| `docs/hosts/kiro-crew.md` | Kiro Crew 宿主的实测事实和假设 |
| `../UI-BRIEF.md` | UI 改版说明和配色 |

---

## 1. 它解决什么问题

在 AI 聊天里改长文很别扭：AI 每次回整篇，用户想改一句话，要么自己复制粘贴，要么用文字描述「第三段第二句改成……」。

Draft Canvas 在聊天旁边开一个面板：

1. AI 把稿子写进一个 `draft` 代码块，面板自动认出，显示成可编辑的「第 1 版」。
2. 用户直接在面板里改字，或者选中一段写「意见」。
3. 点一次「发给 AI」，改动和意见合成一条消息发出去。改动用 SEARCH/REPLACE 块精确表达，不用整篇重发。
4. AI 回一版完整新稿，面板自动换成新版。所有旧版都留着，可翻页、两版对比。

## 2. 三条设计原则

1. **对话就是唯一的真相。** 一个版本只有出现在助手消息里、是完整的 `draft` 块时才算数。所有版本都能从聊天历史重建。面板关了再开、换电脑，版本不会丢。
2. **面板只存「工作副本」。** 用户还没发出的改动放在本机存储里，尽力保存。丢了也不会丢版本，也从不当成版本显示。
3. **插件里没有写作模型。** 写作全由聊天里的 AI 做。插件只负责认块、算差异、拼消息。

## 3. 三种代码块（协议）

完整规格见 `docs/FENCE_SPEC.md`。

**AI 写稿：`draft`**

````text
```draft id="trip-note" title="游记" lang="markdown"
全文……
```
````

- 同一个 `id` 再出现一次就是新一版。面板自己数版本号（1、2、3……），不信 AI 写的 `rev`。
- 没写 `id` 的统一算作 `draft-1`（0.1.3 起）。
- 每次都写全文，不写片段。

**用户改稿：`draft-changelog`**（面板生成，放在用户消息里）

````text
```draft-changelog id="trip-note" from="2" to="3"
*** Begin Patch
<<<<<<< SEARCH
原文
=======
改后
>>>>>>> REPLACE
*** End Patch
```
````

**用户提意见：`draft-rewrite`**（面板生成）

````text
```draft-rewrite id="trip-note" rev="3" start_line="4" end_line="4" start_offset="0" end_offset="7"
被选中的原文
```

这句再口语一点。
````

一次发送里，先放所有 `draft-changelog`，再放所有 `draft-rewrite`。`rev` 等于修改记录的 `to` 时，表示坐标指的是**改完以后**的文字（0.1.7 起）。AI 按顺序处理：先套用修改，再按意见改，最后回一个完整 `draft`。

AI 要靠一个技能文件学会这套格式：`packages/hosts/kiro-crew/skill/draft-fence.md`。

## 4. 代码结构

```text
app/
  packages/
    core/            与宿主无关的逻辑：认块、版本库、算差异、拼消息、会话控制器
    ui/              React 面板（只依赖 core 和一个注入的 HostAdapter）
    hosts/
      kiro-crew/     Kiro Crew 适配器 + 面板入口 + app.json + 技能文件
      workbuddy/     WorkBuddy 版：本地中继 + 网页面板 + hook + 适配器 + 技能
  scripts/
    package-crew.mjs     打包成 Crew 应用文件夹 dist/crew-app/
    package-workbuddy.mjs 打包成可直接运行的 dist/workbuddy/
    check-licenses.mjs   检查打进包的依赖许可证
  docs/              规格和文档
```

| 包 | 依赖 | 移植时 |
|---|---|---|
| `@draft-canvas/core` | 无 DOM、无宿主 SDK | **原样复用** |
| `@draft-canvas/ui` | React、CodeMirror 6、core | **原样复用**（要宿主能跑 React） |
| `hosts/kiro-crew` | Crew 应用 SDK | **照着写一份新的** |
| `hosts/workbuddy` | 无（自己起中继、自己读转录） | 第 11 节，已写过一份，可作第二个样例 |

测试：核心约 270 条，界面约 80 条，Crew 适配器约 120 条。`npm.cmd test` 全跑只要几秒。

## 5. 宿主适配器接口（移植的核心）

正式规格见 `docs/ADAPTER_INTERFACE.md`。新宿主要实现一个 `HostAdapter`：

| 方法 | 作用 |
|---|---|
| `connect()` / `dispose()` | 连上、断开宿主 |
| `getActiveSession()` | 返回面板当前跟的对话；不知道就返回 `null`，面板会让用户选 |
| `listSessions()`（可选） | 列出对话，给选择框用 |
| `getHistory(sessionId)` | 读这个对话的全部消息（`role`、`text`、`id`、时间） |
| `subscribe(listener)` | 推送事件，见下表 |
| `injectNextTurn(sessionId, text)` | 把文字放进用户的输入框（不发送） |
| `sendNow(sessionId, text)` | 直接以用户身份发出一条消息 |

事件：

| 事件 | 什么时候发 |
|---|---|
| `assistant_chunk` | AI 正在写，每来一段字 |
| `assistant_done` | AI 一条回复写完（带完整消息） |
| `user_message` | 出现一条用户消息 |
| `history_reset` | 「请整个重读历史」（推送不可靠时最好用的兜底） |
| `session_changed` | 面板跟的对话换了 |
| `connection` | 连接状态：已连 / 重连中 / 断开 |

能力标记（`capabilities`）：`canSendNow`、`canAppendToComposer`、`canStreamTokens`、`canReadFullHistory`、`hasHostStorage`、`canAutoOpenPanel`、`canRewritePersistedUserMessage`，以及 `maxInjectBytes`、`maxSendBytes`。面板按这些决定显示什么、走哪条发送路径。

## 6. 在 Kiro Crew 上学到的、移植时要先问清的事

这些都是 Crew 上真实踩过的坑（详见 `docs/TROUBLESHOOTING.md`），换宿主时逐条确认：

| 问题 | Crew 的答案 | 对移植的意义 |
|---|---|---|
| 插件读对话要什么权限？升级后会不会自动给？ | 要在 `app.json` 写 `permissions.api`，按路径原样比对；**每次升级加了新权限都要用户手动批准** | 面板要能看出「没权限」，并明确提示用户（第 1、4 条） |
| 插件能不能收到「AI 回复完」的推送？ | 只推给插件自己建的对话；用户的对话要额外申请 `slots:user` | 先确认推送范围，否则面板永远不刷新（第 6 条） |
| 推送带不带回复全文？会不会比消息入库早到？ | `chat_done` 只带对话编号，可能早到 | **不要只取「最后一条」**，收到推送就整个重读，再加延迟重读和定时重读（第 10 条） |
| 面板知道自己属于哪个对话吗？ | 不知道（Crew 不告诉插件） | 要做对话选择框和「猜最近的对话」 |
| 升级后已打开的面板会换新代码吗？ | 不会，要关掉标签重开 | 入口文件按版本命名，提示用户重开（第 2 条） |
| 网络/后台断一下会怎样？ | 浏览器报 `Failed to fetch` | 读成功后自动清掉报错（第 15 条） |
| 能直接以用户身份发消息吗？ | 能（`POST /api/chat`），失败时退回 `openChat` | 决定「发给 AI」是直接发还是放进输入框 |
| 怎么装技能？ | `~/.kiro/crew/skills/<名字>/SKILL.md`，新开对话才生效 | 找到新宿主放技能/规则的位置 |

## 7. 刷新策略（0.1.15 的最终做法）

```text
收到 chat_done ──> 整个重读历史 ──> 2 秒后再重读一次
面板开着时 ────────> 每 5 秒重读一次（兜底）
点「发给 AI」前 ──> 先重读，发现有没显示过的新版就不发
```

重读发现新版时：

| 情况 | 处理 |
|---|---|
| 用户没有「AI 还没看到的改动」 | 直接换成新版，提示「已更新到第 n 版」 |
| 用户发出后又改了、还没发 | 弹审阅，逐块挑，免得这些改动丢掉 |

## 8. 诊断

面板右上角「诊断」按钮：内存里记最近 200 条事件（推送是否到达、收下还是丢掉、重读、读失败），不记稿子内容，可一键复制。移植时建议保留同样的日志点，排查推送问题全靠它。

## 9. 版本历史

| 版本 | 改了什么 |
|---|---|
| 0.1.1 | 修正权限路径写法；加中文界面 |
| 0.1.2 | 中英切换，记住选择 |
| 0.1.3 | 没 `id` 的块算 `draft-1`；入口按版本命名 |
| 0.1.4 | 没批准权限时明确提示 |
| 0.1.5 | 字号、字体可调 |
| 0.1.6 | 申请 `slots:user` 事件；只收当前对话的推送 |
| 0.1.7 | 两个发送按钮合成一个「发给 AI」，改动和意见一起发 |
| 0.1.8 | 事件权限没批时提示；发送前先重读，防止在旧版上改 |
| 0.1.9 | 新版直接进编辑框，不再每次弹审阅 |
| 0.1.10 | 收到推送整个重读，加延迟重读和每 15 秒重读 |
| 0.1.11 | 常驻提示可关闭；通知挪到顶部 |
| 0.1.12 | 新配色和排版（浅色、深色） |
| 0.1.13 | 添加意见后自动取消选中 |
| 0.1.14 | 诊断日志；重读间隔缩到 5 秒 |
| 0.1.15 | 读成功后自动清掉「Failed to fetch」 |

## 10. 给 WorkBuddy 版的建议步骤

1. 先读本文第 5、6 节和 `docs/ADAPTER_INTERFACE.md`，逐条回答第 6 节表格里的问题。
2. 新建 `packages/hosts/workbuddy/`，照 `packages/hosts/kiro-crew/src/adapter.ts` 的结构写适配器。`core` 和 `ui` 不要改。
3. 照 `packages/hosts/kiro-crew/test/` 写适配器测试；`fixtures/conformance/` 里有通用的一致性测试数据。
4. 加一个对应的打包脚本，产物放进 `dist/`。
5. 技能文件 `draft-fence.md` 的格式部分通用，只改最后「安装」那一节。
6. 先在真实宿主里验证三件事：能读历史、能收到「回复完」推送、能发出消息。这三件不通，别的都白做。

## 11. WorkBuddy 版（0.1.0）的结论

第 10 节的六步已经走完，结果在 `docs/hosts/workbuddy.md`。两个必须知道的结论：

1. **桌面版转录里没有助手消息。** 1.8 MB、423 行的转录里 `role=assistant` 的聊天消息是 0 条，助手正文只存在 `reasoning` / `function_call` / `function_call_result` 里，聊天正文不在本地。所以「版本从会话历史重建」在这个宿主上等价于「从插件自己的落盘历史重建」：技能要求智能体把每篇草稿写到 `~/.workbuddy/draft-canvas/drafts/current/<id>.md`，中继把每次变化变成一条带完整 `draft` 围栏的助手消息，`core` 不用改。
2. **WorkBuddy 既没有面板 SDK，也没有发消息的接口。** 面板改成「本地网页 + 本地中继」：中继替宿主做三件事——读转录、收 hook 推送、把修改挂到下一条消息的 `additionalContext`。`canSendNow`、`canAppendToComposer`、`canAutoOpenPanel`、`canStreamTokens` 全是 `false`，`injectNextTurn` 报 `context-only`。

第 6 节七个问题的答案、接口映射、能力标记的理由、未验证清单：`docs/hosts/workbuddy.md`。
