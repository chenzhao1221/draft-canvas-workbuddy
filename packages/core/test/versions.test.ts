import { describe, expect, it } from 'vitest';

import {
  applyAssistantMessage,
  emptyVersionStore,
  getLatestVersion,
  getVersions,
  hashText,
  rebuild,
  type DraftVersion,
  type Message,
  type VersionStore,
} from '../src/index';

/**
 * T-22: version chains and rebuild from history (requirements.md REQ-2, REQ-4,
 * ADAPTER_INTERFACE section 13).
 */

const SESSION = 'session-1';

function message(text: string, overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    sessionId: SESSION,
    role: 'assistant',
    text,
    createdAt: '2026-01-01T00:00:00.000Z',
    complete: true,
    ...overrides,
  };
}

function fence(id: string, body: string, attrs = ''): string {
  return `\`\`\`draft id="${id}"${attrs}\n${body}\n\`\`\``;
}

function applyAll(messages: readonly Message[]): VersionStore {
  let store = emptyVersionStore();
  for (const m of messages) store = applyAssistantMessage(store, m).store;
  return store;
}

function serialise(store: VersionStore): { id: string; versions: DraftVersion[] }[] {
  return store.order.map((id) => ({ id, versions: [...getVersions(store, id)] }));
}

describe('REQ-2.2 / REQ-2.5 version numbering', () => {
  it('REQ-2.2 numbers versions of one id 1, 2, 3 in conversation order', () => {
    const { store } = rebuild([
      message(fence('d', 'one'), { id: 'm1' }),
      message(fence('d', 'two'), { id: 'm2' }),
      message(fence('d', 'three'), { id: 'm3' }),
    ]);
    expect(getVersions(store, 'd').map((v) => [v.n, v.body])).toEqual([
      [1, 'one'],
      [2, 'two'],
      [3, 'three'],
    ]);
    expect(getLatestVersion(store, 'd')?.n).toBe(3);
  });

  it('REQ-2.3 stores the model rev attribute as a hint and never numbers by it', () => {
    const { store } = rebuild([
      message(fence('d', 'one', ' rev="7"'), { id: 'm1' }),
      message(fence('d', 'two', ' rev="2"'), { id: 'm2' }),
    ]);
    expect(getVersions(store, 'd').map((v) => [v.n, v.revHint])).toEqual([
      [1, '7'],
      [2, '2'],
    ]);
  });

  it('REQ-2.1 commits only the last closed fence of an id in one message (AI 10.5)', () => {
    const text = [
      fence('d', 'first attempt'),
      'Some prose between the fences.',
      fence('d', 'second attempt'),
      fence('d', 'third attempt'),
    ].join('\n\n');
    const outcome = applyAssistantMessage(emptyVersionStore(), message(text));
    expect(outcome.committed.map((v) => v.body)).toEqual(['third attempt']);
    expect(outcome.committed[0]?.n).toBe(1);
    expect(outcome.committed[0]?.fenceIndex).toBe(2);
  });

  it('REQ-5.3 does not let an unclosed fence shadow the last closed fence of the same id', () => {
    const text = [fence('d', 'closed one'), '```draft id="d"', 'never closed'].join('\n\n');
    const outcome = applyAssistantMessage(emptyVersionStore(), message(text));
    expect(outcome.committed.map((v) => v.body)).toEqual(['closed one']);
    expect(outcome.unclosed).toEqual([{ draftId: 'd', messageId: 'm1' }]);
  });

  it('REQ-2.5 treats a later message with an existing id as a new version of the same draft', () => {
    const { store } = rebuild([message(fence('d', 'one'), { id: 'm1' }), message(fence('d', 'two'), { id: 'm2' })]);
    expect(store.order).toEqual(['d']);
    expect(getVersions(store, 'd')).toHaveLength(2);
  });

  it('REQ-2.5 keeps different ids as different drafts in order of first appearance', () => {
    const outcome = applyAssistantMessage(emptyVersionStore(), message([fence('b', 'b1'), fence('a', 'a1')].join('\n\n')));
    expect(outcome.store.order).toEqual(['b', 'a']);
    expect(outcome.committed.map((v) => [v.draftId, v.fenceIndex])).toEqual([
      ['b', 0],
      ['a', 1],
    ]);
  });
});

describe('REQ-2.4 recorded version fields', () => {
  it('REQ-2.4 records id, number, source message, fence index, rev hint, title, lang, body and timestamp', () => {
    const m = message(fence('trip-note', 'Body text', ' rev="4" title="Trip" lang="text"'), {
      id: 'msg-7',
      createdAt: '2026-03-04T05:06:07.000Z',
    });
    const version = applyAssistantMessage(emptyVersionStore(), m).committed[0];
    expect(version).toEqual({
      draftId: 'trip-note',
      n: 1,
      sourceMessageId: 'msg-7',
      fenceIndex: 0,
      revHint: '4',
      title: 'Trip',
      lang: 'text',
      body: 'Body text',
      createdAt: '2026-03-04T05:06:07.000Z',
    });
  });
});

describe('REQ-1.2 / REQ-4.1 message filtering', () => {
  it('REQ-1.2 ignores draft fences in user, system and tool messages', () => {
    const speech = fence('pasted', 'Pasted by the user.');
    const { store } = rebuild([
      message(speech, { id: 'u1', role: 'user' }),
      message(speech, { id: 's1', role: 'system' }),
      message(speech, { id: 't1', role: 'tool' }),
    ]);
    expect(store.order).toEqual([]);
    expect(store.processed.size).toBe(0);
  });

  it('REQ-4.1 ignores an assistant message that is still streaming', () => {
    const outcome = applyAssistantMessage(emptyVersionStore(), message(fence('d', 'body'), { complete: false }));
    expect(outcome.status).toBe('ignored');
    expect(outcome.committed).toEqual([]);
    expect(outcome.store.order).toEqual([]);
  });

  it('REQ-1.3 does not create a version from a fence inside another block (fixture transcript)', () => {
    const { store } = rebuild([
      message('````text\n```draft id="nested"\ncontent\n```\n````'),
      message('> ```draft id="quoted"\n> content\n> ```'),
    ]);
    expect(store.order).toEqual([]);
  });
});

describe('REQ-4.2 rebuild equals incremental apply', () => {
  const messages: Message[] = [
    message(fence('a', 'a1'), { id: 'm1' }),
    message(`prose\n\n${fence('b', 'b1')}`, { id: 'm2' }),
    message(fence('a', 'a2'), { id: 'm3' }),
    message('```draft id="unfinished"\nno closing fence', { id: 'm4' }),
    message(fence('c', 'c1'), { id: 'm5' }),
  ];

  it('REQ-4.2 rebuild gives the same store as applying each message in order', () => {
    const rebuilt = rebuild(messages);
    const incremental = applyAll(messages);
    expect(serialise(rebuilt.store)).toEqual(serialise(incremental));
    expect([...rebuilt.store.processed.entries()].sort()).toEqual([...incremental.processed.entries()].sort());
  });

  it('REQ-4.2 rebuilding the same history twice is idempotent', () => {
    const first = rebuild(messages);
    const second = rebuild(messages);
    expect(serialise(second.store)).toEqual(serialise(first.store));
    expect(second.unclosed).toEqual(first.unclosed);
  });

  it('REQ-4.2 reports unclosed fences from the whole history in message order', () => {
    const { unclosed } = rebuild(messages);
    expect(unclosed).toEqual([{ draftId: 'unfinished', messageId: 'm4' }]);
  });
});

describe('REQ-4.3 processing the same message again', () => {
  const first = message(fence('d', 'one'), { id: 'm1' });

  it('REQ-4.3 leaves versions unchanged for the same id and identical text', () => {
    const { store } = rebuild([first]);
    const again = applyAssistantMessage(store, first);
    expect(again.status).toBe('duplicate');
    expect(again.store).toBe(store);
    expect(again.committed).toEqual([]);
    expect(serialise(again.store)).toEqual(serialise(store));
  });

  it('REQ-4.3 reports text_changed for the same id and different text', () => {
    const { store } = rebuild([first]);
    const changed = applyAssistantMessage(store, message(fence('d', 'two'), { id: 'm1' }));
    expect(changed.status).toBe('text_changed');
    expect(changed.committed).toEqual([]);
    expect(serialise(changed.store)).toEqual(serialise(store));
  });

  it('REQ-4.3 compares the normalized text, so CRLF and LF forms count as the same text', () => {
    const { store } = rebuild([first]);
    const crlf = applyAssistantMessage(
      store,
      message(fence('d', 'one').replace(/\n/g, '\r\n'), { id: 'm1' }),
    );
    expect(crlf.status).toBe('duplicate');
  });

  it('REQ-4.3 records hashText of the processed text', () => {
    const { store } = rebuild([first]);
    expect(store.processed.get('m1')).toBe(hashText(first.text));
  });
});

describe('REQ-5.3 unclosed fences', () => {
  it('REQ-5.3 commits nothing for an unclosed fence and still commits a closed one from the same message', () => {
    const text = [fence('closed', 'closed body'), '```draft id="open"', 'never closed'].join('\n\n');
    const outcome = applyAssistantMessage(emptyVersionStore(), message(text));
    expect(outcome.committed.map((v) => v.draftId)).toEqual(['closed']);
    expect(outcome.unclosed).toEqual([{ draftId: 'open', messageId: 'm1' }]);
    expect(getVersions(outcome.store, 'open')).toEqual([]);
  });
});

describe('REQ-1.6 / REQ-2.6 store invariants', () => {
  it('REQ-1.6 normalizes the body line endings of a committed version', () => {
    const crlf = '```draft id="d"\r\nfirst\r\nsecond\r\n```\r\n';
    const { store } = rebuild([message(crlf)]);
    expect(getVersions(store, 'd')[0]?.body).toBe('first\nsecond');
  });

  it('REQ-2.6 never mutates a committed version when a later message is applied', () => {
    const { store } = rebuild([message(fence('d', 'one'), { id: 'm1' })]);
    const before = serialise(store);
    const frozen = getVersions(store, 'd')[0] as DraftVersion;
    const snapshot = { ...frozen };

    applyAssistantMessage(store, message(fence('d', 'two'), { id: 'm2' }));

    expect(frozen).toEqual(snapshot);
    expect(before).toEqual(serialise(store));
    expect(getVersions(store, 'd')).toHaveLength(1);
  });

  it('REQ-2.6 returns no versions for an unknown draft', () => {
    const store = emptyVersionStore();
    expect(getVersions(store, 'missing')).toEqual([]);
    expect(getLatestVersion(store, 'missing')).toBeUndefined();
  });
});

describe('REQ-1.4 / REQ-2 id-less draft fences share the auto id draft-1', () => {
  const idless = (body: string): string => `\`\`\`draft\n${body}\n\`\`\``;

  it('REQ-1.4 commits an id-less fence as draft-1 version 1', () => {
    const { store } = rebuild([message(idless('Sample prose.\nSecond line.'))]);
    expect(store.order).toEqual(['draft-1']);
    const [v] = getVersions(store, 'draft-1');
    expect(v?.n).toBe(1);
    expect(v?.draftId).toBe('draft-1');
    expect(v?.body).toBe('Sample prose.\nSecond line.');
  });

  it('REQ-2.2 a later id-less fence is version 2 of the same id', () => {
    const { store } = rebuild([
      message(idless('one'), { id: 'm1' }),
      message('Revised:\n\n' + idless('two'), { id: 'm2' }),
    ]);
    expect(store.order).toEqual(['draft-1']);
    expect(getVersions(store, 'draft-1').map((v) => [v.n, v.body, v.sourceMessageId])).toEqual([
      [1, 'one', 'm1'],
      [2, 'two', 'm2'],
    ]);
  });

  it('REQ-2.1 the last id-less fence of one message wins', () => {
    const { store } = rebuild([message([idless('first'), idless('second')].join('\n\n'))]);
    expect(getVersions(store, 'draft-1').map((v) => [v.n, v.body])).toEqual([[1, 'second']]);
  });

  it('REQ-2.5 an explicit id stays its own chain next to the auto id', () => {
    const { store } = rebuild([
      message(idless('auto one'), { id: 'm1' }),
      message(fence('foo', 'foo one'), { id: 'm2' }),
      message(idless('auto two'), { id: 'm3' }),
      message(fence('foo', 'foo two'), { id: 'm4' }),
    ]);
    expect(store.order).toEqual(['draft-1', 'foo']);
    expect(getVersions(store, 'draft-1').map((v) => v.body)).toEqual(['auto one', 'auto two']);
    expect(getVersions(store, 'foo').map((v) => v.body)).toEqual(['foo one', 'foo two']);
  });

  it('REQ-1.4 still ignores invalid explicit ids', () => {
    const { store } = rebuild([
      message(['```draft id="bad id!"', 'x', '```', '', '```draft id=""', 'y', '```'].join('\n')),
    ]);
    expect(store.order).toEqual([]);
  });

  it('REQ-4.3 rebuilding the same history twice gives the same store', () => {
    const history = [
      message(idless('one'), { id: 'm1' }),
      message(idless('two'), { id: 'm2', createdAt: '2026-01-02T00:00:00.000Z' }),
    ];
    const a = rebuild(history).store;
    const b = rebuild(history).store;
    expect(serialise(a)).toEqual(serialise(b));
    expect(serialise(a)[0]?.id).toBe('draft-1');
  });
});
