import { describe, expect, it } from 'vitest';

import { computeHunks, resolveReview } from '../src/index';

/**
 * T-22: per-hunk accept/reject (requirements.md REQ-13, ADAPTER_INTERFACE
 * section 14). The review only shapes a working copy; it never edits a
 * committed version (see controller.test.ts).
 */

describe('REQ-13.2 computeHunks', () => {
  it('REQ-13.2 reports one hunk for one changed line', () => {
    expect(computeHunks('a\nb\nc', 'a\nB\nc')).toEqual([
      {
        index: 0,
        leftStart: 1,
        leftEnd: 2,
        rightStart: 1,
        rightEnd: 2,
        leftText: 'b',
        rightText: 'B',
      },
    ]);
  });

  it('REQ-13.2 reports a pure insertion with leftStart === leftEnd', () => {
    const [hunk] = computeHunks('a\nc', 'a\nb\nc');
    expect(hunk).toMatchObject({ leftStart: 1, leftEnd: 1, rightStart: 1, rightEnd: 2, leftText: '', rightText: 'b' });
  });

  it('REQ-13.2 reports a pure deletion with rightStart === rightEnd', () => {
    const [hunk] = computeHunks('a\nb\nc', 'a\nc');
    expect(hunk).toMatchObject({ leftStart: 1, leftEnd: 2, rightStart: 1, rightEnd: 1, leftText: 'b', rightText: '' });
  });

  it('REQ-13.2 reports several hunks in ascending order', () => {
    const hunks = computeHunks('a\nb\nc\nd', 'A\nb\nc\nD');
    expect(hunks.map((h) => [h.index, h.leftStart, h.leftEnd, h.rightText])).toEqual([
      [0, 0, 1, 'A'],
      [1, 3, 4, 'D'],
    ]);
  });

  it('REQ-13.2 reports no hunks for identical text', () => {
    expect(computeHunks('a\nb', 'a\nb')).toEqual([]);
  });
});

describe('REQ-13.3 resolveReview', () => {
  const left = 'a\nb\nc\nd';
  const right = 'a\nB\nc\nD';

  it('REQ-13.3 accepting every hunk gives the new version', () => {
    expect(resolveReview(left, right, ['accept', 'accept'])).toBe(right);
  });

  it('REQ-13.3 rejecting every hunk keeps the previous text', () => {
    expect(resolveReview(left, right, ['reject', 'reject'])).toBe(left);
  });

  it('REQ-13.3 mixes accepted and rejected hunks', () => {
    expect(resolveReview(left, right, ['accept', 'reject'])).toBe('a\nB\nc\nd');
    expect(resolveReview(left, right, ['reject', 'accept'])).toBe('a\nb\nc\nD');
  });

  it('REQ-13.3 treats an undecided or missing hunk as reject, so user text is never dropped', () => {
    expect(resolveReview(left, right, [null, undefined])).toBe(left);
    expect(resolveReview(left, right, [])).toBe(left);
    expect(resolveReview(left, right, ['accept'])).toBe('a\nB\nc\nd');
  });

  it('REQ-13.3 accepts an insertion and rejects a deletion independently', () => {
    expect(resolveReview('a\nc', 'a\nb\nc', ['accept'])).toBe('a\nb\nc');
    expect(resolveReview('a\nb\nc', 'a\nc', ['accept'])).toBe('a\nc');
    expect(resolveReview('a\nb\nc', 'a\nc', ['reject'])).toBe('a\nb\nc');
  });

  it('REQ-13.3 returns the left text when there is nothing to review', () => {
    expect(resolveReview('same', 'same', [])).toBe('same');
  });

  it('REQ-13.3 keeps unrelated text exactly', () => {
    const previous = '# Title\n\nKeep this paragraph.\n\nRemove me.\n\nAlso keep.';
    const next = '# Title\n\nKeep this paragraph.\n\n\nAlso keep.';
    expect(resolveReview(previous, next, ['reject'])).toBe(previous);
    expect(resolveReview(previous, next, ['accept'])).toBe(next);
  });
});
