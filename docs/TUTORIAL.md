# Draft Canvas 使用教程（Kiro Crew 版）

适用版本：0.1.15，Kiro Crew 0.12.2 及以上。

## 一、安装

### 1. 打包

需要 Node.js 20。在仓库的 `app` 文件夹里运行（Windows 的 PowerShell 用 `npm.cmd`）：

```powershell
npm.cmd install
npm.cmd run package:crew
```

产物在 `app\dist\crew-app\`。

### 2. 装进 Crew

1. 打开 Crew 的应用页（Apps）。
2. 选「从本地路径安装」，选 `app\dist\crew-app` 文件夹。
3. 启用 Draft Canvas。

### 3. 批准权限（最容易漏）

在 Draft Canvas 的应用页里批准这三项：

| 权限 | 用来做什么 |
|---|---|
| `/api/chat/slots` | 读你的对话 |
| `/api/chat` | 帮你发消息 |
| `slots:user` | AI 回复后面板马上更新 |

以后每次 Update，如果加了新权限，都要再批一次。没批的话，面板顶部会提示。

### 4. 装技能

技能教 AI 怎么写 `draft` 块。新建这个文件：

`C:\Users\<你的用户名>\.kiro\crew\skills\draft-fence\SKILL.md`

内容是 `app\packages\hosts\kiro-crew\skill\draft-fence.md` 的全文（最后「Installing this skill」一节可以不要），并在最前面加：

```text
---
name: draft-fence
description: Write editable drafts for the Draft Canvas side panel. Use when the user wants prose they will refine, or mentions Draft Canvas; put the text in a draft fence with an id.
---
```

装好后**新开一个对话**，AI 才会用上。

### 5. 打开面板

在聊天右侧面板的 **+** 菜单里选 **Draft Canvas**。面板没法自己打开。

## 二、使用

### 1. 让 AI 写稿

跟 AI 说「用 draft 块写一份……」。稿子会出现在面板里，标题旁写着「第 1 版，共 1 版」。

面板上方的「对话」下拉框要选你正在用的那个对话。

### 2. 改稿

两种方式，可以一起用：

| 方式 | 怎么做 |
|---|---|
| 直接改 | 在编辑框里改字。状态标签变成琥珀色「有未发送的修改」 |
| 提意见 | 选中一段文字，在下面的框里写要怎么改，点「添加意见」。意见进入「待发的意见」列表，选区自动取消 |

意见可以加好几条，也可以选你自己改过的字。点意见右上角的 × 可以删掉。

### 3. 发给 AI

点底部的「发给 AI」。改动和所有意见合成一条消息，马上发出去。

AI 回复完，面板会自动换到新版，顶部提示「已更新到第 n 版」。一般几秒内就更新，最多 5 秒。

### 4. 看旧版、对比

| 按钮 | 作用 |
|---|---|
| ‹ › | 翻到以前的版本（只读） |
| 对比 | 两个版本左右对照 |
| 查看我的修改 | 你的改动和原版对照 |
| 审阅修改 | 逐块接受或拒绝 AI 的改动 |
| 放弃修改 | 丢掉还没发的改动（会先问你确认） |

### 5. 发出后又改了怎么办

如果你点了「发给 AI」之后又改了几处、还没发，AI 回新版时面板不会直接换，而是弹出审阅，让你逐块挑。这样你后改的字不会丢。

### 6. 外观

右上角可以调字号（12 到 24 px）、字体（等宽、宋体、黑体、楷体）、中英文。选择会记住。面板跟着 Crew 的浅色、深色主题自动切换。

## 三、升级

1. 重新打包（见第一节第 1 步）。
2. 在 Crew 应用页点 Draft Canvas 的 **Update**。
3. 有新权限就批准。
4. **关掉 Draft Canvas 标签，再从 + 菜单重新打开。** 不重开会继续用旧版。

## 四、遇到问题

| 现象 | 先这样做 |
|---|---|
| 显示「还没有草稿」或提示没权限 | 去应用页批准权限，再重开标签 |
| AI 回复后不更新 | 等 5 秒；还不行，看顶部有没有「新回复不会自动显示」的黄条，有就去批准事件权限 |
| 顶部红色「Failed to fetch」 | 一般是电脑刚睡醒或 Crew 卡了一下，下一次读成功会自己消失 |
| AI 不用 draft 块 | 检查技能装好没有，新开一个对话 |
| 其他怪问题 | 点右上角「诊断」→「复制」，把日志发给开发者 |

所有遇到过的问题和原因都记在 `docs/TROUBLESHOOTING.md`。

---

# WorkBuddy 版

同样的核心和面板，换了一套宿主的接法：面板是一个本地网页，靠一个小中继进程和 WorkBuddy 通信。为什么不能照搬 Crew 那套，见 `docs/hosts/workbuddy.md`。

## 一、准备

需要 Node.js 20。在 `app` 文件夹里：

```bash
npm.cmd install
npm.cmd run package:wb
```

产物在 `app\dist\workbuddy\`。

## 二、装 hook 和技能

```bash
node dist/workbuddy/bin/draft-canvas-wb.mjs install
```

它会做三件事，都可以撤：

| 动作 | 去处 |
|---|---|
| 注册四个 hook（`SessionStart`、`UserPromptSubmit`、`Stop`、`SessionEnd`） | `~/.workbuddy/settings.json`，改之前备份成 `draft-canvas-hook.mjs.settings-backup.json` |
| 装技能 | `~/.workbuddy/skills/draft-fence/SKILL.md` |
| 建草稿落盘目录 | `~/.workbuddy/draft-canvas/drafts/current/` |

**装完要重启 WorkBuddy 或新开一个对话**，hook 和技能都是启动时读的。

撤销：`node dist/workbuddy/bin/draft-canvas-wb.mjs uninstall`（只摘掉自己那几条 hook，技能留着）。

## 二点五、更推荐的做法：面板直接跑在客户端里

上面那套是个本地网页。想要「就在 WorkBuddy 里」，改用 MCP App 版：

```bash
node dist/workbuddy/bin/draft-canvas-wb.mjs mcp-install
```

然后重启 WorkBuddy，在连接器/插件页里**信任** `draft-canvas`，在对话里说「打开草稿面板」。面板会作为一张工具卡片出现在对话里，自动请求全屏；点「发给 AI」是真的发一条消息并让模型开始干活，不用你再说一句。

两套可以同时装：MCP App 版负责日常，本地网页版当中转或排查用（`simulate` 也只在本地网页版里有）。撤掉 MCP App：

```bash
node dist/workbuddy/bin/draft-canvas-wb.mjs mcp-uninstall
```

## 三、起面板

```bash
node dist/workbuddy/bin/draft-canvas-wb.mjs start
```

终端会打印面板地址，默认 `http://127.0.0.1:47831/`。把它和 WorkBuddy 的对话窗口并排放着，或者贴在 WorkBuddy 结果区的预览里。**这个窗口要一直开着**，它就是中继。

想先看看效果、不碰真会话：

```bash
node dist/workbuddy/bin/draft-canvas-wb.mjs simulate --open
```

## 四、用起来

和 Crew 版基本一样，只有三处差别：

| 地方 | Crew 版 | WorkBuddy 版 |
|---|---|---|
| 面板在哪 | 聊天侧边栏的 + 菜单 | 浏览器里的本地页面 |
| 新版本从哪来 | 聊天里的 `draft` 块 | 智能体把正文落到 `drafts/current/<id>.md`（技能要求的） |
| 「发给 AI」怎么送达 | 直接发消息 / 放进输入框 | 挂到下一条消息上：你正常发一句话，改动随这一轮进模型 |

所以点了「发给 AI」之后，**在对话里随便说一句**（「按上面的改动更新」就行），改动才会真正交给模型。面板顶部会显示「已排队」。

## 五、升级

1. 重新 `npm.cmd run package:wb`；
2. 重启 WorkBuddy（hook 脚本路径没变的话也可以不重启）；
3. 刷新面板页。草稿和版本在 `~/.workbuddy/draft-canvas/`，不在 `dist/`，升级不会丢。

## 六、遇到问题

| 现象 | 先这样做 |
|---|---|
| 面板「正在连接 / 已断开」 | 中继没跑；看终端打印的地址和端口 |
| 顶部黄色「新回复不会自动显示」 | hook 没装好或没重启：`draft-canvas-wb status` |
| 一直「等待草稿」 | `draft-canvas-wb status` 看会话在不在；`doctor` 看转录能不能读；看 `drafts/current/` 有没有文件 |
| 版本号不涨 | 落盘文件内容没变就不算新版本（按内容判重） |
| 其他怪问题 | 面板右上「诊断」→ 复制；中继终端里也有日志 |
