# `@draft-canvas/host-workbuddy`

Draft Canvas for WorkBuddy (desktop) and CodeBuddy Code: a local hub, a browser panel, a hook, and
`WorkBuddyAdapter`.

Full host facts, the answers to the seven porting questions, and the two things that make this host
different are in [`docs/hosts/workbuddy.md`](../../../docs/hosts/workbuddy.md) (Chinese). This file
only records what a maintainer needs at hand.

## What is where

```
src/protocol.ts        wire types shared by the browser and the hub
src/adapter.ts         HostAdapter over loopback HTTP + SSE
src/transport.ts       fetch + EventSource
src/panel.tsx          mounts DraftCanvasPanel in a plain page
src/storage.ts         working copies in localStorage
src/prefs.ts           language / text size / dismissed banners
src/server/paths.ts    ~/.workbuddy vs ~/.codebuddy, state folders
src/server/transcript.ts  JSONL → Message[] (tolerant, no host schema is documented)
src/server/tailer.ts   follows one transcript, emits user_message / assistant_* / reset
src/server/sink.ts     the published-draft store (this host's source of truth)
src/server/sessions.ts session registry (hook-learned + scanned)
src/server/pending.ts  queue for "the next message carries this"
src/server/hub.ts      HTTP + SSE + hook ingest + static panel
src/server/hooks.ts    settings.json merge / uninstall
src/server/simulate.ts fake host for tests and demos
src/server/main.ts     the `draft-canvas-wb` command
hooks/draft-canvas-hook.mjs  what settings.json points at
skill/draft-fence.md         installed into <home>/skills
```

## Two rules that are easy to break

1. **Never read transcript files from a hot path.** `listSessions` runs on every panel load and after
   every hook. Titles are computed during the scan (max 6 files per scan, first 8 KiB each) and
   cached; a title lookup must not touch the disk. Getting this wrong blocks the whole hub: the
   panel sits on "loading the chat" and nothing else gets served.
2. **A version is a published draft, not an assistant message.** WorkBuddy writes no assistant text
   to the transcript, so `sink.ts` is the source of truth. If you "fix" the adapter to read assistant
   messages from the transcript, versions will silently disappear on this host.

## Reload test (ADAPTER_INTERFACE 8.1)

Result: **not run**; the adapter reports `fidelity: 'context-only'` and `canRewritePersistedUserMessage: false`,
which is the safe answer whether or not the hook's context ends up in the stored user message.
Record the outcome here with the host version and date once someone runs it.

## Commands

```bash
npm.cmd run typecheck
node ../../../node_modules/vitest/vitest.mjs run     # 51 tests
node ../../../scripts/package-workbuddy.mjs          # → dist/workbuddy/
node dist/workbuddy/bin/draft-canvas-wb.mjs simulate # fake host, no WorkBuddy needed
node dist/workbuddy/bin/draft-canvas-wb.mjs doctor   # what the parser sees, no text printed
```
