import { describe, expect, it } from 'vitest';

import { StreamTracker } from '../src/index';

/**
 * T-22: streaming previews (requirements.md REQ-5, ADAPTER_INTERFACE section 6).
 * The tracker never commits: committing happens at `assistant_done` (see versions.test.ts).
 */

describe('REQ-5.1 open and closed previews', () => {
  it('REQ-5.1 holds an incomplete last line until it is terminated', () => {
    const tracker = new StreamTracker();
    expect(tracker.push('m1', '```draft id="a"\n')).toEqual([
      expect.objectContaining({ messageId: 'm1', draftId: 'a', body: '', closed: false }),
    ]);
    // No newline yet: the preview must not show half a body line.
    expect(tracker.push('m1', 'Hel')).toEqual([expect.objectContaining({ body: '', closed: false })]);
    expect(tracker.push('m1', 'lo\n')).toEqual([expect.objectContaining({ body: 'Hello', closed: false })]);
  });

  it('REQ-5.1 reports a preview closed once the closing fence line is complete', () => {
    const tracker = new StreamTracker();
    tracker.push('m1', '```draft id="a"\nHello\n');
    const previews = tracker.push('m1', '```\n');
    expect(previews).toHaveLength(1);
    expect(previews[0]).toMatchObject({ draftId: 'a', body: 'Hello', closed: true, fenceIndex: 0, lang: 'markdown' });
  });

  it('REQ-5.1 keeps an unclosed preview open to the end of the chunks', () => {
    const tracker = new StreamTracker();
    tracker.push('m1', 'text before\n```draft id="open"\nfirst line\nsecond');
    expect(tracker.previews('m1')[0]).toMatchObject({ draftId: 'open', closed: false, body: 'first line' });
    tracker.push('m1', ' line\n');
    expect(tracker.previews('m1')[0]).toMatchObject({ closed: false, body: 'first line\nsecond line' });
  });

  it('REQ-5.1 exposes the draft title and lang from the opening fence', () => {
    const tracker = new StreamTracker();
    tracker.push('m1', '```draft id="a" title="Trip note" lang="text"\nbody\n');
    expect(tracker.previews('m1')[0]).toMatchObject({ title: 'Trip note', lang: 'text' });
  });

  it('REQ-5.1 shows only the last fence of an id in one streaming message', () => {
    const tracker = new StreamTracker();
    tracker.push('m1', '```draft id="same"\nfirst\n```\n```draft id="same"\nsecond\n');
    const previews = tracker.previews('m1');
    expect(previews).toHaveLength(1);
    expect(previews[0]).toMatchObject({ draftId: 'same', body: 'second', closed: false, fenceIndex: 1 });
  });

  it('REQ-5.1 previews several different ids', () => {
    const tracker = new StreamTracker();
    tracker.push('m1', '```draft id="a"\none\n```\n```draft id="b"\ntwo\n');
    expect(tracker.previews('m1').map((p) => p.draftId).sort()).toEqual(['a', 'b']);
  });

  it('REQ-5.1 normalizes CRLF deltas before scanning', () => {
    const tracker = new StreamTracker();
    tracker.push('m1', '```draft id="a"\r\nline\r\n```\r\n');
    expect(tracker.previews('m1')[0]).toMatchObject({ body: 'line', closed: true });
  });
});

describe('REQ-5.2 the tracker never commits a version', () => {
  it('REQ-5.2 previews are not DraftVersion records', () => {
    const tracker = new StreamTracker();
    tracker.push('m1', '```draft id="a"\nbody\n```\n');
    const preview = tracker.previews('m1')[0] as unknown as Record<string, unknown>;
    expect(preview['n']).toBeUndefined();
    expect(preview['sourceMessageId']).toBeUndefined();
  });
});

describe('REQ-5.4 tracker bookkeeping', () => {
  it('REQ-5.4 tracks message ids and their accumulated text', () => {
    const tracker = new StreamTracker();
    tracker.push('m1', 'one\n');
    tracker.push('m2', 'two\n');
    expect(tracker.messageIds()).toEqual(['m1', 'm2']);
    expect(tracker.has('m1')).toBe(true);
    expect(tracker.text('m1')).toBe('one\n');
    expect(tracker.text('m2')).toBe('two\n');
    expect(tracker.text('unknown')).toBe('');
  });

  it('REQ-5.4 returns no previews for an unknown message', () => {
    const tracker = new StreamTracker();
    expect(tracker.previews('nope')).toEqual([]);
    expect(tracker.has('nope')).toBe(false);
  });

  it('REQ-5.4 end() forgets one message and clear() forgets all', () => {
    const tracker = new StreamTracker();
    tracker.push('m1', '```draft id="a"\nbody\n```\n');
    tracker.push('m2', '```draft id="b"\nbody\n```\n');
    tracker.end('m1');
    expect(tracker.has('m1')).toBe(false);
    expect(tracker.previews('m1')).toEqual([]);
    expect(tracker.messageIds()).toEqual(['m2']);
    tracker.clear();
    expect(tracker.messageIds()).toEqual([]);
  });

  it('REQ-5.4 produces no preview for text without a complete line', () => {
    const tracker = new StreamTracker();
    expect(tracker.push('m1', '```draft id="a"')).toEqual([]);
    expect(tracker.previews('m1')).toEqual([]);
  });
});
