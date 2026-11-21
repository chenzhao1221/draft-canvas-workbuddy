---
name: draft-fence
description: 写会反复修改的稿子时，用 draft_canvas_publish 把正文放进对话里的 Draft Canvas 面板。用户要写稿、改稿，或提到 Draft Canvas 时使用。
---

# Draft Canvas：面板就是草稿

这个对话里可以开一个 **Draft Canvas 面板**：稿子放在面板里，用户直接改，改动随下一条消息回到你这里。

## 写稿：调用工具，不要写代码块

**不要**在回复里贴 ` ```draft ` 代码块——面板本身就是那篇稿子。写完直接调：

```text
draft_canvas_publish(id="trip-note", title="游记", body="<整篇正文，Markdown，不带围栏>")
```

- `id` 用短标识（字母、数字、`.`、`_`、`-`），**每次改同一篇都用同一个 id**；换 id 等于开一篇新稿。
- `body` 永远是**全文**，不是片段，也不是 diff。
- 一次回复里同一篇只发布一次；发布完就在正文里说一句「放面板里了，你改完发回来」，不要再把稿子贴一遍。
- 面板还没打开时也可以发布——用户下一次看面板就能看到；如果用户要打开，调 `draft_canvas_open`。

## 用户改过了：`draft-changelog`

用户的消息末尾可能出现：

````text
```draft-changelog id="trip-note" from="2" to="3"
*** Begin Patch
<<<<<<< SEARCH
天气不错。
=======
天气很好。
>>>>>>> REPLACE
*** End Patch
```
````

它列出用户对第 `from` 版的改动：`SEARCH` 是那一版里的原文，`REPLACE` 是改成的样子。套用到那一版上；同一个 id 有多条时，后一条覆盖前一条。

## 用户框选了一段：`draft-rewrite`

````text
```draft-rewrite id="essay-main" rev="3" start_line="3" end_line="3" start_offset="4" end_offset="12"
我们今天出发
```

这句再口语一点。
````

只改被选中的那段。行号从 1 数，偏移按 Unicode 码位数、不含行尾。

## 一条消息里既有改动又有意见

按顺序来：先套 `draft-changelog`（多个同 id 的，以最后一条为准），再按每条 `draft-rewrite` 改选中的段落，其余部分保留用户的改动。`rev` 等于那条 changelog 的 `to` 时，坐标指的是**改完以后**的文字。

做完后**再调一次 `draft_canvas_publish`**，同一个 id，全文，让面板更新到下一版。

## 说一次

第一次在这个对话里发布草稿时，说一次：面板就在下面的卡片里，可以直接改，改完发回来我就接着改。面板可以拖下边缘调高度，也可以点「全屏」。

## 装这个技能

WorkBuddy 从 `~/.workbuddy/skills/<name>/SKILL.md` 读技能。`draft-canvas-wb mcp-install` 会把本文件装到那里。

没有这个技能，面板也能用（`draft_canvas_open` 一样会打开），只是模型不一定主动用发布工具——那就在对话里直接让它「用 Draft Canvas 发布这篇」。
