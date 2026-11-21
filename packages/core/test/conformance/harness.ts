import { describe, expect, it } from 'vitest';

import {
  applyAssistantMessage,
  applyChangelog,
  buildChangelog,
  DraftSessionController,
  emptyVersionStore,
  formatChangelogFence,
  formatDraftFence,
  formatRewriteMessage,
  getVersions,
  isChangelogError,
  parseChangelogFences,
  parseRewriteFences,
  rebuild,
  toRewriteRequest,
  validateChangelog,
  type ConnectionState,
  type DraftVersion,
  type HostAdapter,
  type HostCapabilities,
  type HostEvent,
  type Message,
  type VersionStore,
  type WorkingCopy,
} from '../../src/index';
import type { ChangelogFixtureCase, RewriteFixtureCase, TranscriptFixture } from '../support/fixtures';

/**
 * T-23: reusable adapter conformance suite for docs/ADAPTER_INTERFACE.md section 19.
 *
 * The suite drives any `HostAdapter` through the checklist. Host-specific
 * simulation (streaming, a user typing, a dropped connection, compaction) goes
 * through a small `ConformanceDriver`, which each adapter's test file supplies.
 * See fixtures/conformance/README.md for how to run this against a real adapter.
 */

export type HostDocumentedItem =
  | 'reload-test' // AI 8.1: was run against a real host; fidelity matches the result
  | 'composer-separation' // AI 8: injected text and user text separated by one blank line
  | 'oversized-injection'; // the host rejects oversized text on its side

export interface ConformanceSetup {
  sessionId?: string;
  messages?: Message[];
  capabilities?: Partial<HostCapabilities>;
}

/** Host-specific event injection and probes. Everything here is test-only. */
export interface ConformanceDriver {
  /** Emit `assistant_chunk` events for one message id, in order. */
  assistantChunks(messageId: string, delta: string): void;
  /** Emit one `assistant_done` and persist the message in the host transcript. */
  assistantDone(message: Message): void;
  /** Persist a user message and emit `user_message`, as if the user typed it. */
  userMessage(message: Message): void;
  connection(state: ConnectionState): void;
  historyReset(sessionId: string): void;
  /** Replace the persisted transcript (compaction, edits). */
  setHistory(sessionId: string, messages: Message[]): void;
  /** Optional: the unsent composer text, when the host exposes it to tests. */
  composer?(): string;
  /** Optional: put text in the composer before an injection. */
  setComposer?(text: string): void;
}

export interface ConformanceSession {
  adapter: HostAdapter;
  driver: ConformanceDriver;
}

export interface ConformanceTarget {
  /** Shown in the test names, e.g. "in-memory fake host". */
  name: string;
  /** A fresh, unconnected adapter plus its driver. Must perform no I/O. */
  create(setup?: ConformanceSetup): ConformanceSession;
  /** Optional: a session whose adapter has a small `maxInjectBytes`, for the oversized test. */
  createOversized?(bytes: number): ConformanceSession;
  /** Results to record for checklist items that need a real host (AI 8.1). */
  hostDocumented?: Partial<Record<HostDocumentedItem, string>>;
  transcripts: TranscriptFixture[];
  changelogCases: ChangelogFixtureCase[];
  rewriteCases: RewriteFixtureCase[];
}

interface Collected {
  events: HostEvent[];
  stop(): void;
}

function collect(adapter: HostAdapter): Collected {
  const events: HostEvent[] = [];
  const unsubscribe = adapter.subscribe((event) => events.push(event));
  return { events, stop: unsubscribe };
}

async function waitFor(predicate: () => boolean, what = 'event', timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function project(version: DraftVersion): Record<string, unknown> {
  const out: Record<string, unknown> = {
    n: version.n,
    sourceMessageId: version.sourceMessageId,
    fenceIndex: version.fenceIndex,
    lang: version.lang,
    body: version.body,
  };
  if (version.revHint !== undefined) out['revHint'] = version.revHint;
  if (version.title !== undefined) out['title'] = version.title;
  return out;
}

function allVersions(store: VersionStore): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const id of store.order) {
    for (const version of getVersions(store, id)) out.push({ draftId: id, ...project(version) });
  }
  return out;
}

export function userMessageFixture(sessionId: string, id: string, text: string): Message {
  return { id, sessionId, role: 'user', text, createdAt: '2026-01-01T00:00:00.000Z', complete: true };
}

export function assistantMessageFixture(sessionId: string, id: string, text: string): Message {
  return { id, sessionId, role: 'assistant', text, createdAt: '2026-01-01T00:00:00.000Z', complete: true };
}

function fenceLengthOf(message: string): number {
  const match = /^(`+)/.exec(message);
  return match?.[1].length ?? 0;
}

/** Builds `n` versions of `id`, the last one with `base`, so a changelog can be staged against it. */
function historyForBase(sessionId: string, id: string, baseVersion: number, base: string): Message[] {
  const messages: Message[] = [];
  for (let n = 1; n <= baseVersion; n += 1) {
    const body = n === baseVersion ? base : `version ${String(n)} placeholder`;
    messages.push(
      assistantMessageFixture(sessionId, `wire-${String(n)}`, formatDraftFence({ id, body, rev: String(n) })),
    );
  }
  return messages;
}

export function runConformanceSuite(target: ConformanceTarget): void {
  // Constructors must perform no I/O, so probing capabilities here is safe.
  const probe = target.create();
  const capabilities = probe.adapter.capabilities;
  const sessionId = 'conformance-session';
  const canStage = capabilities.canAppendToComposer || capabilities.canRewritePersistedUserMessage;
  const hasStorage = capabilities.hasHostStorage && probe.adapter.storage !== undefined;
  const hasComposerProbe = probe.driver.composer !== undefined && probe.driver.setComposer !== undefined;

  describe(`§19 adapter conformance: ${target.name}`, () => {
    describe('identity and capabilities', () => {
      it('info.interfaceVersion is "1" and info.id is a lowercase slug', () => {
        const { adapter } = target.create();
        expect(adapter.info.interfaceVersion).toBe('1');
        expect(adapter.info.id).toMatch(/^[a-z][a-z0-9-]*$/);
        expect(adapter.info.adapterVersion).toMatch(/^\d+\.\d+\.\d+/);
        expect(adapter.info.displayName.length).toBeGreaterThan(0);
      });

      it('capabilities are constant after connect() and match the optional members', async () => {
        const { adapter } = target.create();
        const before = JSON.stringify(adapter.capabilities);
        await adapter.connect();
        expect(JSON.stringify(adapter.capabilities)).toBe(before);
        expect(adapter.capabilities.canAutoOpenPanel).toBe(adapter.openPanel !== undefined);
        await adapter.getActiveSession();
        expect(JSON.stringify(adapter.capabilities)).toBe(before);
        await adapter.dispose();
      });

      it('rejects with unsupported for every method whose capability is false', async () => {
        const { adapter } = target.create({
          capabilities: {
            canSendNow: false,
            canAppendToComposer: false,
            canRewritePersistedUserMessage: false,
          },
        });
        await adapter.connect();
        await expect(adapter.sendNow(sessionId, 'text')).rejects.toMatchObject({ code: 'unsupported' });
        await expect(adapter.injectNextTurn(sessionId, 'text')).rejects.toMatchObject({ code: 'unsupported' });
        await adapter.dispose();
      });
    });

    describe('lifecycle', () => {
      it('performs no I/O before connect()', async () => {
        const { adapter } = target.create();
        await expect(adapter.getActiveSession()).rejects.toMatchObject({ code: 'not_connected' });
        await expect(adapter.getHistory(sessionId)).rejects.toMatchObject({ code: 'not_connected' });
      });

      it('connect() and dispose() are idempotent', async () => {
        const { adapter } = target.create();
        await adapter.connect();
        await adapter.connect();
        await expect(adapter.getActiveSession()).resolves.toBeDefined();
        await adapter.dispose();
        await adapter.dispose();
      });

      it('after dispose() every method rejects not_connected and no listener is called', async () => {
        const { adapter, driver } = target.create();
        await adapter.connect();
        const collected = collect(adapter);
        await adapter.dispose();

        await expect(adapter.getActiveSession()).rejects.toMatchObject({ code: 'not_connected' });
        await expect(adapter.getHistory(sessionId)).rejects.toMatchObject({ code: 'not_connected' });
        await expect(adapter.injectNextTurn(sessionId, 'text')).rejects.toMatchObject({ code: 'not_connected' });
        await expect(adapter.sendNow(sessionId, 'text')).rejects.toMatchObject({ code: 'not_connected' });

        driver.connection('connected');
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(collected.events).toEqual([]);
      });

      it('emits connection events and does not replay old events on reconnect', async () => {
        const { adapter, driver } = target.create();
        await adapter.connect();
        const collected = collect(adapter);
        driver.connection('reconnecting');
        driver.connection('connected');
        await waitFor(
          () => collected.events.filter((e) => e.type === 'connection').length >= 2,
          'connection events',
        );

        const connections = collected.events.filter((e) => e.type === 'connection');
        expect(connections.map((e) => e.state)).toEqual(['reconnecting', 'connected']);
        expect(collected.events.some((e) => e.type === 'assistant_done' || e.type === 'user_message')).toBe(false);
        await adapter.dispose();
      });
    });

    describe('history', () => {
      for (const fixture of target.transcripts) {
        it(`getHistory gives stable ids, order and versions for "${fixture.name}"`, async () => {
          const { adapter } = target.create({ sessionId: fixture.sessionId, messages: fixture.messages });
          await adapter.connect();
          const history = await adapter.getHistory(fixture.sessionId);

          expect(history.messages.map((m) => m.id)).toEqual(fixture.messages.map((m) => m.id));
          expect(history.messages.map((m) => m.role)).toEqual(fixture.messages.map((m) => m.role));
          expect(history.messages.map((m) => m.text)).toEqual(fixture.messages.map((m) => m.text));
          expect(history.completeness).toBe(fixture.completeness);
          if (history.completeness === 'full') expect(adapter.capabilities.canReadFullHistory).toBe(true);

          const { store, unclosed } = rebuild(history.messages);
          expect(store.order).toEqual(fixture.expectedDraftOrder);
          for (const expected of fixture.expectedVersions) {
            expect(getVersions(store, expected.draftId).map(project)).toEqual(expected.versions);
          }
          expect(unclosed.map((notice) => notice.draftId)).toEqual(fixture.expectedUnclosed);

          const again = await adapter.getHistory(fixture.sessionId);
          expect(again.messages.map((m) => m.id)).toEqual(history.messages.map((m) => m.id));
          expect(again.messages.map((m) => m.text)).toEqual(history.messages.map((m) => m.text));
          await adapter.dispose();
        });
      }

      it('rebuild from getHistory equals the state built from live assistant_done events', async () => {
        const fixture = target.transcripts[0] as TranscriptFixture;
        const { adapter, driver } = target.create({ sessionId: fixture.sessionId, messages: fixture.messages });
        await adapter.connect();

        let live: VersionStore = emptyVersionStore();
        for (const message of fixture.messages) {
          if (message.role !== 'assistant') continue;
          driver.assistantDone(message);
          live = applyAssistantMessage(live, message).store;
        }
        const history = await adapter.getHistory(fixture.sessionId);
        expect(allVersions(live)).toEqual(allVersions(rebuild(history.messages).store));
        await adapter.dispose();
      });

      it('a repeated assistant_done is harmless', async () => {
        const fixture = target.transcripts[0] as TranscriptFixture;
        const { adapter, driver } = target.create({ sessionId: fixture.sessionId, messages: fixture.messages });
        await adapter.connect();
        const assistant = fixture.messages.find((m) => m.role === 'assistant') as Message;
        driver.assistantDone(assistant);
        driver.assistantDone(assistant);

        const history = await adapter.getHistory(fixture.sessionId);
        expect(history.messages.filter((m) => m.id === assistant.id)).toHaveLength(1);
        expect(allVersions(rebuild(history.messages).store)).toEqual(allVersions(rebuild(fixture.messages).store));
        await adapter.dispose();
      });

      it('an assistant message with two fences for one id yields one version (last fence)', async () => {
        const fixture = target.transcripts.find((item) => item.name === 'basic');
        if (fixture === undefined) return;
        const { adapter } = target.create({ sessionId: fixture.sessionId, messages: fixture.messages });
        await adapter.connect();
        const { store } = rebuild((await adapter.getHistory(fixture.sessionId)).messages);
        const versions = getVersions(store, 'trip-note');
        expect(versions).toHaveLength(2);
        expect(versions[1]?.sourceMessageId).toBe('m4');
        expect(versions[1]?.body).toContain('Bring a hat.');
        await adapter.dispose();
      });

      it('a fence in a user message or nested in another block yields no version', async () => {
        const fixture = target.transcripts.find((item) => item.name === 'edge-cases');
        if (fixture === undefined) return;
        const { adapter } = target.create({ sessionId: fixture.sessionId, messages: fixture.messages });
        await adapter.connect();
        const { store } = rebuild((await adapter.getHistory(fixture.sessionId)).messages);
        for (const id of ['pasted', 'nested', 'quoted', 'indented', 'tilde', 'system-message', 'tool-message']) {
          expect(getVersions(store, id)).toEqual([]);
        }
        await adapter.dispose();
      });

      it('an assistant message that ends with an unclosed fence yields no version', async () => {
        const fixture = target.transcripts.find((item) => item.name === 'edge-cases');
        if (fixture === undefined) return;
        const { adapter } = target.create({ sessionId: fixture.sessionId, messages: fixture.messages });
        await adapter.connect();
        const { store, unclosed } = rebuild((await adapter.getHistory(fixture.sessionId)).messages);
        expect(getVersions(store, 'unfinished')).toEqual([]);
        expect(unclosed.map((notice) => notice.draftId)).toContain('unfinished');
        await adapter.dispose();
      });
    });

    describe('events', () => {
      it.skipIf(!capabilities.canStreamTokens)(
        'per assistant message: chunks then exactly one assistant_done with the persisted text',
        async () => {
          const { adapter, driver } = target.create({ messages: [] });
          await adapter.connect();
          const collected = collect(adapter);
          const id = 'stream-1';
          const text = formatDraftFence({ id: 'streamed', body: 'Streamed body.' });

          driver.assistantChunks(id, text.slice(0, 20));
          driver.assistantChunks(id, text.slice(20));
          driver.assistantDone(assistantMessageFixture(sessionId, id, text));
          await waitFor(
            () => collected.events.filter((e) => e.type === 'assistant_done' && e.message.id === id).length === 1,
            'assistant_done',
          );

          const chunks = collected.events.filter((e) => e.type === 'assistant_chunk' && e.messageId === id);
          expect(chunks.length).toBeGreaterThan(0);
          const done = collected.events.filter((e) => e.type === 'assistant_done' && e.message.id === id);
          expect(done).toHaveLength(1);
          expect(done[0]?.type === 'assistant_done' ? done[0].message.text : '').toBe(text);

          const history = await adapter.getHistory(sessionId);
          expect(history.messages.find((m) => m.id === id)?.text).toBe(text);
          await adapter.dispose();
        },
      );

      it.skipIf(!capabilities.canSendNow)('sendNow emits exactly one user_message with the persisted text', async () => {
        const { adapter } = target.create({ messages: [] });
        await adapter.connect();
        const collected = collect(adapter);
        const text = 'A message sent by sendNow.';
        const result = await adapter.sendNow(sessionId, text);
        expect(result.ok).toBe(true);
        await waitFor(
          () => collected.events.filter((e) => e.type === 'user_message').length >= 1,
          'user_message',
        );

        const userEvents = collected.events.filter((e) => e.type === 'user_message');
        expect(userEvents).toHaveLength(1);
        expect(userEvents[0]?.type === 'user_message' ? userEvents[0].message.text : '').toBe(text);
        expect(userEvents[0]?.type === 'user_message' ? userEvents[0].message.role : '').toBe('user');

        const history = await adapter.getHistory(sessionId);
        expect(history.messages.filter((m) => m.role === 'user' && m.text === text)).toHaveLength(1);
        await adapter.dispose();
      });

      it('emits history_reset when history changed outside the normal events', async () => {
        const { adapter, driver } = target.create({ messages: [] });
        await adapter.connect();
        const collected = collect(adapter);
        driver.historyReset(sessionId);
        await waitFor(() => collected.events.some((e) => e.type === 'history_reset'), 'history_reset');
        expect(collected.events.filter((e) => e.type === 'history_reset')).toHaveLength(1);
        await adapter.dispose();
      });

      it('a throwing listener does not stop delivery to other listeners', async () => {
        const { adapter, driver } = target.create({ messages: [] });
        await adapter.connect();
        const seen: HostEvent[] = [];
        adapter.subscribe(() => {
          throw new Error('listener failure');
        });
        adapter.subscribe((event) => seen.push(event));
        driver.connection('reconnecting');
        await waitFor(() => seen.length > 0, 'delivery to the second listener');
        expect(seen[0]).toMatchObject({ type: 'connection', state: 'reconnecting' });
        await adapter.dispose();
      });
    });

    describe('injection and sending', () => {
      it.skipIf(!hasComposerProbe || !canStage)(
        'injectNextTurn keeps the text unmodified, separated by one blank line',
        async () => {
          const { adapter, driver } = target.create({ messages: [] });
          await adapter.connect();
          driver.setComposer?.('My own text.');
          const text = formatChangelogFence({
            id: 'inject',
            from: 1,
            to: 2,
            blocks: [{ search: 'a', replace: 'b' }],
          });
          const result = await adapter.injectNextTurn(sessionId, text);
          expect(result.ok).toBe(true);
          if (result.fidelity === 'context-only') expect(result.requiresUserSend).toBe(false);
          expect(driver.composer?.()).toBe(`My own text.\n\n${text}`);
          expect(driver.composer?.()).toContain(text);
          await adapter.dispose();
        },
      );

      it.skipIf(!hasComposerProbe || !canStage)('reports fidelity that matches the observed path', async () => {
        const { adapter } = target.create({ messages: [] });
        await adapter.connect();
        const text = formatChangelogFence({ id: 'fidelity', from: 1, to: 2, blocks: [{ search: 'a', replace: 'b' }] });
        const result = await adapter.injectNextTurn(sessionId, text);
        // 'persisted' may or may not need the user to send (composer vs prompt hook), and
        // 'context-only' with requiresUserSend true is allowed while persistence is unverified
        // (AI 8.2). Only the AI 8.1 reload test can confirm fidelity.
        expect(['persisted', 'context-only']).toContain(result.fidelity);
        expect(typeof result.requiresUserSend).toBe('boolean');
        await adapter.dispose();
      });

      it.skip('the AI 8.1 reload test was run and recorded in the adapter README (host-documented)', () => {});

      it.skipIf(target.createOversized === undefined)(
        'oversized text rejects payload_too_large and injects nothing',
        async () => {
          const create = target.createOversized;
          if (create === undefined) return;
          const { adapter, driver } = create(64);
          await adapter.connect();
          const before = await adapter.getHistory(sessionId);
          await expect(adapter.injectNextTurn(sessionId, 'x'.repeat(500))).rejects.toMatchObject({
            code: 'payload_too_large',
          });
          expect(driver.composer?.() ?? '').toBe('');
          const after = await adapter.getHistory(sessionId);
          expect(after.messages.length).toBe(before.messages.length);
          await adapter.dispose();
        },
      );
    });

    describe('wire formats with the adapter in the loop', () => {
      for (const testCase of target.changelogCases) {
        it(`${testCase.name} (${testCase.req})`, async () => {
          const built = buildChangelog(testCase.id, testCase.base, testCase.baseVersion, testCase.working);
          if (testCase.expect === 'changelog') {
            if (isChangelogError(built)) throw new Error(`unexpected ${built.error}: ${built.message}`);
            expect(built.blocks).toEqual(testCase.expectedBlocks);
            expect(validateChangelog(testCase.base, built.blocks)).toEqual({ ok: true });
            expect(applyChangelog(testCase.base, built.blocks)).toBe(testCase.working.replace(/\r\n/g, '\n'));
          } else {
            expect(isChangelogError(built)).toBe(true);
            if (isChangelogError(built)) {
              expect(built.error).toBe(testCase.expect);
              if (testCase.expectedConflict !== undefined) {
                expect(built.line).toBe(testCase.expectedConflict.line);
                expect(built.section).toBe(testCase.expectedConflict.section);
              }
            }
          }

          if (!canStage) return;
          const session = target.create({
            messages: historyForBase(sessionId, testCase.id, testCase.baseVersion, testCase.base),
          });
          await session.adapter.connect();
          const controller = new DraftSessionController({ adapter: session.adapter, saveDebounceMs: 60_000 });
          await controller.start();
          expect(controller.edit(testCase.id, testCase.working)).toBe(true);
          const result = await controller.stage();
          const injected = session.driver.composer?.() ?? '';

          if (testCase.expect === 'changelog') {
            expect(result.status).toBe('staged');
            const parsed = parseChangelogFences(injected);
            expect(parsed).toHaveLength(1);
            expect(parsed[0]?.id).toBe(testCase.id);
            expect(parsed[0]?.from).toBe(testCase.baseVersion);
            expect(parsed[0]?.to).toBe(testCase.baseVersion + 1);
            expect(applyChangelog(testCase.base, parsed[0]?.blocks ?? [])).toBe(
              testCase.working.replace(/\r\n/g, '\n'),
            );
            if (testCase.expectedBlocks !== undefined) expect(parsed[0]?.blocks).toEqual(testCase.expectedBlocks);
          } else if (testCase.expect === 'no_changes') {
            expect(result.status).toBe('nothing_to_stage');
          } else {
            expect(result.status).toBe('blocked');
          }
          await controller.dispose();
          await session.adapter.dispose();
        });
      }

      for (const testCase of target.rewriteCases) {
        it(`${testCase.name} (${testCase.req})`, async () => {
          const built = toRewriteRequest({
            id: testCase.id,
            rev: testCase.rev,
            body: testCase.body,
            range: testCase.selection,
            instruction: testCase.instruction,
          });
          expect(built.ok).toBe(true);
          if (!built.ok) return;
          expect(built.request.selection).toBe(testCase.expectedSelection);

          const message = formatRewriteMessage(built.request);
          expect(fenceLengthOf(message)).toBe(testCase.expectedFenceLength);
          if (testCase.expectedMessage !== undefined) expect(message).toBe(testCase.expectedMessage);
          expect(parseRewriteFences(message)[0]).toEqual(built.request);

          if (!capabilities.canSendNow) return;
          const session = target.create({
            messages: historyForBase(sessionId, testCase.id, testCase.rev, testCase.body),
          });
          await session.adapter.connect();
          const controller = new DraftSessionController({ adapter: session.adapter, saveDebounceMs: 60_000 });
          await controller.start();
          const result = await controller.sendRewrite({
            draftId: testCase.id,
            range: testCase.selection,
            instruction: testCase.instruction,
          });
          expect(result.status).toBe('sent');
          const history = await session.adapter.getHistory(sessionId);
          const last = history.messages[history.messages.length - 1];
          expect(last?.role).toBe('user');
          expect(last?.text).toBe(message);
          await controller.dispose();
          await session.adapter.dispose();
        });
      }

      it('a body containing a ``` code fence is wrapped in 4 or more backticks', () => {
        const text = formatDraftFence({ id: 'code', body: 'Before\n```sh\nnpm test\n```\nAfter' });
        expect(fenceLengthOf(text)).toBeGreaterThanOrEqual(4);
      });
    });

    describe.skipIf(!hasStorage)('storage', () => {
      it('save then load round-trips a WorkingCopy and remove deletes it', async () => {
        const { adapter } = target.create();
        await adapter.connect();
        const storage = adapter.storage;
        if (storage === undefined) throw new Error('hasHostStorage is true but storage is missing');
        const copy: WorkingCopy = {
          sessionId,
          draftId: 'stored',
          baseVersion: 1,
          baseHash: '00000000',
          text: 'Stored text.',
          updatedAt: '2026-01-01T00:00:00.000Z',
          stagedHash: '11111111',
        };
        await storage.save(copy);
        expect(await storage.load(sessionId, 'stored')).toEqual(copy);
        await storage.remove(sessionId, 'stored');
        expect(await storage.load(sessionId, 'stored')).toBeNull();
        await adapter.dispose();
      });

      it('isolates records per (sessionId, draftId) and lists by session', async () => {
        const { adapter } = target.create();
        await adapter.connect();
        const storage = adapter.storage;
        if (storage === undefined) throw new Error('hasHostStorage is true but storage is missing');
        const base = { baseVersion: 1, baseHash: '00000000', updatedAt: '2026-01-01T00:00:00.000Z' };
        await storage.save({ ...base, sessionId, draftId: 'a', text: 'A' });
        await storage.save({ ...base, sessionId, draftId: 'b', text: 'B' });
        await storage.save({ ...base, sessionId: 'other', draftId: 'a', text: 'Other A' });

        expect((await storage.load(sessionId, 'a'))?.text).toBe('A');
        expect((await storage.load(sessionId, 'b'))?.text).toBe('B');
        expect((await storage.load('other', 'a'))?.text).toBe('Other A');
        if (storage.list !== undefined) {
          expect((await storage.list(sessionId)).map((copy) => copy.draftId).sort()).toEqual(['a', 'b']);
        }
        await adapter.dispose();
      });
    });

    describe('host-documented items', () => {
      it('records the reload-test result for the adapter README', () => {
        const recorded = target.hostDocumented?.['reload-test'];
        if (recorded === undefined) {
          // Nothing recorded: the adapter must not claim fidelity 'persisted'.
          expect(capabilities.canRewritePersistedUserMessage).toBe(false);
        } else {
          expect(recorded.length).toBeGreaterThan(0);
        }
      });

      it.skip('composer separation was observed on the real host (host-documented)', () => {});
      it.skip('the host rejects oversized injection on its side (host-documented)', () => {});
    });
  });
}
