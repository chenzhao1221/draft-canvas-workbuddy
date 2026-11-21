# Draft Canvas fence specification

- Interface version: `'1'`
- Audience: people who write skills or prompts for the model, people who read a Draft Canvas conversation, and engineers who write parsers.
- Normative source: [`ADAPTER_INTERFACE.md`](./ADAPTER_INTERFACE.md), sections 10 (fence grammar), 11 (changelog) and 12 (selection rewrite). This file restates those sections. If the two differ, `ADAPTER_INTERFACE.md` wins and this file is corrected.

Draft Canvas uses three Markdown fenced code blocks. They are ordinary CommonMark fences whose info string starts with a reserved word.

| Fence | Written by | Appears in | Becomes a version? |
|---|---|---|---|
| `draft` | the assistant | assistant messages | Yes, if closed and in an assistant message |
| `draft-changelog` | the plugin | end of a user message | Never |
| `draft-rewrite` | the plugin | a user message sent immediately | Never |

`draft` fences in user, system or tool messages are ignored. A pasted or quoted draft therefore never becomes a version.

Line endings are normalized to `\n` (LF) before anything is parsed.

## 1. Fence syntax (ADAPTER_INTERFACE section 10)

### 1.1 Lines

```text
fence-open  = indent ticks kind [ 1*WSP attrs ] *WSP          ; whole line
fence-close = indent ticks-close *WSP                         ; whole line
indent      = 0*3 " "
ticks       = 3*"`"                  ; its length L is the fence length
ticks-close = L*"`"                  ; at least L backticks
kind        = "draft" / "draft-changelog" / "draft-rewrite"   ; lowercase, followed by WSP or end of line
attrs       = attr *( 1*WSP attr )
attr        = key "=" value
key         = %x61-7A *( %x61-7A / DIGIT / "_" )               ; lowercase ASCII
value       = DQUOTE *( vchar / "\" DQUOTE / "\\" ) DQUOTE / 1*bare
vchar       = any character except DQUOTE, "\", backtick, line break
bare        = ALPHA / DIGIT / "." / "_" / "-"
WSP         = " " / %x09
```

Rules:

1. **Top level only.** The scanner tracks every fenced block in the message, including ordinary ones (` ```python `, `~~~`). A line that looks like a draft fence opener *inside* another fenced block is content, not a fence. Fences inside block quotes or list items, and lines indented by 4 or more spaces, are not recognized.
2. **Closing.** A fence closes at the first later line that is a `fence-close` with at least `L` backticks. Inner lines with fewer backticks (for example ` ``` ` inside a 4-backtick fence) are content.
3. **Body.** The lines strictly between the opening and closing lines, joined with `\n`. The newline before the closing line is not part of the body. If the opener had indent `k`, up to `k` leading spaces are removed from each body line.
4. **Unclosed.** If the message ends before a closing line, the fence is unclosed and runs to the end of the message. Unclosed fences are never committed.
5. **Attributes.** Values in double quotes may contain `\"` and `\\` escapes; no other escapes exist. Unknown keys are ignored. If a key repeats, the last one wins. Tokens that do not parse as `attr` are ignored. Values cannot contain backticks or line breaks; generators replace a backtick with `'` and a line break with a space.
6. **Kinds not recognized** (for example `draftx`, `Draft`) are ordinary fences.

### 1.2 Attributes per kind

| Kind | Attribute | Required | Rule |
|---|---|---|---|
| `draft-changelog`, `draft-rewrite` | `id` | yes | `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. A fence with a missing or invalid `id` is ignored (still tracked for nesting). |
| `draft` | `id` | no (strongly recommended) | Same pattern. If the `id` attribute is absent, the fence gets the auto id `draft-1` (see section 10.5). If `id` is present but empty, malformed or not matching the pattern, the fence is ignored (still tracked for nesting). |
| `draft` | `rev` | no | Free text, advisory only. Stored as `revHint`. |
| `draft` | `title` | no | Panel title. |
| `draft` | `lang` | no | `markdown` (default), `text`, or a code language name. |
| `draft-changelog` | `from` | yes | Decimal integer ≥ 1: plugin version number `n` of the base. |
| `draft-changelog` | `to` | yes | `from + 1`. Advisory. |
| `draft-rewrite` | `rev` | yes | Decimal integer ≥ 1: plugin version number `n` the coordinates refer to. In a message that also carries a `draft-changelog` for the same id, `rev` may equal that changelog's `to`: the coordinates then refer to the text after the changelog is applied (from 0.1.7). |
| `draft-rewrite` | `start_line`, `end_line`, `start_offset`, `end_offset` | yes | Decimal integers, see section 3. |

`rev` on a `draft` fence is the model's hint. `rev` on a `draft-rewrite` fence and `from`/`to` on a `draft-changelog` fence are plugin version numbers.

### 1.3 Fence length (escaping)

There is no character escaping inside bodies. Instead the generator picks a fence long enough that no body line can close it:

```text
L = max(3, 1 + longest run of backticks that starts a body line after 0–3 spaces)
```

A body containing ` ``` ` code blocks is wrapped in 4 backticks, a body containing ` ```` ` in 5, and so on. The closing line uses exactly `L` backticks. Parsers accept any `L ≥ 3`.

Example: a draft that contains a code block.

`````text
````draft id="setup-guide" title="Setup" lang="markdown"
Install the tool:

```sh
npm install example
```

Then restart.
````
`````

### 1.4 `draft` fences and the last-fence rule

````text
```draft id="essay-main" rev="3" title="Opening" lang="markdown"
Full draft text…
```
````

- The **same id** in a later assistant message is a **new version** of the same draft, not a new draft.
- If **one assistant message** contains several closed `draft` fences with the same id, only the **last** one counts. Earlier ones in that message are ignored.
- Different ids in one message are different drafts; each gets its own version.
- **Id-less fences.** A closed `draft` fence with no `id` attribute (info string exactly `draft`, or only `title`/`lang`/`rev`) is not ignored. It gets the fixed auto id `draft-1`. Every id-less fence of a session is a new version of `draft-1`, so they number 1, 2, 3 in conversation order, and the last id-less fence of one message wins. The auto id depends only on the text (no clock, no randomness), so every rebuild of the same history gives the same result. An explicit `id` is a separate chain, except that an explicit `id="draft-1"` shares the chain of the auto id. A present but invalid `id` (for example `id="bad id!"`, `id=""` or an unterminated quote) is still ignored. Models should always write an explicit `id`; the auto id only keeps a draft from being lost.
- The model must always write the **full** draft, never a fragment, in a `draft` fence.
- The plugin number `n` of a version is the count of committed appearances of the id in the session (1, 2, 3, …). The model's `rev` attribute is never used for numbering.

## 2. Changelog (`draft-changelog`, ADAPTER_INTERFACE section 11)

### 2.1 Structure

````text
```draft-changelog id="<id>" from="<n>" to="<n+1>"
*** Begin Patch
<<<<<<< SEARCH
<base lines>
=======
<replacement lines>
>>>>>>> REPLACE
<more blocks, directly following>
*** End Patch
```
````

The body is exactly: the line `*** Begin Patch`, one or more blocks, the line `*** End Patch`. Each block is the line `<<<<<<< SEARCH`, zero or more SEARCH lines, the line `=======`, zero or more REPLACE lines, the line `>>>>>>> REPLACE`. Marker lines match exactly (no leading or trailing spaces). This is the Aider SEARCH/REPLACE marker style. It is not a unified diff.

### 2.2 Rules

1. **Line model.** Documents are split on `\n`. SEARCH and REPLACE are whole lines. A block with zero REPLACE lines deletes the SEARCH lines. A REPLACE section with one empty line inserts one empty line. In the `SearchReplaceBlock` strings of ADAPTER_INTERFACE section 4.2 the empty string means zero lines, so the builder never emits a block whose SEARCH or REPLACE is a single empty line unless that block covers the whole base; it adds context lines instead.
2. **Base.** All SEARCH text refers to version `from`, the latest committed version at the time the changelog was built.
3. **Unique match.** Each SEARCH line sequence MUST occur exactly once in the base as a contiguous run of lines. The builder adds context lines (one before, then one after, alternating; the other side when one side runs out) until it is unique. The whole base document is always unique, so this terminates.
4. **Non-empty SEARCH.** SEARCH has at least one line, except when the base body is empty; then a single block with empty SEARCH sets the whole text. Pure insertions include at least one neighbouring base line (the line before, or the line after when inserting at the top).
5. **No overlap.** Blocks are ordered by position in the base and their matched ranges do not overlap; blocks whose ranges would overlap are merged.
6. **Apply.** All blocks are located in the **base**, not in the partly edited text, then replaced. Applying the changelog to the base MUST yield the working copy exactly. The builder verifies this and, if it fails, emits a single block whose SEARCH is the whole base.
7. **Cumulative.** A changelog always describes the full difference between version `from` and the current working copy. If a message (or a later message) contains another changelog for the same id with the same `from`, the **last one supersedes** earlier ones.
8. **One fence per edited draft.** Several fences (different ids) may follow each other, separated by one blank line. No fence is produced for a draft without uncommitted edits.
9. **Marker conflict.** If a SEARCH or REPLACE line would be exactly equal to a marker line (`<<<<<<< SEARCH`, `=======`, `>>>>>>> REPLACE`, `*** Begin Patch`, `*** End Patch`), the changelog cannot be expressed. The builder refuses with a marker-conflict error and the panel asks the user to change that line (for example a 7-character `=======` Setext underline can be written with 8 `=` or as an ATX `#` heading).
10. **Fence length** follows section 1.3 over the whole body.

### 2.3 Example: a change and an insertion

Version 2 of `trip-note` (lines numbered for reference only):

```text
1  # Trip note
2
3  We leave today.
4  The weather is fine.
5  See you there.
```

Working copy: line 4 becomes `The weather is perfect.`, and `Bring a hat.` is added after line 5. Changelog appended to the next user message:

````text
```draft-changelog id="trip-note" from="2" to="3"
*** Begin Patch
<<<<<<< SEARCH
The weather is fine.
=======
The weather is perfect.
>>>>>>> REPLACE
<<<<<<< SEARCH
See you there.
=======
See you there.
Bring a hat.
>>>>>>> REPLACE
*** End Patch
```
````

### 2.4 Example: widening for uniqueness

Version 1 of `packing`:

```text
1  ## Day one
2  Bring water.
3  ## Day two
4  Bring water.
5  Leave early.
```

The user changes line 4 to `Bring water and snacks.`. `Bring water.` occurs twice, so one line of context before is added:

````text
```draft-changelog id="packing" from="1" to="2"
*** Begin Patch
<<<<<<< SEARCH
## Day two
Bring water.
=======
## Day two
Bring water and snacks.
>>>>>>> REPLACE
*** End Patch
```
````

### 2.5 Example: code content, deletion, two drafts in one message

Version 4 of `setup-guide` has this body:

`````text
1  Install the tool:
2
3  ```sh
4  npm install example
5  ```
6
7  Then restart.
`````

The user changes line 3 to ` ```bash ` and deletes lines 6–7. Version 2 of `trip-note` (section 2.3) is also edited. The injected text is:

`````text
````draft-changelog id="setup-guide" from="4" to="5"
*** Begin Patch
<<<<<<< SEARCH
```sh
=======
```bash
>>>>>>> REPLACE
<<<<<<< SEARCH

Then restart.
=======
>>>>>>> REPLACE
*** End Patch
````

```draft-changelog id="trip-note" from="2" to="3"
*** Begin Patch
<<<<<<< SEARCH
We leave today.
=======
We leave tomorrow.
>>>>>>> REPLACE
*** End Patch
```
`````

The first fence uses 4 backticks because its body contains lines starting with ` ``` `. Its second block has two SEARCH lines (an empty line and `Then restart.`) and zero REPLACE lines, so both lines are deleted. The empty line alone would not be unique (line 2 is also empty), but the two-line sequence is.

## 3. Selection rewrite (`draft-rewrite`, ADAPTER_INTERFACE section 12)

### 3.1 Coordinates

- The selection is a half-open range from (`start_line`, `start_offset`) to (`end_line`, `end_offset`) in the full text of version `rev`.
- Lines are **1-based**. `end_line ≥ start_line`.
- Offsets count **Unicode code points** (not UTF-16 code units, not bytes, not grapheme clusters) from the start of their line. `start_offset` is inclusive; `end_offset` is exclusive. `0 ≤ offset ≤ code-point length of the line`.
- If `start_line = end_line` then `end_offset > start_offset`. Empty selections are not sent.
- In JavaScript, count code points with `Array.from(line).length`, or `for…of`. Convert editor positions (usually UTF-16) at the boundary.
- The fence body is exactly the selected text, with `\n` between lines. The whole document is sent only when the selection is the whole document.
- The coordinates refer to the committed version `rev`. If the user has uncommitted edits, the plugin maps the selection back to `rev` when it lies entirely in text unchanged since `rev`; otherwise the panel asks the user to send or discard the edits first.

### 3.2 Message layout

The message sent immediately is the fence, one blank line, then the user's instruction:

````text
```draft-rewrite id="<id>" rev="<n>" start_line="<a>" end_line="<b>" start_offset="<x>" end_offset="<y>"
<selected text>
```

<instruction>
````

Fence length follows section 1.3. The assistant is expected to answer with a full `draft` fence for the same id, which becomes version `n + 1` (or later).

### 3.3 Example

Version 3 of `essay-main`:

```text
1  # 开场白
2
3  我们今天出发 🚀 去海边。
4  天气很好。
```

Line 3 has 13 code points: `我0 们1 今2 天3 出4 发5 ␠6 🚀7 ␠8 去9 海10 边11 。12`. The user selects `出发 🚀 去海边` and asks for a more colloquial wording:

````text
```draft-rewrite id="essay-main" rev="3" start_line="3" end_line="3" start_offset="4" end_offset="12"
出发 🚀 去海边
```

请把这段改得更口语，保留原意。
````

In UTF-16 the end would be 13, because 🚀 (U+1F680) takes two code units. Sending 13 is wrong.

A selection from `去` on line 3 to after `天气` on line 4 is `start_line="3" start_offset="9" end_line="4" end_offset="2"` with body:

```text
去海边。
天气
```
