# Draft Canvas host adapter interface

- Interface version: **`'1'`**
- Status: normative for Draft Canvas v1
- Licence of this document and the code it describes: Apache-2.0
- Source of the types: `packages/core/src/adapter/` (this document and those files must agree; if they differ, treat this document as the intended behaviour and update the TypeScript types in the same change)

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used as in RFC 2119.

## 1. Purpose and audience

Draft Canvas is a plugin for local agent chats. The assistant writes a draft inside a fenced block (` ```draft id="..." `). The plugin extracts it into a side panel where the user edits it. The user's edits travel with the user's next message as a `draft-changelog` fence. The user can also select a passage and immediately send a `draft-rewrite` request for that passage only.

The plugin is split into:

- **core** (`packages/core`): host-agnostic TypeScript. It parses and generates fences, keeps version chains, builds changelogs, computes selection coordinates and rebuilds state from history. It never touches a DOM, the network, or a host SDK.
- **ui** (`packages/ui`): a React + CodeMirror 6 panel that depends only on core and on a `HostAdapter` object.
- **host adapters**: one per chat host. An adapter reads the transcript, reports events, injects text into the next user turn, sends a message now, and optionally stores working copies.

This document is for engineers who write a new host adapter (for example OpenCode, DeepSeek Harness, CodeBuddy Code / WorkBuddy) without access to the original authors. It is complete on its own. The Kiro Crew adapter (`packages/hosts/kiro-crew`) is the reference implementation (section 16).

## 2. Principles

1. **The conversation is the source of truth.** A committed draft version exists only if a complete `draft` fence for that id appears in an **assistant** message of the session. Every committed version MUST be rebuildable from the persisted session history.
2. **The working copy is disposable.** Uncommitted edits live in local storage, best-effort. Losing them never loses a committed version.
3. **Core is host-agnostic.** Adapters translate host specifics into the types below. Adapters MUST NOT parse fences themselves for version purposes; core does that.
4. **Honest fidelity.** If injected text reaches only hidden model context and not the persisted user message, the adapter MUST say so (`TranscriptFidelity = 'context-only'`).
5. **No generation in the plugin.** The host's agent writes all drafts. The plugin never calls a model.

## 3. Versioning and stability

- `HostInfo.interfaceVersion` is the string `'1'` for every adapter written against this document.
- Within major version `'1'`, changes are **additive only**: new optional fields, new optional methods, new `HostEvent` variants, new error codes. Existing fields keep their meaning.
- Consumers (core, ui) MUST ignore unknown `HostEvent` types and unknown fields.
- Adapters MUST NOT emit fields or event types that are not in this document unless they are prefixed with `x_` (for example `x_rawFrame`). Core ignores them.
- A breaking change bumps the major version (`'2'`). Core refuses adapters whose `interfaceVersion` it does not support and shows an error in the panel.

## 4. TypeScript contract

All types below are exported from `packages/core` (`import { ... } from '@draft-canvas/core'`). Field comments are normative.

### 4.1 Host-side types

```ts
export const INTERFACE_VERSION = '1' as const;

/** Where injected next-turn text ends up. */
export type TranscriptFidelity =
  | 'persisted'      // text becomes part of the stored user message; visible after reload
  | 'context-only';  // text reaches the model for that turn only; absent from stored history

/** Whether getHistory returned everything the session ever contained. */
export type HistoryCompleteness =
  | 'full'     // all persisted messages of the session, from the first one
  | 'window';  // a compacted or truncated window; older messages may be missing

export interface HostCapabilities {
  /** getHistory can return the full persisted history (completeness 'full'). */
  canReadFullHistory: boolean;
  /** assistant_chunk events are emitted while the assistant is streaming. */
  canStreamTokens: boolean;
  /** sendNow can post a user message immediately. */
  canSendNow: boolean;
  /** injectNextTurn lands in the stored user message (fidelity 'persisted'). */
  canRewritePersistedUserMessage: boolean;
  /** injectNextTurn appends to the user's unsent composer text, which the user then sends. */
  canAppendToComposer: boolean;
  /** The adapter can open/focus the Draft Canvas panel programmatically. */
  canAutoOpenPanel: boolean;
  /** adapter.storage is provided. */
  hasHostStorage: boolean;
  /** Upper bound in UTF-8 bytes for injectNextTurn text, if the host imposes one. */
  maxInjectBytes?: number;
  /** Upper bound in UTF-8 bytes for sendNow text, if the host imposes one. */
  maxSendBytes?: number;
}

export interface HostInfo {
  /** Stable lowercase slug, e.g. 'kiro-crew', 'opencode'. */
  id: string;
  /** Human-readable host name, e.g. 'Kiro Crew'. */
  displayName: string;
  /** Detected host version if known, e.g. '0.12.2'. */
  hostVersion?: string;
  /** SemVer of the adapter package. */
  adapterVersion: string;
  /** Always '1' for this document. */
  interfaceVersion: '1';
}

export interface SessionRef {
  /** Host session identifier, opaque to core. Stable across reloads. */
  sessionId: string;
  title?: string;
}

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface Message {
  /** Stable across reloads. If the host has no ids, derive a deterministic one (section 9.3). */
  id: string;
  sessionId: string;
  role: MessageRole;
  /** Full plain text / Markdown exactly as persisted (tool payloads excluded). */
  text: string;
  /** ISO 8601 timestamp. Use the host's timestamp; if absent, the time first seen. */
  createdAt: string;
  /** false only for an assistant message that is still streaming. */
  complete: boolean;
}

export type HostEvent =
  | { type: 'session_changed'; session: SessionRef | null }
  | { type: 'assistant_chunk'; sessionId: string; messageId: string; delta: string }
  | { type: 'assistant_done'; sessionId: string; message: Message }
  | { type: 'user_message'; sessionId: string; message: Message }
  | { type: 'history_reset'; sessionId: string }
  | { type: 'connection'; state: 'connected' | 'reconnecting' | 'disconnected' };

export interface InjectResult {
  /** Resolution means success; failures reject with HostAdapterError. */
  ok: true;
  /** Where the text will end up once the user sends. */
  fidelity: TranscriptFidelity;
  /**
   * true when the text now sits in unsent composer text and only reaches the
   * conversation if the user sends it (Crew primary path). false when the host
   * attaches it to the next turn by itself (e.g. a prompt hook).
   */
  requiresUserSend: boolean;
  /** Optional human-readable note shown in the panel. */
  detail?: string;
}

export interface SendResult {
  ok: true;
  /** Id of the created user message, if the host returns it. */
  messageId?: string;
  detail?: string;
}

export interface WorkingCopyStorage {
  load(sessionId: string, draftId: string): Promise<WorkingCopy | null>;
  save(copy: WorkingCopy): Promise<void>;
  remove(sessionId: string, draftId: string): Promise<void>;
  /** Optional: all working copies of a session (used on rebuild). */
  list?(sessionId: string): Promise<WorkingCopy[]>;
}

export interface HostAdapter {
  readonly info: HostInfo;
  readonly capabilities: HostCapabilities;

  /** Establish host connections. Idempotent. Must resolve before other calls. */
  connect(): Promise<void>;
  /** Release everything. After dispose, every method rejects with 'not_connected'. Idempotent. */
  dispose(): Promise<void>;

  /** The session the panel is attached to, or null if none is active. */
  getActiveSession(): Promise<SessionRef | null>;
  /** Optional: sessions the user can pick from. */
  listSessions?(): Promise<SessionRef[]>;

  /** Persisted history in conversation order (oldest first). */
  getHistory(sessionId: string): Promise<{ messages: Message[]; completeness: HistoryCompleteness }>;

  /** Register a listener. Returns an unsubscribe function. */
  subscribe(listener: (event: HostEvent) => void): () => void;

  /** Attach text (one or more draft-changelog fences) to the user's next turn. */
  injectNextTurn(sessionId: string, text: string): Promise<InjectResult>;

  /** Send text (a draft-rewrite message) as a user message now. */
  sendNow(sessionId: string, text: string): Promise<SendResult>;

  /** Optional: open or focus the panel. Present only if capabilities.canAutoOpenPanel. */
  openPanel?(): Promise<void>;

  /** Optional working-copy storage. Present only if capabilities.hasHostStorage. */
  readonly storage?: WorkingCopyStorage;
}

export type HostAdapterErrorCode =
  | 'not_connected'      // connect() not called, failed, or dispose() was called
  | 'session_not_found'  // unknown or deleted sessionId
  | 'permission_denied'  // host refused (scope, allowlist, user denial)
  | 'rate_limited'       // host throttled; see retryAfterMs
  | 'payload_too_large'  // text exceeds maxInjectBytes / maxSendBytes or a host cap
  | 'unsupported'        // capability is false or method not implemented
  | 'host_error';        // anything else; put the host's message in `message`

export class HostAdapterError extends Error {
  readonly name = 'HostAdapterError';
  constructor(
    readonly code: HostAdapterErrorCode,
    message: string,
    readonly options: { retryable?: boolean; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message);
  }
}
```

### 4.2 Core data types

Adapters do not create these; they appear in this document because they define the wire formats and the storage records an adapter may persist.

```ts
export type FenceKind = 'draft' | 'draft-changelog' | 'draft-rewrite';

/** A parsed `draft` fence. */
export interface DraftFence {
  id: string;
  /** The model's advisory rev attribute, verbatim. Never used for numbering. */
  rev?: string;
  title?: string;
  /** Defaults to 'markdown'. */
  lang: string;
  /** Text between the opening and closing fence lines, LF-normalized, no trailing newline. */
  body: string;
  /** false if the message ended before a closing fence. Never committed. */
  closed: boolean;
  /** 0-based index of this fence among recognized draft fences of the message. */
  fenceIndex: number;
  /** Number of backticks in the opening fence (>= 3). */
  fenceLength: number;
}

/** A committed version. */
export interface DraftVersion {
  draftId: string;
  /** 1-based plugin version number: count of committed appearances of draftId in the session. */
  n: number;
  sourceMessageId: string;
  fenceIndex: number;
  revHint?: string;
  title?: string;
  lang: string;
  body: string;
  /** createdAt of the source message. */
  createdAt: string;
}

/** Uncommitted local edits against a committed version. */
export interface WorkingCopy {
  sessionId: string;
  draftId: string;
  /** n of the committed version the edits are based on. */
  baseVersion: number;
  /** hashText(body of the base version); detects a base that changed after rebuild. */
  baseHash: string;
  /** Full current text of the working copy. */
  text: string;
  /** ISO 8601. */
  updatedAt: string;
  /** hashText(canonical changelog fence) last appended to the composer, if any. */
  stagedHash?: string;
  /** hashText(canonical changelog fence) last seen in a sent user message, if any. */
  sentHash?: string;
}

export interface SearchReplaceBlock {
  /** Lines of the base version (joined with '\n'). Empty only if the base body is empty. */
  search: string;
  /** Replacement lines (joined with '\n'). May be empty (deletion). */
  replace: string;
}

/** A `draft-changelog` fence. */
export interface ChangelogFence {
  id: string;
  /** n of the base version. */
  from: number;
  /** from + 1: the version number the next draft fence for id will receive. Advisory. */
  to: number;
  blocks: SearchReplaceBlock[];
}

/** A `draft-rewrite` request. */
export interface RewriteRequest {
  id: string;
  /** n of the version the coordinates refer to. */
  rev: number;
  startLine: number;   // 1-based
  endLine: number;     // 1-based, >= startLine
  startOffset: number; // code points from the start of startLine, inclusive
  endOffset: number;   // code points from the start of endLine, exclusive
  /** Exact selected text of version rev. */
  selection: string;
  /** The user's instruction, non-empty, written after the fence. */
  instruction: string;
}

/** Core helper used for stagedHash / sentHash / baseHash: 32-bit FNV-1a over UTF-8, 8 lowercase hex digits. */
export declare function hashText(text: string): string;
```

## 5. Lifecycle

Core's `DraftSessionController` drives the adapter in this order. Adapters MUST support it.

1. **Construct.** The host creates the adapter. The constructor MUST NOT perform I/O.
2. **`connect()`.** Open host connections, detect `hostVersion`, resolve once ready. Calling it twice is a no-op. On failure reject with `HostAdapterError` (`host_error` or `permission_denied`).
3. **Subscribe.** Core calls `subscribe(listener)` once per controller, right after `connect()` resolves. Core buffers events until step 5 finishes, so no event is lost between the history fetch and live updates.
4. **Attach session.** Core calls `getActiveSession()`. If it returns `null`, the panel shows "No active chat" and, if `listSessions` exists, a picker.
5. **History rebuild.** Core calls `getHistory(sessionId)` and rebuilds all versions (section 13). It loads working copies from `storage` (or its in-memory fallback). Then it applies buffered events; events for messages already in the fetched history are deduplicated by message id.
6. **Run.** Core reacts to events and, when the user clicks "Send to the agent", sends the edits (changelogs) and comments (rewrite requests) in one message with `sendNow`, or puts them in the composer with `injectNextTurn` when the host cannot send.
7. **Session switch.** When the panel's chat changes, the adapter emits `session_changed`. Core drops in-memory state for the old session (working copies stay in storage) and repeats steps 4–5; the subscription stays.
8. **Reconnect.** When the host connection drops, emit `connection: reconnecting` (or `disconnected` if the adapter gives up). After it recovers, emit `connection: connected`. Core then re-fetches history and rebuilds. Adapters SHOULD retry with backoff; they MUST NOT replay old events as new ones after reconnecting.
9. **`dispose()`.** Unsubscribe from the host, cancel timers, release sockets. All listeners are dropped. Idempotent.

Threading: everything runs on one JavaScript event loop. Listeners are called synchronously by the adapter in event order; a listener that throws MUST NOT break delivery to other listeners (catch and log). Adapters MUST NOT call listeners re-entrantly from inside a core call such as `injectNextTurn`; queue the event with `queueMicrotask` instead.

## 6. Events and ordering

| Event | When to emit | Required data |
|---|---|---|
| `session_changed` | The chat the panel is attached to changes, or becomes none. | New `SessionRef` or `null`. |
| `assistant_chunk` | Each streamed piece of assistant text. Only if `canStreamTokens`. | `messageId` stable for the whole message; `delta` is the **new text only** (append-only). |
| `assistant_done` | The assistant message is final. Exactly once per assistant message. | Full `Message` with `complete: true`; `text` MUST equal what `getHistory` returns for it. |
| `user_message` | A user message is persisted (typed by the user or sent by `sendNow`). | Full `Message` as persisted, including any injected changelog if fidelity is `persisted`. |
| `history_reset` | History changed in a way not expressed by the events above: compaction, edit, deletion, branch, undo, reload. | `sessionId`. Core re-fetches and rebuilds. |
| `connection` | Connection state changes. | `state`. |

Ordering guarantees, per session:

- For one assistant message: zero or more `assistant_chunk`, then exactly one `assistant_done`. Concatenating all `delta` values SHOULD equal `message.text`; if it does not, core trusts `message.text`.
- `assistant_done` for message M comes after every `assistant_chunk` for M.
- Events for different messages arrive in conversation order. A `user_message` is emitted before the `assistant_chunk` of the reply to it, when the host makes that observable.
- If a stream is abandoned (cancel, crash, disconnect) and no final message exists, emit `history_reset` once the host knows the outcome. Core then discards the preview.
- A message id seen in `assistant_done` again (duplicate frame) is harmless: core ignores identical text and rebuilds if the text differs.
- Emit only events for messages of the attached session, plus `session_changed` and `connection`.

Core never commits a version from `assistant_chunk`. Chunks drive only the read-only streaming preview.

## 7. Capability flags and degradation

| Flag | `true` means | When `false`, core and UI do this |
|---|---|---|
| `canReadFullHistory` | `getHistory` can return `completeness: 'full'`. | The panel shows "Older versions may be missing" when history is a window. Version numbers count only what is visible. |
| `canStreamTokens` | `assistant_chunk` is emitted. | No streaming preview; drafts appear at `assistant_done`. |
| `canSendNow` | `sendNow` posts a message immediately. | The rewrite action falls back to `injectNextTurn` with the rewrite message and tells the user to send it. If both are impossible the action is hidden. |
| `canRewritePersistedUserMessage` | `injectNextTurn` text ends up in the stored user message. | Fidelity is `context-only`; a warning banner says that changelogs may not be visible in history after reload. The panel decides the exact wording; an adapter that reports `context-only` only because persistence is unverified should expect a hedged message. |
| `canAppendToComposer` | `injectNextTurn` appends to the unsent composer. | Expected for prompt-hook hosts. `requiresUserSend` is false; the panel keeps changes "pending" until the next `user_message`. |
| `canAutoOpenPanel` | `openPanel()` exists and works. | The panel can never pop itself open. Instructions tell the user how to open it manually (Crew: chat side-panel + menu). |
| `hasHostStorage` | `adapter.storage` exists. | Core keeps working copies in memory only; they are lost when the panel unmounts. The panel says so. |
| `maxInjectBytes` / `maxSendBytes` | Host size caps. | Core checks UTF-8 size before calling and shows "Too large to send" instead of calling; adapters still enforce the cap and reject with `payload_too_large`. |

Adapters MUST report capabilities truthfully and MUST keep them constant after `connect()` resolves. A method whose capability is `false` MUST reject with `unsupported`.

## 8. Next-turn injection and TranscriptFidelity

`injectNextTurn(sessionId, text)` receives one or more complete `draft-changelog` fences joined by one blank line, with no leading or trailing whitespace. The adapter is responsible for separating it from existing user text by exactly one blank line (`\n\n`), and MUST NOT modify the fence text otherwise.

The returned `fidelity` MUST describe what actually happens:

- `'persisted'`: after the user sends, the stored user message contains the fence text verbatim (line endings may be normalized). Examples: appending to the unsent composer; a prompt hook that rewrites the user text before persistence.
- `'context-only'`: the model receives the text for that turn, but stored history does not contain it. Examples: a hook whose stdout is added to model context; system-prompt injection.

When unsure, report `'context-only'`. Over-reporting `'persisted'` breaks the source-of-truth principle.

### 8.1 Reload test (required before declaring `'persisted'`)

Run this by hand or headless against a real host, in a throwaway session:

1. Have the assistant produce a `draft` fence (id `fidelity-test`).
2. In the panel, edit one line and click "Send to the agent" (on a composer-only host, then send the message yourself).
3. Confirm the assistant's reply refers to the edit (the model saw it).
4. Fully reload: close and reopen the session, or restart the host process you started (by PID only).
5. Call `getHistory(sessionId)`. The user message from step 2 MUST contain the `draft-changelog` fence verbatim.
6. If the host compacts context, force or wait for compaction and repeat step 5 with the adapter's full-history source.

Result: step 5 passes → `'persisted'`. Step 3 passes but step 5 fails → `'context-only'`. Step 3 fails → injection does not work; do not ship the path. Record the outcome, host version and date in the adapter's README.

### 8.2 Sent detection

When core receives a `user_message`, it parses the `draft-changelog` fences in it (they never become versions). For each draft id it takes the last such fence, regenerates its canonical text, and stores `hashText(...)` as the working copy's `sentHash` if `from` equals the working copy's `baseVersion`. If the current working-copy changelog hashes to `sentHash`, the working copy is "sent, waiting for a new version". On a `'context-only'` path the fence is not in the stored user message. The adapter MUST NOT add it to `Message.text`. Instead, core treats the injected changes as sent when the next `user_message` of that session arrives after a successful `injectNextTurn` that returned `requiresUserSend: false`. An adapter that returns `'context-only'` together with `requiresUserSend: true` only because persistence is unverified (Kiro Crew until section 8.1 passes) gets sent detection only if the fence really appears in the stored user message; otherwise the draft stays in the "In your message" state.

## 9. History, completeness and compaction

### 9.1 `getHistory`

- Return every message of the session the host persisted, oldest first, including user, assistant, system and tool messages (core ignores the last two). Tool call payloads are not part of `text`.
- Prefer the host's full persisted log over the model's current context window. Return `completeness: 'full'` only if the result starts at the first message of the session.
- An assistant message still being generated MAY be included with `complete: false`; core skips it during rebuild.
- `sessionId` unknown → reject with `session_not_found`.

### 9.2 Compaction

If a host compacts or truncates its history and no full log is reachable, return the window with `completeness: 'window'`. If compaction happens while attached, emit `history_reset`.

### 9.3 Message ids

`Message.id` MUST be stable across reloads, because core keys versions by `sourceMessageId`. If the host has no ids, derive one deterministically, for example `${sessionId}:${index}` where `index` is the 0-based position in the full persisted log. Never use random ids.

### 9.4 Text normalization

Adapters SHOULD return text as persisted. Core normalizes `\r\n` and lone `\r` to `\n` before parsing. Adapters MUST NOT strip, re-render or reflow Markdown, and MUST NOT remove fenced blocks.

## 10. Draft fence grammar

All three fences are Markdown fenced code blocks whose info string starts with a reserved kind. The grammar follows CommonMark fenced code blocks, restricted to top-level backtick fences.

### 10.1 Lines

Core first normalizes line endings to `\n` and splits the message into lines.

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
4. **Unclosed.** If the message ends before a closing line, the fence is unclosed (`closed: false`) and runs to the end of the message. Unclosed fences are never committed.
5. **Attributes.** Values in double quotes may contain `\"` and `\\` escapes; no other escapes exist. Unknown keys are ignored. If a key repeats, the last one wins. Tokens that do not parse as `attr` are ignored. Values cannot contain backticks or line breaks; generators replace a backtick with `'` and a line break with a space.
6. **Kinds not recognized** (for example `draftx`, `Draft`) are ordinary fences.

### 10.2 Attributes per kind

| Kind | Attribute | Required | Rule |
|---|---|---|---|
| `draft-changelog`, `draft-rewrite` | `id` | yes | `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. A fence with a missing or invalid `id` is ignored (still tracked for nesting). |
| `draft` | `id` | no (strongly recommended) | Same pattern. If the `id` attribute is absent, the fence gets the auto id `draft-1` (see section 10.5). If `id` is present but empty, malformed or not matching the pattern, the fence is ignored (still tracked for nesting). |
| `draft` | `rev` | no | Free text, advisory only. Stored as `revHint`. |
| `draft` | `title` | no | Panel title. |
| `draft` | `lang` | no | `markdown` (default), `text`, or a code language name. |
| `draft-changelog` | `from` | yes | Decimal integer ≥ 1: plugin version number `n` of the base. |
| `draft-changelog` | `to` | yes | `from + 1`. Advisory. |
| `draft-rewrite` | `rev` | yes | Decimal integer ≥ 1: plugin version number `n` the coordinates refer to. |
| `draft-rewrite` | `start_line`, `end_line`, `start_offset`, `end_offset` | yes | Decimal integers, section 12. |

Note that `rev` on a `draft` fence is the model's hint, while `rev` on a `draft-rewrite` fence and `from`/`to` on a `draft-changelog` fence are plugin version numbers.

### 10.3 Who writes which fence, and where it is parsed

| Fence | Written by | Appears in | Becomes a version? |
|---|---|---|---|
| `draft` | assistant | assistant messages | Yes, if closed and in an assistant message |
| `draft-changelog` | plugin | end of a user message (or hidden context) | Never |
| `draft-rewrite` | plugin | a user message sent now | Never |

`draft` fences in user, system or tool messages are ignored. This prevents pasted or quoted drafts from becoming versions.

### 10.4 Fence length (escaping)

There is no character escaping inside bodies. Instead the generator picks a fence long enough that no body line can close it:

```text
L = max(3, 1 + longest run of backticks that starts a body line after 0–3 spaces)
```

So a body containing ` ``` ` code blocks is wrapped in 4 backticks, a body containing ` ```` ` in 5, and so on. The closing line uses exactly `L` backticks. Parsers accept any `L ≥ 3`. The skill shipped to the model teaches the same rule.

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

### 10.5 `draft` examples and the last-fence rule

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

## 11. Changelog format (`draft-changelog`)

### 11.1 Structure

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

### 11.2 Rules

1. **Line model.** Documents are split on `\n`. SEARCH and REPLACE are whole lines. A block with zero REPLACE lines deletes the SEARCH lines. A REPLACE section with one empty line inserts one empty line. In the `SearchReplaceBlock` strings of section 4.2 the empty string means zero lines, so the builder never emits a block whose SEARCH or REPLACE is a single empty line unless that block covers the whole base; it adds context lines instead.
2. **Base.** All SEARCH text refers to version `from`, the latest committed version at the time the changelog was built.
3. **Unique match.** Each SEARCH line sequence MUST occur exactly once in the base as a contiguous run of lines. The builder adds context lines (one before, then one after, alternating; the other side when one side runs out) until it is unique. The whole base document is always unique, so this terminates.
4. **Non-empty SEARCH.** SEARCH has at least one line, except when the base body is empty; then a single block with empty SEARCH sets the whole text. Pure insertions include at least one neighbouring base line (the line before, or the line after when inserting at the top).
5. **No overlap.** Blocks are ordered by position in the base and their matched ranges do not overlap; blocks whose ranges would overlap are merged.
6. **Apply.** All blocks are located in the **base**, not in the partly edited text, then replaced. Applying the changelog to the base MUST yield the working copy exactly. The builder verifies this and, if it fails, emits a single block whose SEARCH is the whole base.
7. **Cumulative.** A changelog always describes the full difference between version `from` and the current working copy. If a message (or a later message) contains another changelog for the same id with the same `from`, the **last one supersedes** earlier ones.
8. **One fence per edited draft.** Several fences (different ids) may follow each other, separated by one blank line. No fence is produced for a draft without uncommitted edits.
9. **Marker conflict.** If a SEARCH or REPLACE line would be exactly equal to a marker line (`<<<<<<< SEARCH`, `=======`, `>>>>>>> REPLACE`, `*** Begin Patch`, `*** End Patch`), the changelog cannot be expressed. The builder refuses with a marker-conflict error and the panel asks the user to change that line (for example a 7-character `=======` Setext underline can be written with 8 `=` or as an ATX `#` heading).
10. **Fence length** follows section 10.4 over the whole body.

### 11.3 Worked example: a change and an insertion

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

### 11.4 Worked example: widening for uniqueness

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

### 11.5 Worked example: code content, deletion, two drafts in one message

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

The user changes line 3 to ` ```bash ` and deletes lines 6–7. Version 2 of `trip-note` (section 11.3) is also edited. The injected text is:

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

## 12. Selection rewrite (`draft-rewrite`)

### 12.1 Coordinates

- The selection is a half-open range from (`start_line`, `start_offset`) to (`end_line`, `end_offset`) in the full text of version `rev`.
- Lines are **1-based**. `end_line ≥ start_line`.
- Offsets count **Unicode code points** (not UTF-16 code units, not bytes, not grapheme clusters) from the start of their line. `start_offset` is inclusive; `end_offset` is exclusive. `0 ≤ offset ≤ code-point length of the line`.
- If `start_line = end_line` then `end_offset > start_offset`. Empty selections are not sent.
- In JavaScript, count code points with `Array.from(line).length`, or `for…of`. Convert editor positions (usually UTF-16) at the boundary.
- The fence body is exactly the selected text, with `\n` between lines. The whole document is sent only when the selection is the whole document.
- The coordinates refer to the committed version `rev`. If the user has uncommitted edits, core maps the selection back to `rev` when it lies entirely in text unchanged since `rev`; otherwise the panel asks the user to send or discard the edits first.

### 12.2 Message layout

The message sent with `sendNow` is the fence, one blank line, then the user's instruction:

````text
```draft-rewrite id="<id>" rev="<n>" start_line="<a>" end_line="<b>" start_offset="<x>" end_offset="<y>"
<selected text>
```

<instruction>
````

Fence length follows section 10.4. The assistant is expected to answer with a full `draft` fence for the same id, which becomes version `n + 1` (or later).

### 12.3 Worked example

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

## 13. Version reconstruction

Core rebuilds every committed version from `getHistory` alone. Adapters must make this possible by returning complete, stable, ordered messages.

```text
versions = {}                                   # draftId -> DraftVersion[]
for message in history.messages (oldest first):
    if message.role != 'assistant' or not message.complete: continue
    fences = closed, top-level draft fences in message.text with a valid id
    keep only the last fence for each id            # last-fence rule
    for fence in kept fences, ordered by fenceIndex:
        n = len(versions[fence.id]) + 1
        versions[fence.id].append(DraftVersion(n, message.id, fence.fenceIndex, ...))
```

Rules:

1. Only closed `draft` fences in complete **assistant** messages count. Fences in user, system and tool messages are ignored; `draft-changelog` and `draft-rewrite` fences never create versions.
2. Within one assistant message, the last closed fence of an id wins.
3. `n` is the count of committed appearances of the id in the session (1, 2, 3, …). The model's `rev` attribute is stored as `revHint` and never used for numbering.
4. Rebuild is **idempotent**: rebuilding from the same history gives the same versions, and equals the state built incrementally from `assistant_done` events.
5. Drafts are listed in order of first appearance.
6. After rebuild, each stored working copy is checked: if version `baseVersion` no longer exists or its body hash differs from `baseHash`, the working copy is marked **stale**; the panel offers to review it against the latest version or discard it. It is never silently applied.
7. If `completeness` is `'window'`, numbering starts at the first visible appearance and the panel warns that older versions may be missing.

## 14. Panel hosting and working-copy storage

### 14.1 Mounting the panel

- The host mounts the UI. Core never assumes a DOM and never opens a panel.
- `packages/ui` exports a React component:

  ```ts
  export interface DraftCanvasPanelProps {
    adapter: HostAdapter;
    /** false while the panel is hidden; undefined counts as visible. */
    active?: boolean;
    /** Text for the "how to open this panel" hint on hosts without canAutoOpenPanel. */
    openHint?: string;
    /** Optional CSS custom properties (`--dc-*`) applied to the panel root. Additive; hosts may ignore it. */
    cssVariables?: Record<string, string>;
  }
  export function DraftCanvasPanel(props: DraftCanvasPanelProps): JSX.Element;
  ```

- React hosts render `<DraftCanvasPanel adapter={adapter} active={visible} />`. Hosts without React (for example a TUI) use core's `DraftSessionController` directly and render their own view.
- **Visibility.** While `active === false`, the panel does no polling and no animation and does not render streaming previews. It stays subscribed, records that events arrived, and on becoming visible performs one `getHistory` and rebuild if anything arrived. `active === undefined` counts as visible.
- **Active session.** The adapter tells core which chat the panel belongs to through `getActiveSession()` and `session_changed`.
- **Hosts that cannot auto-open panels** (`canAutoOpenPanel: false`) must document how the user opens the panel, and pass that text as `openHint`. The model-facing skill should repeat it.

### 14.2 Working-copy storage

- `WorkingCopyStorage` is optional and **best-effort**. Data may be lost on uninstall, cache clearing or crash. Losing it loses only uncommitted edits.
- Key records by `(sessionId, draftId)`. One record per pair; `save` overwrites.
- Store the `WorkingCopy` object as JSON. Unknown fields must be preserved on load/save round trips when possible.
- `save` may be called often (debounced by core to at most once per 500 ms per draft). It must not block the UI for long.
- Storage errors reject with `host_error`; core keeps the working copy in memory and shows a non-blocking notice.
- A working copy is never shown as a committed version and never sent unless the user clicks "Send to the agent".

## 15. Errors and limits

| Situation | Adapter behaviour | Core / UI behaviour |
|---|---|---|
| Call before `connect()` or after `dispose()` | Reject `not_connected` | Shows "Not connected", retries `connect()` on user action |
| Unknown session | Reject `session_not_found` | Re-reads `getActiveSession()` |
| Host refuses (route not allowlisted, user denied) | Reject `permission_denied` | Shows the message; no retry |
| Host throttles | Reject `rate_limited`, set `retryAfterMs` if known, `retryable: true` | Retries once after the delay, then shows an error |
| Text over a cap | Reject `payload_too_large` | Shows "Too large"; for changelogs suggests staging fewer drafts |
| Capability is false | Reject `unsupported` | Hides or disables the action |
| Anything else | Reject `host_error` with the host's message and `cause` | Shows the message |

- Adapters MUST NOT throw synchronously from async methods; return a rejected promise.
- Adapters MUST NOT partially inject: either the whole text is attached or nothing is.
- `sendNow` and `injectNextTurn` MUST NOT be retried automatically by the adapter if the host may already have accepted the text (avoid duplicate messages).
- Size checks use UTF-8 byte length.
- Never log message text at levels enabled by default; drafts can be private.

## 16. Reference implementation: Kiro Crew

Package `packages/hosts/kiro-crew`, a Crew App with id `draft-canvas` (display name "Draft Canvas", `minKiroCrewVersion` 0.12.2). It is mounted as a chat side-panel tab declared in `contributes.panelTabs`. Values below were taken from the project's Crew 0.12.2 research notes (`docs/research/r0-crew-plugin-and-oss.md`). No verified Gateway traffic recording and no reload test existed when this section was last updated, so items marked *verify* are still **unverified** and the adapter uses the stated default. Status of each item: `docs/hosts/kiro-crew.md`.

| Contract item | Crew mapping |
|---|---|
| `info` | `{ id: 'kiro-crew', displayName: 'Kiro Crew', interfaceVersion: '1' }`, `hostVersion` detected if the SDK exposes it |
| `sessionId` | The Crew chat slot key (same value used by `/api/chat/slots/{slot}` and `openChat({ slotKey })`) |
| `getActiveSession` | Crew documents no API that gives a panel tab its slot key (V-1, *verify*). Order: a slot set with `setSlot`; else the chat core last read history for (the user's pick); else an auto-pick from `GET /api/chat/slots` when the list marks exactly one chat current/active, lists exactly one chat, or every chat has a last-used time and one is strictly newest; else `null`, and the panel shows a labelled chat picker built from `listSessions` |
| `listSessions` | `GET /api/chat/slots` via `useAppApi()` |
| `getHistory` | `GET /api/chat/slots/{slot}` via `useAppApi()`; `completeness` is `'full'` only if the response is shown to start at the first message. That was not shown (V-4, *verify*), so the adapter always reports `'window'` |
| `assistant_chunk` | WebSocket `chat_chunk` via `useAppEvents` |
| `assistant_done` / `user_message` | `chat_message` (by role) and `chat_done`. If the final frame lacks full text, the adapter fetches history for that slot and emits the persisted message |
| `injectNextTurn` | `useChatLauncher().openChat({ slotKey, message: "\n\n" + text, autoSend: false })`: appends to the unsent composer. Result `{ fidelity: 'context-only', requiresUserSend: true }` until the reload test in section 8.1 (T-49) has passed, because section 8 says to report `'context-only'` when unsure. The composer path is expected to persist the text in the user message, but that is unverified. The adapter changes to `'persisted'` only after the test passes |
| `sendNow` | `POST /api/chat` first, with the unverified default body `{ "slot": <slot>, "text": <text> }` (V-5, *verify*; overridable). If the POST fails, one fallback to `openChat({ slotKey, message: text, autoSend: true })`. No call is repeated and the fallback is skipped when the POST succeeded |
| `storage` | Panel tab `localStorage`, key `draft-canvas:v1:wc:<encodeURIComponent(sessionId)>:<encodeURIComponent(draftId)>` |
| Visibility | `useAppInfo().active` passed as `active` |
| `permissions.api` | `["/api/chat/slots", "/api/chat"]`: bare paths, because the Crew 0.12.2 SDK compares the pathname as written and has no method prefix or `{slot}` syntax. `/api/chat/slots` also covers `GET /api/chat/slots/{slot}` (the history route), and `/api/chat` covers `POST /api/chat`. The routes the adapter calls are `GET /api/chat/slots`, `GET /api/chat/slots/{slot}` and `POST /api/chat`; the SDK cannot restrict by method. See `docs/hosts/kiro-crew.md` |

Capabilities: `canStreamTokens: true`, `canSendNow: true`, `canAppendToComposer: true`, `canRewritePersistedUserMessage: false` (unverified until section 8.1; the composer text is meant to become the user's own message when sent), `canAutoOpenPanel: false`, `hasHostStorage: true`, `canReadFullHistory: false` (history is reported as a window). No size caps are set. The skill is **not** bundled in `app.json` (V-8, *verify*: whether a Crew App can bundle a skill is not documented in the project's notes); it is installed by hand.

Limits and notes:

- Crew has no API to open a panel tab programmatically. The user opens Draft Canvas from the chat side-panel **+ menu**; the README, the skill and `openHint` say so.
- A hidden panel tab stays mounted; it must respect `useAppInfo().active`.
- **Choosing the chat.** Because Crew documents no way for a tab to learn its slot (V-1), the panel shows a labelled chat picker whenever the adapter returned no active session, even when only one chat is listed, and whenever more than one chat is listed. The last-used-time rule of `getActiveSession` is a heuristic: it picks the chat that was used most recently, which may not be the chat the user is looking at.
- **`sendNow` fallback.** The rewrite message is sent once. A failed `POST /api/chat` (any error) is followed by one `openChat({ autoSend: true })`. If the POST failed after Crew had already accepted the text (for example a timeout), the fallback can produce a second message; the adapter cannot tell these cases apart. The adapter never retries either call.
- **Unverified at the time of writing:** V-1 (slot key), V-3 (frame payload shapes), V-4 (history shape and completeness), V-5 (`POST /api/chat` body), V-6 (separator, focus), V-7 and V-9 (manifest keys), V-8 (bundled skill), V-10 (reload test, T-49). Packaging (T-48) and the adapter tests (T-47) have landed, but their fixtures follow the defaults above and do not verify them. See `docs/hosts/kiro-crew.md`.
- `@kirocrew/app-sdk`, React, ReactDOM and lucide-react come from the host import map and are bundler externals.
- The composer path cannot remove text it appended. If the user edits after staging, the panel warns that the staged changelog is out of date and offers to append a fresh one; the later fence supersedes the earlier one (section 11.2 rule 7).
- **Documented fallback**, built only if the composer path fails the reload test: a `UserPromptSubmit` hook in `~/.kiro/crew/hooks.json` prints pending changelogs to stdout. Crew adds hook stdout to the turn's model context, not to the persisted user message, so this path reports `fidelity: 'context-only'`, `requiresUserSend: false`, `canRewritePersistedUserMessage: false`, and `maxInjectBytes: 65536` (the hook stdout cap is 64 KiB). The hook cannot read tab `localStorage`, so the panel must mirror pending changelogs to a location the hook can read. Not built (T-50 is conditional on T-49).

## 17. Notes for future hosts (informational)

These notes come from the product plan's host research. They are not specifications; verify each against the host's current documentation and run the reload test.

- **OpenCode.** A server plugin `prompt` hook can rewrite `event.prompt.text` before the user input is persisted; the docs state that edits become the canonical persisted user input. That maps to `fidelity: 'persisted'`, `requiresUserSend: false`, `canAppendToComposer: false`. Do not use the `context` hook for changelogs: it changes only the current model request. Sending now: `ctx.session.prompt(...)`. Panel: TUI `session.panel` slot; GUI panel API is experimental.
- **DeepSeek Harness (`dsh`).** Developer preview with breaking changes expected. Streaming via `agent/assistant-stream`, settled history via `session/event` and `sessionQuery`. Sending now: `Agent.followup()`. Next-turn injection: `agent.inject()` or system-prompt sections; whether any of them reaches the persisted user message is unknown, so start from `'context-only'` until the reload test proves otherwise.
- **CodeBuddy Code CLI / WorkBuddy.** Hooks receive `transcript_path` (a JSONL transcript), useful for `getHistory`; `Stop` fires at the end of an agent turn. `UserPromptSubmit` stdout or `hookSpecificOutput.additionalContext` is added to context and is likely `'context-only'`. No streaming API and no documented way to send a user message now were found, so `canStreamTokens` and `canSendNow` may be `false`. There is no chat side panel; a local window may host the UI.

## 18. Minimal adapter skeleton

This is a shape to start from, not a working integration.

```ts
import {
  HostAdapter, HostAdapterError, HostCapabilities, HostEvent, HostInfo,
  InjectResult, Message, SendResult, SessionRef, HistoryCompleteness,
  WorkingCopy, WorkingCopyStorage,
} from '@draft-canvas/core';

export class ExampleHostAdapter implements HostAdapter {
  readonly info: HostInfo = {
    id: 'example-host',
    displayName: 'Example Host',
    adapterVersion: '0.1.0',
    interfaceVersion: '1',
  };

  // Report only what the reload test and host docs support.
  readonly capabilities: HostCapabilities = {
    canReadFullHistory: true,
    canStreamTokens: true,
    canSendNow: true,
    canRewritePersistedUserMessage: false, // until section 8.1 passes
    canAppendToComposer: false,
    canAutoOpenPanel: false,
    hasHostStorage: true,
  };

  readonly storage: WorkingCopyStorage = {
    async load(_sessionId, _draftId): Promise<WorkingCopy | null> { return null; /* read host storage */ },
    async save(_copy): Promise<void> { /* write JSON */ },
    async remove(_sessionId, _draftId): Promise<void> { /* delete */ },
  };

  private listeners = new Set<(e: HostEvent) => void>();
  private connected = false;

  async connect(): Promise<void> {
    if (this.connected) return;
    // Open the host connection, detect hostVersion, register host event handlers
    // that translate host frames into HostEvents via this.emit(...).
    this.connected = true;
    this.emit({ type: 'connection', state: 'connected' });
  }

  async dispose(): Promise<void> {
    // Remove host handlers, close sockets, cancel timers.
    this.listeners.clear();
    this.connected = false;
  }

  async getActiveSession(): Promise<SessionRef | null> {
    this.assertConnected();
    return null; // return the chat the panel belongs to
  }

  async getHistory(sessionId: string): Promise<{ messages: Message[]; completeness: HistoryCompleteness }> {
    this.assertConnected();
    // Read the full persisted log, oldest first; map to Message with stable ids.
    throw new HostAdapterError('session_not_found', `Unknown session ${sessionId}`);
  }

  subscribe(listener: (e: HostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async injectNextTurn(_sessionId: string, _text: string): Promise<InjectResult> {
    this.assertConnected();
    // Attach text to the next user turn, separated from user text by one blank line.
    // Report where it really lands.
    return { ok: true, fidelity: 'context-only', requiresUserSend: false };
  }

  async sendNow(_sessionId: string, _text: string): Promise<SendResult> {
    this.assertConnected();
    // Post a user message now. Do not retry automatically.
    return { ok: true };
  }

  private emit(event: HostEvent): void {
    for (const l of [...this.listeners]) {
      try { l(event); } catch (err) { console.error('draft-canvas listener failed', err); }
    }
  }

  private assertConnected(): void {
    if (!this.connected) throw new HostAdapterError('not_connected', 'connect() first');
  }
}
```

(`assertConnected` throws inside `async` methods, so callers still receive a rejected promise.)

## 19. Conformance checklist

A conformance fixture suite (message transcripts with expected versions, changelogs and rewrite messages) will be published under `fixtures/conformance/`. Until then, an adapter is conformant when all of the following hold:

**Identity and capabilities**

- [ ] `info.interfaceVersion === '1'`; `info.id` is a lowercase slug.
- [ ] Capabilities are constant after `connect()` and match observed behaviour; every method whose capability is `false` rejects with `unsupported`.

**Lifecycle**

- [ ] Constructor performs no I/O; `connect()` and `dispose()` are idempotent.
- [ ] After `dispose()`, every method rejects with `not_connected` and no listener is called.
- [ ] After a dropped connection, `connection` events are emitted and old events are not replayed.

**History**

- [ ] `getHistory` returns messages oldest first, with stable ids across reloads, full persisted text, and correct roles.
- [ ] `completeness` is `'full'` only when history starts at the first message.
- [ ] Rebuild from `getHistory` equals the state built from live events for the same session (idempotence).
- [ ] An assistant message with two `draft` fences for one id yields one version (the last fence).
- [ ] A `draft` fence inside a user message, or inside another fenced block, yields no version.
- [ ] An assistant message that ends with an unclosed `draft` fence yields no version.

**Events**

- [ ] Per assistant message: `assistant_chunk`* then exactly one `assistant_done`; `assistant_done.message.text` equals the `getHistory` text.
- [ ] `user_message` is emitted for messages sent by the user and by `sendNow`.
- [ ] `history_reset` is emitted on compaction, edits, deletions and abandoned streams.
- [ ] A throwing listener does not stop delivery to others.

**Injection and sending**

- [ ] `injectNextTurn` text appears unmodified, separated from user text by one blank line.
- [ ] The reload test (section 8.1) was run and the reported `fidelity` matches its result; the result is recorded in the adapter README with host version and date.
- [ ] `sendNow` creates exactly one user message whose persisted text equals the input.
- [ ] Oversized text rejects with `payload_too_large` and injects nothing.

**Wire formats (core, checked with the adapter in the loop)**

- [ ] Changelogs for the fixtures apply to their base to give the working copy exactly; each SEARCH matches the base exactly once; blocks do not overlap. (Valid output is required, not byte-identical output.)
- [ ] Rewrite messages use 1-based lines and code-point offsets; CJK and emoji fixtures produce the expected offsets.
- [ ] Bodies containing ` ``` ` are wrapped in fences of 4 or more backticks.

**Storage (if `hasHostStorage`)**

- [ ] `save` then `load` round-trips a `WorkingCopy`; `remove` deletes it; records are isolated per `(sessionId, draftId)`.

