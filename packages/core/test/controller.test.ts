import { describe, expect, it } from 'vitest';

import {
  buildChangelog,
  DraftSessionController,
  formatChangelogFence,
  formatDraftFence,
  formatRewriteMessage,
  hashText,
  HostAdapterError,
  isChangelogError,
  type Message,
  type SessionSnapshot,
  type WorkingCopy,
} from '../src/index';
import { FakeClock, FakeHost, FakeHostStorage, flushMicrotasks } from './support/fake-host';
import type { FakeHostOptions } from './support/fake-host';

/**
 * T-22: the session controller with a fake adapter (requirements.md REQ-4, REQ-6,
 * REQ-7.2-7.4, REQ-9, REQ-10, REQ-12, REQ-13.1, REQ-16.2, REQ-19).
 */

const SESSION = 's1';
const BASE = '# Draft\n\nFirst line.\nSecond line.';
const EDITED = '# Draft\n\nFirst line.\nSecond line changed.';

function message(id: string, role: Message['role'], text: string, complete = true): Message {
  return { id, sessionId: SESSION, role, text, createdAt: '2026-01-01T00:00:00.000Z', complete };
}

function draftMessage(id: string, body: string, attrs: Partial<{ rev: string; title: string }> = {}): Message {
  return message(id, 'assistant', formatDraftFence({ id: 'd', body, ...attrs }));
}

interface Harness {
  host: FakeHost;
  storage: FakeHostStorage;
  clock: FakeClock;
  controller: DraftSessionController;
  snapshots: SessionSnapshot[];
  start(): Promise<void>;
}

function createHarness(options: FakeHostOptions = {}, history: Message[] = []): Harness {
  const storage = options.storage === null ? null : (options.storage ?? new FakeHostStorage());
  const host = new FakeHost({ sessionId: SESSION, messages: history, ...options, storage });
  const clock = new FakeClock();
  const controller = new DraftSessionController({ adapter: host, clock });
  const snapshots: SessionSnapshot[] = [];
  controller.subscribe((snapshot) => snapshots.push(snapshot));
  return {
    host,
    storage: storage as FakeHostStorage,
    clock,
    controller,
    snapshots,
    start: () => controller.start(),
  };
}

function plainHistory(): Message[] {
  return [message('u1', 'user', 'Write a draft.'), draftMessage('a1', BASE, { rev: '1', title: 'Draft' })];
}

function draftOf(snapshot: SessionSnapshot, id = 'd') {
  return snapshot.drafts.find((draft) => draft.draftId === id);
}

describe('REQ-4.1 controller lifecycle', () => {
  it('REQ-4.1 connects, subscribes, fetches history and rebuilds before reporting ready', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    const snapshot = harness.controller.getSnapshot();

    expect(harness.host.connectCalls).toBe(1);
    expect(harness.host.historyCalls).toBe(1);
    expect(harness.host.listenerCount).toBe(1);
    expect(snapshot.phase).toBe('ready');
    expect(snapshot.connection).toBe('connected');
    expect(snapshot.session).toEqual({ sessionId: SESSION, title: 'Fixture session' });
    expect(snapshot.storageMode).toBe('host');
    expect(snapshot.drafts.map((draft) => draft.draftId)).toEqual(['d']);
    expect(draftOf(snapshot)?.versions.map((v) => v.n)).toEqual([1]);
    expect(draftOf(snapshot)?.title).toBe('Draft');
    expect(draftOf(snapshot)?.lang).toBe('markdown');
    expect(draftOf(snapshot)?.editable).toBe(true);
  });

  it('REQ-4.1 start() is idempotent', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    await harness.start();
    expect(harness.host.connectCalls).toBe(1);
    expect(harness.host.historyCalls).toBe(1);
    expect(harness.host.listenerCount).toBe(1);
  });

  it('REQ-4.1 reports no active chat without failing', async () => {
    const harness = createHarness({ hasActiveSession: false });
    await harness.start();
    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.phase).toBe('ready');
    expect(snapshot.session).toBeNull();
    expect(snapshot.drafts).toEqual([]);
  });

  it('REQ-4.4 keeps the completeness of the fetched history in the snapshot', async () => {
    const harness = createHarness({ completeness: 'window' }, plainHistory());
    await harness.start();
    expect(harness.controller.getSnapshot().completeness).toBe('window');
  });

  it('REQ-19.1 turns a connect failure into a notice instead of rejecting start()', async () => {
    const harness = createHarness({ connectError: new HostAdapterError('permission_denied', 'denied') });
    await expect(harness.start()).resolves.toBeUndefined();
    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.phase).toBe('error');
    expect(snapshot.notices[0]).toMatchObject({ level: 'error', code: 'permission_denied', message: 'denied' });
  });

  it('REQ-19.1 turns a history failure into a notice and keeps the panel usable', async () => {
    const harness = createHarness({ historyError: new HostAdapterError('host_error', 'history failed') });
    await expect(harness.start()).resolves.toBeUndefined();
    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.phase).toBe('ready');
    expect(snapshot.notices[0]).toMatchObject({ code: 'host_error', message: 'history failed' });
  });

  it('REQ-19.2 refuses an adapter with an unsupported interface version', async () => {
    const harness = createHarness({ info: { interfaceVersion: '2' as unknown as '1' } }, plainHistory());
    await harness.start();
    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.phase).toBe('error');
    expect(snapshot.notices[0]?.code).toBe('unsupported_interface');
  });

  it('REQ-16.2 dispose() releases the host subscription', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    expect(harness.host.listenerCount).toBe(1);
    await harness.controller.dispose();
    expect(harness.host.listenerCount).toBe(0);
  });
});

describe('REQ-6 working copy and derived status', () => {
  it('REQ-6.2 creates a working copy with base version, base hash and text', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    expect(harness.controller.edit('d', EDITED)).toBe(true);

    const draft = draftOf(harness.controller.getSnapshot());
    expect(draft?.status).toBe('dirty');
    expect(draft?.workingCopy).toMatchObject({
      sessionId: SESSION,
      draftId: 'd',
      baseVersion: 1,
      baseHash: hashText(BASE),
      text: EDITED,
    });
    expect(draft?.workingCopy?.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('REQ-6.3 removes the working copy when the text equals the latest version again', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    harness.controller.edit('d', EDITED);
    harness.controller.edit('d', BASE);

    const draft = draftOf(harness.controller.getSnapshot());
    expect(draft?.workingCopy).toBeUndefined();
    expect(draft?.status).toBe('clean');
  });

  it('REQ-6.5 never presents a working copy as a committed version', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    harness.controller.edit('d', EDITED);
    const draft = draftOf(harness.controller.getSnapshot());
    expect(draft?.versions.map((v) => v.body)).toEqual([BASE]);
    expect(draft?.workingCopy?.text).toBe(EDITED);
  });

  it('REQ-6.2 refuses to edit an unknown draft and an open review', async () => {
    const harness = createHarness({}, [...plainHistory(), draftMessage('a2', EDITED)]);
    await harness.start();
    expect(harness.controller.edit('nope', 'text')).toBe(false);

    expect(harness.controller.openReview('d')).toBe(true);
    expect(harness.controller.edit('d', 'other text')).toBe(false);
  });

  it('REQ-6.6 discardChanges removes the working copy', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    harness.controller.edit('d', EDITED);
    harness.controller.discardChanges('d');
    const draft = draftOf(harness.controller.getSnapshot());
    expect(draft?.workingCopy).toBeUndefined();
    expect(draft?.status).toBe('clean');
  });
});

describe('REQ-9.1 staging (explicit only)', () => {
  it('REQ-9.1 does not stage anything without a stage() call', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    harness.controller.edit('d', EDITED);
    expect(harness.host.injected).toEqual([]);
  });

  it('REQ-9.2 sends the canonical changelog fence in one injectNextTurn call', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    harness.controller.edit('d', EDITED);

    const result = await harness.controller.stage();
    const built = buildChangelog('d', BASE, 1, EDITED);
    if (isChangelogError(built)) throw new Error('fixture must produce a changelog');

    expect(result.status).toBe('staged');
    expect(result.stagedDraftIds).toEqual(['d']);
    expect(result.fidelity).toBe('persisted');
    expect(result.requiresUserSend).toBe(true);
    expect(harness.host.injected).toHaveLength(1);
    expect(harness.host.lastInjectedText).toBe(formatChangelogFence(built));
    expect(harness.host.composer).toBe(formatChangelogFence(built));
  });

  it('REQ-9.3 records stagedHash and reports staged', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    harness.controller.edit('d', EDITED);
    await harness.controller.stage();

    const draft = draftOf(harness.controller.getSnapshot());
    expect(draft?.status).toBe('staged');
    expect(draft?.workingCopy?.stagedHash).toBe(hashText(harness.host.lastInjectedText as string));
  });

  it('REQ-9.4 does not re-stage a changelog that is already staged', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    harness.controller.edit('d', EDITED);
    await harness.controller.stage();
    const result = await harness.controller.stage();
    expect(result.status).toBe('nothing_to_stage');
    expect(harness.host.injected).toHaveLength(1);
  });

  it('REQ-9.5 marks a draft staged-stale when edited after staging', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    harness.controller.edit('d', EDITED);
    await harness.controller.stage();
    harness.controller.edit('d', `${EDITED}\nOne more line.`);

    const draft = draftOf(harness.controller.getSnapshot());
    expect(draft?.status).toBe('staged-stale');
    expect(draft?.editable).toBe(true);
  });

  it('REQ-9.2 stages several drafts in order, joined by one blank line', async () => {
    const history = [message('u1', 'user', 'Two drafts.'), message('a1', 'assistant', [
      formatDraftFence({ id: 'one', body: 'one v1' }),
      formatDraftFence({ id: 'two', body: 'two v1' }),
    ].join('\n\n'))];
    const harness = createHarness({}, history);
    await harness.start();
    harness.controller.edit('one', 'one v2');
    harness.controller.edit('two', 'two v2');

    const result = await harness.controller.stage();
    expect(result.stagedDraftIds).toEqual(['one', 'two']);
    const text = harness.host.lastInjectedText as string;
    expect(text.indexOf('id="one"')).toBeLessThan(text.indexOf('id="two"'));
    expect(text).toContain('```\n\n```draft-changelog id="two"');
  });

  it('REQ-8.5 refuses to stage a draft whose changelog has a marker conflict', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    harness.controller.edit('d', 'heading\n=======');

    const result = await harness.controller.stage();
    expect(result.status).toBe('blocked');
    expect(result.blockedDraftIds).toEqual(['d']);
    expect(harness.host.injected).toEqual([]);
    expect(draftOf(harness.controller.getSnapshot())?.changelogError?.error).toBe('marker_conflict');
    expect(harness.controller.getSnapshot().notices.map((n) => n.code)).toContain('marker_conflict');
  });

  it('REQ-9.6 refuses text over the host byte cap without calling the host', async () => {
    const harness = createHarness({ capabilities: { maxInjectBytes: 20 } }, plainHistory());
    await harness.start();
    harness.controller.edit('d', EDITED);

    const result = await harness.controller.stage();
    expect(result.status).toBe('too_large');
    expect(harness.host.injected).toEqual([]);
    expect(harness.controller.getSnapshot().notices.map((n) => n.code)).toContain('too_large');
  });

  it('REQ-19.1 reports an inject failure as a notice and a status, not a throw', async () => {
    const harness = createHarness({ injectError: new HostAdapterError('host_error', 'slow down') }, plainHistory());
    await harness.start();
    harness.controller.edit('d', EDITED);

    const result = await harness.controller.stage();
    expect(result.status).toBe('error');
    expect(result.message).toBe('slow down');
    const notices = harness.controller.getSnapshot().notices;
    expect(notices.some((n) => n.code === 'host_error' && n.message === 'slow down')).toBe(true);
    expect(draftOf(harness.controller.getSnapshot())?.workingCopy?.stagedHash).toBeUndefined();
  });

  it('REQ-9.1 reports nothing_to_stage when there are no edits and no_session without a chat', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    expect((await harness.controller.stage()).status).toBe('nothing_to_stage');

    const noSession = createHarness({ hasActiveSession: false });
    await noSession.start();
    expect((await noSession.controller.stage()).status).toBe('no_session');
  });

  it('REQ-9.1 stages the latest committed version as the base after a rebuild', async () => {
    const harness = createHarness({}, [...plainHistory(), draftMessage('a2', EDITED)]);
    await harness.start();
    harness.controller.edit('d', `${EDITED}\nNew tail.`);
    await harness.controller.stage();

    const text = harness.host.lastInjectedText as string;
    expect(text).toContain('from="2" to="3"');
    expect(text).toContain('New tail.');
  });
});

describe('REQ-10 sent detection', () => {
  it('REQ-10.1 marks a working copy sent when the user message carries its changelog', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    harness.controller.edit('d', EDITED);
    await harness.controller.stage();
    harness.host.sendUserMessage(harness.host.composer);

    const draft = draftOf(harness.controller.getSnapshot());
    expect(draft?.status).toBe('sent');
    expect(draft?.workingCopy?.sentHash).toBe(hashText(harness.host.composer));
  });

  it('REQ-10.1 ignores a changelog whose from does not equal the working-copy base', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    harness.controller.edit('d', EDITED);
    await harness.controller.stage();
    const stale = formatChangelogFence({ id: 'd', from: 2, to: 3, blocks: [{ search: 'x', replace: 'y' }] });
    harness.host.sendUserMessage(`Note.\n\n${stale}`);

    expect(draftOf(harness.controller.getSnapshot())?.status).toBe('staged');
  });

  it('REQ-10.3 uses the last changelog of an id in one user message', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    harness.controller.edit('d', EDITED);
    await harness.controller.stage();

    const wrong = formatChangelogFence({ id: 'd', from: 1, to: 2, blocks: [{ search: 'First line.', replace: 'Other.' }] });
    const right = formatChangelogFence({ id: 'd', from: 1, to: 2, blocks: [{ search: 'First line.', replace: 'Final.' }] });
    harness.host.sendUserMessage(`${wrong}\n\n${right}`);

    expect(draftOf(harness.controller.getSnapshot())?.workingCopy?.sentHash).toBe(hashText(right));
  });

  it('REQ-10.2 a sent working copy is not staged again', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    harness.controller.edit('d', EDITED);
    await harness.controller.stage();
    harness.host.sendUserMessage(harness.host.composer);
    expect((await harness.controller.stage()).status).toBe('nothing_to_stage');
  });
});

describe('REQ-12.2 selection rewrite through the controller', () => {
  function fullRange(body: string) {
    const lines = body.split('\n');
    return { startLine: 1, startOffset: 0, endLine: lines.length, endOffset: (lines[lines.length - 1] as string).length };
  }

  it('REQ-12.2 sends the rewrite message with sendNow and records a pending rewrite', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();

    const result = await harness.controller.sendRewrite({
      draftId: 'd',
      range: fullRange(BASE),
      instruction: 'Make it friendlier.',
    });
    expect(result.status).toBe('sent');
    expect(harness.host.sent).toHaveLength(1);
    expect(harness.host.sent[0]?.text.startsWith('```draft-rewrite id="d" rev="1"')).toBe(true);
    expect(harness.host.sent[0]?.text).toContain('\n\nMake it friendlier.');
    expect(draftOf(harness.controller.getSnapshot())?.pendingRewrite).toMatchObject({ rev: 1 });
  });

  // Known gap (reported, not fixed): a conformant adapter may queue the
  // `user_message` for a sendNow in a microtask (ADAPTER_INTERFACE section 5).
  // That event arrives before `sendRewrite`'s continuation stores the pending
  // rewrite, which then overwrites the confirmed entry with `confirmed: false`.
  // The review still opens (REQ-12.8, first half) but the "reply had no new
  // version" notice (REQ-12.8, second half) is lost.
  it('REQ-12.8 keeps a rewrite confirmed when the host echoes the user message in the same tick [known gap: REQ-12.8]', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    await harness.controller.sendRewrite({ draftId: 'd', range: fullRange(BASE), instruction: 'Rewrite.' });
    await flushMicrotasks();
    expect(draftOf(harness.controller.getSnapshot())?.pendingRewrite).toMatchObject({ rev: 1, confirmed: true });
  });

  it('REQ-12.2 formats the whole-document rewrite message exactly', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    await harness.controller.sendRewrite({ draftId: 'd', range: fullRange(BASE), instruction: 'Tighten.' });

    const text = harness.host.sent[0]?.text as string;
    expect(text).toBe(
      [
        '```draft-rewrite id="d" rev="1" start_line="1" end_line="4" start_offset="0" end_offset="12"',
        '# Draft',
        '',
        'First line.',
        'Second line.',
        '```',
        '',
        'Tighten.',
      ].join('\n'),
    );
  });

  it('REQ-12.5 maps a selection of unchanged working-copy text back to the base', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    harness.controller.edit('d', `Inserted at the top.\n${BASE}`);

    const result = await harness.controller.sendRewrite({
      draftId: 'd',
      range: { startLine: 2, startOffset: 0, endLine: 2, endOffset: 7 },
      instruction: 'Shorten the heading.',
    });
    expect(result.status).toBe('sent');
    expect(harness.host.sent[0]?.text).toContain('rev="1" start_line="1" end_line="1" start_offset="0" end_offset="7"');
    expect(harness.host.sent[0]?.text).toContain('\n# Draft\n');
  });

  it('REQ-12.5 refuses a selection that overlaps the user edits', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    harness.controller.edit('d', EDITED);

    const result = await harness.controller.sendRewrite({
      draftId: 'd',
      range: { startLine: 4, startOffset: 0, endLine: 4, endOffset: 8 },
      instruction: 'Change this.',
    });
    expect(result.status).toBe('overlaps_edits');
    expect(harness.host.sent).toEqual([]);
  });

  it('REQ-12.6 refuses an empty instruction', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    const result = await harness.controller.sendRewrite({ draftId: 'd', range: fullRange(BASE), instruction: '  ' });
    expect(result.status).toBe('empty_instruction');
    expect(harness.host.sent).toEqual([]);
  });

  it('REQ-12.7 falls back to the composer when the host cannot send now', async () => {
    const harness = createHarness({ capabilities: { canSendNow: false } }, plainHistory());
    await harness.start();
    expect(harness.controller.getSnapshot().rewrite).toBe('compose');

    const result = await harness.controller.sendRewrite({
      draftId: 'd',
      range: fullRange(BASE),
      instruction: 'Compose it.',
    });
    expect(result.status).toBe('queued_in_composer');
    expect(harness.host.sent).toEqual([]);
    expect(harness.host.composer.startsWith('```draft-rewrite ')).toBe(true);
  });

  it('REQ-12.7 reports unavailable when the host cannot send or compose', async () => {
    const harness = createHarness(
      { capabilities: { canSendNow: false, canAppendToComposer: false, canRewritePersistedUserMessage: false } },
      plainHistory(),
    );
    await harness.start();
    expect(harness.controller.getSnapshot().rewrite).toBe('unavailable');
    const result = await harness.controller.sendRewrite({ draftId: 'd', range: fullRange(BASE), instruction: 'x' });
    expect(result.status).toBe('unavailable');
  });

  it('REQ-12.5 refuses a rewrite while the working copy is based on an older version', async () => {
    const storage = new FakeHostStorage();
    const harness = createHarness({ storage }, [...plainHistory(), draftMessage('a2', EDITED)]);
    await storage.save({
      sessionId: SESSION,
      draftId: 'd',
      baseVersion: 1,
      baseHash: hashText(BASE),
      text: 'edited against v1',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    await harness.start();
    const result = await harness.controller.sendRewrite({
      draftId: 'd',
      range: { startLine: 1, startOffset: 0, endLine: 1, endOffset: 5 },
      instruction: 'x',
    });
    expect(result.status).toBe('stale_base');
    expect(harness.host.sent).toEqual([]);
  });

  it('REQ-19.1 reports a sendNow failure as a notice, not a throw', async () => {
    const harness = createHarness({ sendError: new HostAdapterError('host_error', 'send failed') }, plainHistory());
    await harness.start();
    const result = await harness.controller.sendRewrite({
      draftId: 'd',
      range: fullRange(BASE),
      instruction: 'x',
    });
    expect(result.status).toBe('error');
    expect(harness.controller.getSnapshot().notices.some((n) => n.message === 'send failed')).toBe(true);
  });

  it('REQ-12.8 moves straight to the new version with a notice when the reply to a rewrite arrives (0.1.9)', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    await harness.controller.sendRewrite({ draftId: 'd', range: fullRange(BASE), instruction: 'Rewrite.' });
    await flushMicrotasks();

    harness.host.finishAssistant(formatDraftFence({ id: 'd', body: 'Rewritten.' }));
    const snapshot = harness.controller.getSnapshot() as SessionSnapshot;
    const draft = draftOf(snapshot);
    expect(draft?.versions.map((v) => v.n)).toEqual([1, 2]);
    expect(draft?.review).toBeUndefined();
    expect(draft?.pendingRewrite).toBeUndefined();
    expect(snapshot.notices.some((n) => n.code === 'version_updated' && n.message === 'Updated to version 2.')).toBe(true);
  });

  it('drops sent edits and shows the new version when the user did not edit after sending (0.1.9)', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    harness.controller.edit('d', EDITED);
    await harness.controller.sendAll({ comments: [] });
    harness.host.finishAssistant(formatDraftFence({ id: 'd', body: `${EDITED}\nAgent line.` }));
    const draft = draftOf(harness.controller.getSnapshot() as SessionSnapshot);
    expect(draft?.review).toBeUndefined();
    expect(draft?.workingCopy).toBeUndefined();
    expect(draft?.status).toBe('clean');
  });

  it('still opens a review when the user edited again after sending (0.1.9)', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    harness.controller.edit('d', EDITED);
    await harness.controller.sendAll({ comments: [] });
    harness.controller.edit('d', `${EDITED}\nA later edit, not sent.`);
    harness.host.finishAssistant(formatDraftFence({ id: 'd', body: `${EDITED}\nAgent line.` }));
    const draft = draftOf(harness.controller.getSnapshot() as SessionSnapshot);
    expect(draft?.review).toMatchObject({ rightVersion: 2, leftLabel: 'Your changes' });
  });

  it('REQ-12.8 shows a notice when the reply to a rewrite has no new version', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    // The user sends the rewrite fence themselves: core sees a confirmed pending rewrite.
    harness.host.sendUserMessage(
      formatRewriteMessage({
        id: 'd',
        rev: 1,
        startLine: 1,
        endLine: 1,
        startOffset: 0,
        endOffset: 7,
        selection: '# Draft',
        instruction: 'Rewrite the heading.',
      }),
    );
    expect(draftOf(harness.controller.getSnapshot())?.pendingRewrite).toMatchObject({ rev: 1, confirmed: true });

    harness.host.finishAssistant('Sorry, I cannot do that.');
    const notices = harness.controller.getSnapshot().notices;
    expect(notices.some((n) => n.code === 'rewrite_unanswered' && n.draftId === 'd')).toBe(true);
    expect(draftOf(harness.controller.getSnapshot())?.pendingRewrite).toBeUndefined();
  });
});

describe('REQ-13.1 / REQ-13.3 review', () => {
  it('REQ-13.1 opens a review against the working copy when a new version arrives', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    harness.controller.edit('d', EDITED);
    harness.host.finishAssistant(formatDraftFence({ id: 'd', body: 'Model version two.' }));

    const draft = draftOf(harness.controller.getSnapshot());
    expect(draft?.review).toMatchObject({ leftText: EDITED, leftLabel: 'Your changes', rightVersion: 2, rightText: 'Model version two.' });
    expect(draft?.review?.hunks.length).toBeGreaterThan(0);
    expect(draft?.review?.decisions.every((decision) => decision === null)).toBe(true);
    expect(draft?.editable).toBe(false);
  });

  it('REQ-13.3 accepting everything removes the working copy', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    harness.controller.edit('d', EDITED);
    harness.host.finishAssistant(formatDraftFence({ id: 'd', body: 'Model version two.' }));

    harness.controller.setAllReviewDecisions('d', 'accept');
    expect(harness.controller.finishReview('d')).toBe(true);

    const draft = draftOf(harness.controller.getSnapshot());
    expect(draft?.workingCopy).toBeUndefined();
    expect(draft?.status).toBe('clean');
    expect(draft?.review).toBeUndefined();
  });

  it('REQ-13.3 rejecting everything keeps the previous text as a working copy against the new version', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    harness.controller.edit('d', EDITED);
    harness.host.finishAssistant(formatDraftFence({ id: 'd', body: 'Model version two.' }));

    harness.controller.setAllReviewDecisions('d', 'reject');
    harness.controller.finishReview('d');

    const draft = draftOf(harness.controller.getSnapshot());
    expect(draft?.workingCopy).toMatchObject({ baseVersion: 2, text: EDITED, baseHash: hashText('Model version two.') });
    expect(draft?.status).toBe('dirty');
  });

  it('REQ-13.3 a partially accepted review stores the combined text', async () => {
    const left = 'a\nb\nc\nd';
    const right = 'a\nB\nc\nD';
    const history = [message('u1', 'user', 'draft'), draftMessage('a1', left)];
    const harness = createHarness({}, history);
    await harness.start();
    harness.controller.edit('d', `${left}\nedit`);
    harness.host.finishAssistant(formatDraftFence({ id: 'd', body: right }));

    harness.controller.setReviewDecision('d', 0, 'accept');
    harness.controller.finishReview('d');
    expect(draftOf(harness.controller.getSnapshot())?.workingCopy?.text).toBe('a\nB\nc\nd\nedit');
  });

  it('REQ-13.4 never modifies a committed version when the review finishes', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    harness.controller.edit('d', EDITED);
    harness.host.finishAssistant(formatDraftFence({ id: 'd', body: 'Model version two.' }));
    const before = draftOf(harness.controller.getSnapshot())?.versions.map((v) => ({ ...v }));

    harness.controller.setAllReviewDecisions('d', 'reject');
    harness.controller.finishReview('d');

    expect(draftOf(harness.controller.getSnapshot())?.versions.map((v) => ({ ...v }))).toEqual(before);
  });

  it('REQ-13.1 opens a review on demand between the last two committed versions', async () => {
    const harness = createHarness({}, [...plainHistory(), draftMessage('a2', EDITED)]);
    await harness.start();
    expect(harness.controller.openReview('d')).toBe(true);
    expect(draftOf(harness.controller.getSnapshot())?.review).toMatchObject({ leftText: BASE, rightText: EDITED });
    harness.controller.cancelReview('d');
    expect(draftOf(harness.controller.getSnapshot())?.review).toBeUndefined();
  });

  it('REQ-13.1 has nothing to review with a single version and no working copy', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    expect(harness.controller.openReview('d')).toBe(false);
    expect(harness.controller.finishReview('d')).toBe(false);
  });

  it('REQ-13.3 ignores a decision for a hunk that does not exist', async () => {
    const harness = createHarness({}, [...plainHistory(), draftMessage('a2', EDITED)]);
    await harness.start();
    harness.controller.openReview('d');
    const before = draftOf(harness.controller.getSnapshot())?.review?.decisions;
    harness.controller.setReviewDecision('d', 99, 'accept');
    expect(draftOf(harness.controller.getSnapshot())?.review?.decisions).toEqual(before);
  });
});

describe('REQ-16.2 visibility gating and catch-up', () => {
  it('REQ-16.1 renders no previews and notifies nobody while hidden', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    await harness.controller.setActive(false);
    const calls = harness.snapshots.length;

    harness.host.streamChunk('a2', '```draft id="streamed"\nbody\n');
    expect(harness.snapshots.length).toBe(calls);
    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.active).toBe(false);
    expect(draftOf(snapshot, 'streamed')).toBeUndefined();
  });

  it('REQ-16.2 performs one history fetch and rebuild when it becomes visible again', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    const before = harness.host.historyCalls;
    await harness.controller.setActive(false);
    harness.host.finishAssistant(formatDraftFence({ id: 'd', body: 'Arrived while hidden.' }));
    await harness.controller.setActive(true);

    expect(harness.host.historyCalls).toBe(before + 1);
    const draft = draftOf(harness.controller.getSnapshot());
    expect(draft?.versions.map((v) => v.body)).toEqual([BASE, 'Arrived while hidden.']);
    expect(harness.controller.getSnapshot().active).toBe(true);
  });

  it('REQ-16.3 treats active === undefined as visible', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    await harness.controller.setActive(false);
    await harness.controller.setActive(undefined);
    expect(harness.controller.getSnapshot().active).toBe(true);
  });

  it('REQ-16.2 does not refetch when it becomes visible without missed events', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    const before = harness.host.historyCalls;
    await harness.controller.setActive(false);
    await harness.controller.setActive(true);
    expect(harness.host.historyCalls).toBe(before);
  });
});

describe('REQ-7.2-7.4 working-copy storage', () => {
  it('REQ-7.4 saves at most once per 500 ms per draft and flushes on demand', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    harness.controller.edit('d', 'one');
    harness.controller.edit('d', 'two');
    harness.controller.edit('d', 'three');
    expect(harness.clock.pendingTimers).toBe(1);

    await harness.clock.advance(499);
    expect(harness.storage.saveCalls).toBe(0);
    await harness.clock.advance(1);
    expect(harness.storage.saveCalls).toBe(1);
    expect(harness.storage.copies.get(`${SESSION}\u0000d`)?.text).toBe('three');

    harness.controller.edit('d', 'four');
    await harness.controller.flush();
    expect(harness.storage.copies.get(`${SESSION}\u0000d`)?.text).toBe('four');
  });

  it('REQ-7.2 restores a stored working copy when the panel mounts again', async () => {
    const storage = new FakeHostStorage();
    const stored: WorkingCopy = {
      sessionId: SESSION,
      draftId: 'd',
      baseVersion: 1,
      baseHash: hashText(BASE),
      text: 'Restored edit.',
      updatedAt: '2026-01-02T00:00:00.000Z',
    };
    await storage.save(stored);

    const harness = createHarness({ storage }, plainHistory());
    await harness.start();
    const draft = draftOf(harness.controller.getSnapshot());
    expect(draft?.workingCopy?.text).toBe('Restored edit.');
    expect(draft?.status).toBe('dirty');
  });

  it('REQ-7.3 keeps the working copy in memory and adds a notice when storage fails', async () => {
    const storage = new FakeHostStorage();
    const harness = createHarness({ storage }, plainHistory());
    await harness.start();
    storage.failSave = new Error('quota exceeded');
    harness.controller.edit('d', EDITED);
    await harness.controller.flush();

    const snapshot = harness.controller.getSnapshot();
    expect(snapshot.notices.some((n) => n.code === 'storage_error')).toBe(true);
    expect(draftOf(snapshot)?.workingCopy?.text).toBe(EDITED);
  });

  it('REQ-7.3 uses memory storage when the host provides none', async () => {
    const harness = createHarness({ storage: null }, plainHistory());
    await harness.start();
    expect(harness.controller.getSnapshot().storageMode).toBe('memory');
    harness.controller.edit('d', EDITED);
    await harness.controller.flush();
    expect(draftOf(harness.controller.getSnapshot())?.workingCopy?.text).toBe(EDITED);
  });

  it('REQ-4.5 marks a working copy stale when the base version is no longer the latest', async () => {
    const storage = new FakeHostStorage();
    const harness = createHarness({ storage }, [...plainHistory(), draftMessage('a2', EDITED)]);
    await storage.save({
      sessionId: SESSION,
      draftId: 'd',
      baseVersion: 1,
      baseHash: hashText(BASE),
      text: 'Old edit.',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    await harness.start();

    const draft = draftOf(harness.controller.getSnapshot());
    expect(draft?.status).toBe('stale-base');
    expect(draft?.staleReason).toBe('newer_version');
    expect(draft?.editable).toBe(false);
  });

  it('REQ-4.5 marks a working copy stale when its base version is missing', async () => {
    const storage = new FakeHostStorage();
    const harness = createHarness({ storage }, plainHistory());
    await storage.save({
      sessionId: SESSION,
      draftId: 'd',
      baseVersion: 4,
      baseHash: hashText('gone'),
      text: 'Orphan edit.',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    await harness.start();
    expect(draftOf(harness.controller.getSnapshot())?.staleReason).toBe('base_missing');
  });

  it('REQ-4.5 marks a working copy stale when the base body hash differs', async () => {
    const storage = new FakeHostStorage();
    const harness = createHarness({ storage }, plainHistory());
    await storage.save({
      sessionId: SESSION,
      draftId: 'd',
      baseVersion: 1,
      baseHash: hashText('different base'),
      text: 'Edit.',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    await harness.start();
    expect(draftOf(harness.controller.getSnapshot())?.staleReason).toBe('base_changed');
  });

  it('REQ-4.5 review against the latest version for a stale working copy', async () => {
    const storage = new FakeHostStorage();
    const harness = createHarness({ storage }, [...plainHistory(), draftMessage('a2', EDITED)]);
    await storage.save({
      sessionId: SESSION,
      draftId: 'd',
      baseVersion: 1,
      baseHash: hashText(BASE),
      text: 'Old edit.',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    await harness.start();
    expect(harness.controller.openReview('d')).toBe(true);
    expect(draftOf(harness.controller.getSnapshot())?.review).toMatchObject({
      leftText: 'Old edit.',
      leftLabel: 'Your changes',
      rightVersion: 2,
    });
  });

  it('REQ-4.6 restores sent state from a changelog in the stored history', async () => {
    const changelog = formatChangelogFence({
      id: 'd',
      from: 1,
      to: 2,
      blocks: [{ search: 'First line.', replace: 'First line changed.' }],
    });
    const history = [
      message('u1', 'user', 'Write a draft.'),
      draftMessage('a1', BASE),
      message('u2', 'user', `Please use this.\n\n${changelog}`),
    ];
    const storage = new FakeHostStorage();
    await storage.save({
      sessionId: SESSION,
      draftId: 'd',
      baseVersion: 1,
      baseHash: hashText(BASE),
      text: BASE.replace('First line.', 'First line changed.'),
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    const harness = createHarness({ storage }, history);
    await harness.start();

    const draft = draftOf(harness.controller.getSnapshot());
    expect(draft?.versions).toHaveLength(1);
    expect(draft?.status).toBe('sent');
    expect(draft?.workingCopy?.sentHash).toBe(hashText(changelog));
  });

  it('REQ-4.6 does not create versions from changelogs in user messages', async () => {
    const changelog = formatChangelogFence({ id: 'only-user', from: 1, to: 2, blocks: [{ search: 'a', replace: 'b' }] });
    const harness = createHarness({}, [message('u1', 'user', changelog)]);
    await harness.start();
    expect(harness.controller.getSnapshot().drafts).toEqual([]);
  });
});

describe('REQ-5 streaming previews in the controller', () => {
  it('REQ-5.1 shows a preview while streaming and commits only at assistant_done', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    harness.host.streamChunk('a2', 'Writing.\n```draft id="d"\nNew body\n');
    let draft = draftOf(harness.controller.getSnapshot());
    expect(draft?.preview).toMatchObject({ draftId: 'd', body: 'New body', closed: false });
    expect(draft?.versions.map((v) => v.body)).toEqual([BASE]);

    harness.host.finishAssistant(formatDraftFence({ id: 'd', body: 'New body' }), { id: 'a2' });
    draft = draftOf(harness.controller.getSnapshot());
    expect(draft?.preview).toBeUndefined();
    expect(draft?.versions.map((v) => v.body)).toEqual([BASE, 'New body']);
  });

  it('REQ-5.3 discards an unclosed fence and shows a notice naming the draft', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    harness.host.finishAssistant('```draft id="unfinished"\nNo closing fence.');

    const snapshot = harness.controller.getSnapshot();
    expect(draftOf(snapshot, 'unfinished')).toBeUndefined();
    const notice = snapshot.notices.find((n) => n.code === 'unclosed_draft');
    expect(notice?.draftId).toBe('unfinished');
    expect(notice?.message).toContain('unfinished');
  });
});

describe('REQ-4.1 / REQ-19.3 reconnection and history reset', () => {
  it('REQ-19.3 reports connection state and rebuilds after reconnecting', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    harness.host.setConnection('reconnecting');
    expect(harness.controller.getSnapshot().connection).toBe('reconnecting');

    const before = harness.host.historyCalls;
    harness.host.setConnection('connected');
    await flushMicrotasks();
    expect(harness.controller.getSnapshot().connection).toBe('connected');
    expect(harness.host.historyCalls).toBe(before + 1);
  });

  it('REQ-4.1 refetches history on history_reset', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    harness.host.setMessages(SESSION, [...plainHistory(), draftMessage('a2', 'After reset.')]);
    const before = harness.host.historyCalls;
    harness.host.emitHistoryReset();
    await flushMicrotasks();

    expect(harness.host.historyCalls).toBe(before + 1);
    expect(draftOf(harness.controller.getSnapshot())?.versions.map((v) => v.body)).toEqual([BASE, 'After reset.']);
  });

  it('REQ-4.3 rebuilds when an assistant_done repeats a message id with different text', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    harness.host.setMessages(SESSION, [message('u1', 'user', 'Write a draft.'), draftMessage('a1', 'Changed text.')]);
    const before = harness.host.historyCalls;
    harness.host.finishAssistant(formatDraftFence({ id: 'd', body: 'Changed text.' }), { id: 'a1' });
    await flushMicrotasks();

    expect(harness.host.historyCalls).toBe(before + 1);
    expect(draftOf(harness.controller.getSnapshot())?.versions.map((v) => v.body)).toEqual(['Changed text.']);
  });

  it('REQ-19.3 ignores history_reset for another session', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    const before = harness.host.historyCalls;
    harness.host.emitHistoryReset('other-session');
    await flushMicrotasks();
    expect(harness.host.historyCalls).toBe(before);
  });
});

describe('REQ-4.1 session switching', () => {
  it('REQ-4.1 drops in-memory state when the session changes', async () => {
    const host = new FakeHost({ sessionId: SESSION, messages: plainHistory(), storage: new FakeHostStorage() });
    host.sessions.push({ sessionId: 's2', title: 'Second' });
    host.transcript.set('s2', [
      { ...message('u2', 'user', 'Other chat.'), sessionId: 's2' },
      { ...draftMessage('b1', 'Second session draft.'), sessionId: 's2' },
    ]);
    const clock = new FakeClock();
    const controller = new DraftSessionController({ adapter: host, clock });
    await controller.start();
    expect(controller.getSnapshot().drafts.map((d) => d.draftId)).toEqual(['d']);

    host.setActiveSession({ sessionId: 's2', title: 'Second' });
    await flushMicrotasks();
    const snapshot = controller.getSnapshot();
    expect(snapshot.session?.sessionId).toBe('s2');
    expect(snapshot.drafts.map((d) => d.draftId)).toEqual(['d']);
    expect(snapshot.drafts[0]?.versions.map((v) => v.body)).toEqual(['Second session draft.']);
  });

  it('REQ-4.1 selects a session from the list', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    await harness.controller.selectSession({ sessionId: SESSION, title: 'Picked' });
    expect(harness.controller.getSnapshot().session?.title).toBe('Picked');
    expect(harness.controller.getSnapshot().sessions).toHaveLength(1);
  });
});

describe('REQ-19.1 notice handling', () => {
  it('REQ-19.1 deduplicates identical notices and lets the user dismiss one', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    harness.host.finishAssistant('```draft id="open"\nno close');
    harness.host.emitHistoryReset();
    await flushMicrotasks();

    const notices = harness.controller.getSnapshot().notices.filter((n) => n.code === 'unclosed_draft');
    expect(notices).toHaveLength(1);
    harness.controller.dismissNotice(notices[0]?.id as string);
    expect(harness.controller.getSnapshot().notices.some((n) => n.code === 'unclosed_draft')).toBe(false);
  });
});

describe('REQ-1.4 / REQ-4.1 id-less draft fences reach the panel', () => {
  const idless = (body: string): string => `\`\`\`draft\n${body}\n\`\`\``;

  it('REQ-4.1 shows an id-less draft from the fetched history as draft-1', async () => {
    const harness = createHarness({}, [message('u1', 'user', 'Write.'), message('a1', 'assistant', idless('Line one.\nLine two.'))]);
    await harness.start();
    const draft = draftOf(harness.controller.getSnapshot(), 'draft-1');
    expect(draft?.versions.map((v) => [v.n, v.body])).toEqual([[1, 'Line one.\nLine two.']]);
  });

  it('REQ-5.1 previews an id-less draft while streaming and commits it as draft-1 at assistant_done', async () => {
    const harness = createHarness({}, [message('u1', 'user', 'Write.')]);
    await harness.start();
    harness.host.streamChunk('a1', 'Here:\n```draft\nStreaming\n');
    expect(draftOf(harness.controller.getSnapshot(), 'draft-1')?.preview).toMatchObject({ draftId: 'draft-1', closed: false });

    harness.host.finishAssistant(idless('Streaming done'), { id: 'a1' });
    const draft = draftOf(harness.controller.getSnapshot(), 'draft-1');
    expect(draft?.preview).toBeUndefined();
    expect(draft?.versions.map((v) => v.body)).toEqual(['Streaming done']);

    harness.host.finishAssistant(idless('Second try'), { id: 'a2' });
    expect(draftOf(harness.controller.getSnapshot(), 'draft-1')?.versions.map((v) => [v.n, v.body])).toEqual([
      [1, 'Streaming done'],
      [2, 'Second try'],
    ]);
  });
});

describe('sendAll: edits and comments in one message (0.1.7)', () => {
  it('sends the changelog first, then a comment on the edited text with rev = to', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    harness.controller.edit('d', EDITED);
    const result = await harness.controller.sendAll({
      comments: [
        {
          draftId: 'd',
          range: { startLine: 4, startOffset: 12, endLine: 4, endOffset: 19 },
          quote: 'changed',
          instruction: 'Pick a stronger word.',
        },
      ],
    });
    expect(result.status).toBe('sent');
    expect(harness.host.sent).toHaveLength(1);
    const text = harness.host.sent[0]?.text ?? '';
    expect(text.indexOf('```draft-changelog id="d" from="1" to="2"')).toBe(0);
    expect(text).toContain('```draft-rewrite id="d" rev="2" start_line="4" end_line="4" start_offset="12" end_offset="19"');
    expect(text.trimEnd().endsWith('Pick a stronger word.')).toBe(true);
    const draft = draftOf(harness.controller.getSnapshot() as SessionSnapshot);
    expect(draft?.status).toBe('sent');
    // The answer will be version 2, so the pending rewrite counts from version 1.
    expect(draft?.pendingRewrite?.rev).toBe(1);
  });

  it('finds a comment again after the user edits text above it', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    const comment = {
      draftId: 'd',
      range: { startLine: 4, startOffset: 0, endLine: 4, endOffset: 6 },
      quote: 'Second',
      instruction: 'Shorter.',
    };
    harness.controller.edit('d', '# Draft\n\nAn extra line.\nFirst line.\nSecond line.');
    const result = await harness.controller.sendAll({ comments: [comment] });
    expect(result.status).toBe('sent');
    expect(harness.host.sent[0]?.text).toContain('rev="2" start_line="5"');
  });

  it('refuses a comment whose text was edited away', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    harness.controller.edit('d', '# Draft\n\nFirst line.\nAnother line.');
    const result = await harness.controller.sendAll({
      comments: [
        { draftId: 'd', range: { startLine: 4, startOffset: 0, endLine: 4, endOffset: 6 }, quote: 'Second', instruction: 'x' },
      ],
    });
    expect(result.status).toBe('comment_moved');
    expect(result.commentIndex).toBe(0);
    expect(harness.host.sent).toHaveLength(0);
  });

  it('reports nothing to send without edits or comments', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    expect((await harness.controller.sendAll({ comments: [] })).status).toBe('nothing_to_send');
  });
});

describe('sendAll re-reads the chat first (0.1.8)', () => {
  it('sends nothing when a version the panel missed is in the history, and opens the review', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    harness.controller.edit('d', EDITED);
    // The agent replied, but no event reached the panel (for example, no event grant).
    harness.host.transcript.get(SESSION)?.push(draftMessage('a2', `${BASE}\nA line the agent added.`));
    const result = await harness.controller.sendAll({ comments: [] });
    expect(result.status).toBe('newer_version');
    expect(harness.host.sent).toHaveLength(0);
    const draft = draftOf(harness.controller.getSnapshot() as SessionSnapshot);
    expect(draft?.versions).toHaveLength(2);
    // The edits now sit on an older version: the panel shows the stale banner with "Review against latest".
    expect(draft?.status).toBe('stale-base');
    expect(draft?.staleReason).toBe('newer_version');
  });
});

describe('missed versions found by a re-read (0.1.10)', () => {
  it('moves the editor to a version found by a re-read, with a notice', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    harness.host.transcript.get(SESSION)?.push(draftMessage('a2', `${BASE}\nNew line.`));
    harness.host.emit({ type: 'history_reset', sessionId: SESSION });
    await flushMicrotasks();
    await flushMicrotasks();
    const snapshot = harness.controller.getSnapshot() as SessionSnapshot;
    expect(draftOf(snapshot)?.versions).toHaveLength(2);
    expect(snapshot.notices.some((n) => n.message === 'Updated to version 2.')).toBe(true);
  });

  it('re-reads on its own every refreshIntervalMs while visible', async () => {
    const host = new FakeHost({ sessionId: SESSION, messages: plainHistory(), storage: new FakeHostStorage() });
    const clock = new FakeClock();
    const controller = new DraftSessionController({ adapter: host, clock, refreshIntervalMs: 15_000 });
    await controller.start();
    host.transcript.get(SESSION)?.push(draftMessage('a2', `${BASE}\nNew line.`));
    await clock.advance(15_000);
    await flushMicrotasks();
    expect(draftOf(controller.getSnapshot())?.versions).toHaveLength(2);
    await controller.dispose();
  });
});

describe('read errors clear themselves (0.1.15)', () => {
  it('drops a host_error notice once a later read works', async () => {
    const harness = createHarness({}, plainHistory());
    await harness.start();
    const original = harness.host.getHistory.bind(harness.host);
    harness.host.getHistory = async () => {
      throw new HostAdapterError('host_error', 'Failed to fetch');
    };
    await harness.controller.refresh();
    expect(harness.controller.getSnapshot().notices.some((n) => n.message === 'Failed to fetch')).toBe(true);
    harness.host.getHistory = original;
    await harness.controller.refresh();
    expect(harness.controller.getSnapshot().notices.some((n) => n.message === 'Failed to fetch')).toBe(false);
  });
});
