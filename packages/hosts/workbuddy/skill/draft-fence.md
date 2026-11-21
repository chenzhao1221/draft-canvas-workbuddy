---
name: draft-fence
description: 把要反复修改的稿子写进 draft 代码块，供 Draft Canvas 面板编辑。用户要写稿、改稿，或提到 Draft Canvas 时使用。
---

# Draft Canvas: draft 代码块

用户要一段会反复修改的文字时用它，或者用户提到 Draft Canvas 时用它。Draft Canvas 是一个面板，用户在面板里直接改你写的稿子，改动会随他们的下一条消息回到你这里。

## 什么时候该写 draft

写散文、文案、信件、章节、提纲这类要来回打磨的文字时用。短回答、解释、用户直接拿去运行的代码不要用。

## draft 的格式

把全文放进一个围栏块，第一行是 `draft`：

````text
```draft id="trip-note" title="游记" lang="markdown"
# 游记

我们今天出发。
```
````

- 开头**一定**写 `id="<短标识>"`，不要只写一个 `draft`。标识用字母、数字、`.`、`_`、`-`，**每次改同一篇都用同一个 `id`**。（忘了写，面板会把它归到 `draft-1`，但不要依赖这一点。）
- `title`、`lang` 可选，`lang` 默认 `markdown`。
- **每次写全文**，不写片段，不写 diff。
- 一次回复里同一篇只写一个 `draft` 块。同一个 `id` 写两遍，只有最后一遍算数。
- 改稿就是再写一个**同一个 `id`** 的 `draft` 块。换 `id` 等于开一篇新稿。
- `rev="..."` 可选，面板自己数版本号，不看这个值。

稿子里有以三个反引号开头的行时，外面用更长的围栏（四个或更多反引号），否则内层围栏会提前结束。

## 落盘：WorkBuddy 上必须做

WorkBuddy 不会把助手的回复写进会话转录，面板读不到聊天里的代码块。所以每写完一个 `draft` 块，都要把**同一份正文**再写一次文件（覆盖写，不要追加）：

`{{DRAFTS_DIR}}/<id>.md`

- 文件名就是 `id`，例如 `trip-note.md`；文件里是正文本身，**不要**带 ``` 围栏。
- 第一行可以写 `<!-- title: 游记 -->`，面板拿它当标题；不写就用正文第一个 `#` 标题。
- 改稿时覆盖同一个文件，面板自己记成下一版。
- 内容没变就不要写：一样的内容不会被当成新版本。
- 只写这一篇的正文，不要把聊天里的解释、前言也写进去。

## 用户改过稿：`draft-changelog`

用户的消息里可能出现这样的块：

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

它列出用户对 `from` 那一版的改动。每个 `SEARCH` 块是 `from` 版里的原文，`REPLACE` 是用户改成的样子。把块套用到那一版上。同一个 `id` 出现多个 changelog 时，后一条覆盖前一条。

除非用户另有要求，保留用户的改动。这次请求跟这篇稿子有关时，回一个同 `id` 的完整 `draft` 块。

## 用户框选了一段：`draft-rewrite`

消息里可能出现：

````text
```draft-rewrite id="essay-main" rev="3" start_line="3" end_line="3" start_offset="4" end_offset="12"
我们今天出发
```

这句再口语一点。
````

只按意见改被选中的那段，回一个同 `id` 的完整 `draft` 块。行号从 1 数，偏移按 Unicode 码位数、不含行尾，结束位置不含在内。

## 一条消息里既有改动又有意见

面板会把它们按顺序一起发来：

1. `draft-changelog`：用户自己改的字。
2. 一条或多条 `draft-rewrite`，每条后面跟着它的意见。

就按这个顺序做：先把 changelog 套到 `from` 版上。`rev` 等于那条 changelog 的 `to` 的 `draft-rewrite`，坐标指的是**改完以后**的文字。然后逐条按意见改被选中的段落，其余部分保留用户的改动。最后每个 `id` 回**一个**完整的 `draft` 块，把所有改动都带上。

## 跟用户说一次

在某个对话里第一次写 draft 时，说一次：打开 `draft-canvas-wb start` 打印的那个地址（默认 `http://127.0.0.1:47831/`）就能在面板里改稿。面板不会自己弹出来。

## 安装这个技能

WorkBuddy 从 `~/.workbuddy/skills/<name>/SKILL.md` 读技能（CodeBuddy Code 是 `~/.codebuddy/skills/`）。`draft-canvas-wb install` 会把本文件装到那里；也可以手动复制：

1. 建 `~/.workbuddy/skills/draft-fence/SKILL.md`；
2. 开头放 front matter（`name: draft-fence` 和一行 `description`），后面接本文件「安装这个技能」之前的内容；
3. **新开一个对话**，技能才会生效。已经开着的对话可能还在用开头的旧内容。

没有这个技能面板也能用，只是模型不一定主动用 draft 格式；也可以直接跟它说「用 Draft Canvas 的 draft 块写」并把上面的格式贴给它。详见 `docs/hosts/workbuddy.md`。
