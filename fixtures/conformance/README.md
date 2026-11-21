# Adapter conformance fixtures

This folder holds the shared fixtures and the instructions for checking a
`HostAdapter` against `docs/ADAPTER_INTERFACE.md` section 19. The normative
contract is that document; these fixtures only make it runnable.

Nothing here is shipped in the app. Draft Canvas v1 ships one host adapter
(`packages/hosts/kiro-crew`, `[workbuddy]` / `[kiro]` task split in
`.kiro/specs/crew-v1/tasks.md`). Other hosts (OpenCode, DeepSeek Harness,
CodeBuddy Code) are expected to reuse this suite later; the repository does not
contain packages or stubs for them (REQ-18.5).

## Contents

| File | What it is |
|---|---|
| `transcripts/basic.json` | A `Message[]` transcript with two drafts revised over several messages, two fences for one id in one message, and a draft body containing a code fence. Includes the expected versions and the expected draft order. |
| `transcripts/edge-cases.json` | Messages that must **not** create versions (fence in a user message, nested fence, block quote, 4-space indent, tilde block, unclosed fence, invalid id) plus CRLF text, a body with a code fence and an id-less `draft` fence (auto id `draft-1`) that must each create one. |
| `changelogs.json` | SEARCH/REPLACE cases: the worked examples from AI 11.3-11.5, deletion, empty base, insertion at the top, CRLF, `no_changes` and `marker_conflict`. Each case has an `expect` value and (for the worked examples) the exact expected blocks. |
| `rewrites.json` | `draft-rewrite` cases: the AI 12.3 CJK/emoji example with the exact expected message text, a multi-line selection, a whole-document selection, a selection containing a code fence (four backticks), and an emoji-only selection. |

`expectedVersions` follow ADAPTER_INTERFACE section 13: only closed top-level
`draft` fences in complete **assistant** messages count, the last fence of an id
in one message wins, and numbering follows conversation order.

## Running the suite against an adapter

The runnable suite lives in the core package's tests, not in this folder:

- `packages/core/test/conformance/harness.ts` - `runConformanceSuite(target)`
- `packages/core/test/conformance/adapter-conformance.test.ts` - the in-memory
  fake host that currently passes

To check your adapter (for example one in `packages/hosts/opencode`):

1. Add a Vitest file in your adapter package, or copy the harness next to your
   tests. The harness imports core from `../../src/index`; change that one import
   to `@draft-canvas/core` when you copy it out of this repository. The fixture
   types come from the core tests' `support/fixtures.ts`.
2. Implement `ConformanceTarget`:

   ```ts
   import { readFileSync } from 'node:fs';
   import { runConformanceSuite } from '../../core/test/conformance/harness';

   runConformanceSuite({
     name: 'opencode',
     // A fresh, unconnected adapter plus the test-only driver below.
     create(setup) {
       const host = awaitableFakeOrRealHost(setup); // seed it with setup.messages
       return { adapter: host.adapter, driver: host.driver };
     },
     // Optional: an adapter with a small maxInjectBytes, for the oversized test.
     createOversized(bytes) { /* ... */ },
     // Fill this in after running the AI 8.1 reload test on the real host.
     hostDocumented: {
       'reload-test': 'persisted, opencode 0.4.1, 2026-03-01',
     },
     transcripts: loadTranscripts(),
     changelogCases: loadChangelogCases(),
     rewriteCases: loadRewriteCases(),
   });
   ```

3. Implement `ConformanceDriver`. These are the only host-specific parts; they
   simulate what the host does and are never used by the app:

   | Method | The host does this |
   |---|---|
   | `assistantChunks(messageId, delta)` | streams a piece of assistant text |
   | `assistantDone(message)` | finalises the message and persists it in the transcript |
   | `userMessage(message)` | persists a user message (as if the user typed it) |
   | `connection(state)` | the connection changed (`reconnecting`, `connected`, `disconnected`) |
   | `historyReset(sessionId)` | history changed (compaction, edit, deletion, abandoned stream) |
   | `setHistory(sessionId, messages)` | replaces the persisted transcript |
   | `composer?()` / `setComposer?(text)?` | optional read/write of the unsent composer, used only by the injection tests |

   The constructor of the adapter returned by `create()` must not perform I/O;
   `setup.messages` is the transcript the host should serve from `getHistory`.

4. Run it headless from the repository root:

   ```sh
   npx vitest run --root packages/core test/conformance
   ```

   or from your package with its own Vitest config.

## Checklist items that need a real host

These cannot be proven in memory. They are registered as skipped tests with a
`host-documented` marker and must be recorded in your adapter README:

- **The AI 8.1 reload test.** Steps: produce a draft, stage a changelog, send a
  message, confirm the model saw the change, reload the host, then confirm
  `getHistory` contains the `draft-changelog` fence verbatim. Record the
  fidelity, host version and date. Put the same text in
  `hostDocumented['reload-test']`; if it is absent, the suite requires
  `canRewritePersistedUserMessage` to be `false` so the adapter cannot claim
  `persisted` without evidence.
- **Composer separation on the real host** (exactly one blank line between the
  user's text and the injected fence).
- **The host's own oversized-injection rejection** (the suite checks the
  adapter's `payload_too_large` cap, not the host's).

Mark these in your README; do not turn them into passing tests with a fake.

## What the suite checks

Section 19 of `docs/ADAPTER_INTERFACE.md`, group by group:

- **Identity and capabilities** - `interfaceVersion` `'1'`, lowercase slug,
  capabilities constant after `connect()`, capability-false methods reject
  `unsupported`.
- **Lifecycle** - no I/O before `connect()`, idempotent `connect()`/`dispose()`,
  `not_connected` after `dispose()`, connection events, no replay on reconnect.
- **History** - stable ids, order, roles, text, `completeness`; rebuild equals
  live events; the last-fence rule; user/nested fences ignored; unclosed fences
  yield no version.
- **Events** - chunks then exactly one `assistant_done` whose text equals
  `getHistory`; one `user_message` per `sendNow`; `history_reset`; a throwing
  listener does not stop delivery.
- **Injection and sending** - unsent text unchanged and separated by one blank
  line; fidelity matches the observed path; `sendNow` persists exactly the
  input; oversized text rejects `payload_too_large` and injects nothing.
- **Wire formats** - each changelog applies to its base and matches the expected
  blocks; rewrite messages use 1-based lines and code-point offsets (CJK and
  emoji); bodies with a code fence use four or more backticks. Where the
  adapter can append to a composer or send now, the changelog and rewrite are
  also staged/sent through `DraftSessionController` and read back from the host.
- **Storage** - save/load round trip, remove, and isolation per
  `(sessionId, draftId)` when `hasHostStorage` is true.
