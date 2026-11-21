import { describe, expect, it } from 'vitest';

import {
  codePointLength,
  codePointToUtf16,
  extractSelection,
  formatRewriteMessage,
  isValidRange,
  mapWorkingRangeToBase,
  toRewriteRequest,
  utf16ToCodePoint,
} from '../src/index';

/**
 * T-22: selection coordinates and the rewrite message (requirements.md REQ-12,
 * ADAPTER_INTERFACE section 12). Offsets are Unicode code points, end exclusive.
 */

// AI 12.3: version 3 of essay-main.
const ESSAY = '# 开场白\n\n我们今天出发 🚀 去海边。\n天气很好。';

describe('REQ-12.4 code point coordinates', () => {
  it('REQ-12.4 counts CJK characters and emoji as one code point', () => {
    const line = '我们今天出发 🚀 去海边。';
    expect(codePointLength(line)).toBe(13);
    expect(utf16ToCodePoint(line, line.length)).toBe(13);
    // 🚀 (U+1F680) is two UTF-16 code units but one code point.
    expect(utf16ToCodePoint(line, 9)).toBe(8);
    expect(codePointToUtf16(line, 8)).toBe(9);
  });

  it('REQ-12.4 converts every code point boundary back and forth', () => {
    for (const line of ['今天', '🚀 a 🎉', 'plain', '']) {
      for (let offset = 0; offset <= codePointLength(line); offset += 1) {
        expect(utf16ToCodePoint(line, codePointToUtf16(line, offset))).toBe(offset);
      }
    }
  });
});

describe('REQ-12.2 AI 12.3 worked example', () => {
  const input = {
    id: 'essay-main',
    rev: 3,
    body: ESSAY,
    range: { startLine: 3, startOffset: 4, endLine: 3, endOffset: 12 },
    instruction: '请把这段改得更口语，保留原意。',
  };

  it('REQ-12.2 uses 1-based lines and the code-point offsets of AI 12.3', () => {
    const built = toRewriteRequest(input);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.request).toEqual({
      id: 'essay-main',
      rev: 3,
      startLine: 3,
      endLine: 3,
      startOffset: 4,
      endOffset: 12,
      selection: '出发 🚀 去海边',
      instruction: '请把这段改得更口语，保留原意。',
    });
  });

  it('REQ-12.2 writes the exact message from AI 12.3', () => {
    const built = toRewriteRequest(input);
    if (!built.ok) throw new Error(built.message);
    expect(formatRewriteMessage(built.request)).toBe(
      [
        '```draft-rewrite id="essay-main" rev="3" start_line="3" end_line="3" start_offset="4" end_offset="12"',
        '出发 🚀 去海边',
        '```',
        '',
        '请把这段改得更口语，保留原意。',
      ].join('\n'),
    );
  });

  it('REQ-12.4 does not use the UTF-16 index of the end (13 would be wrong)', () => {
    const utf16Range = { startLine: 3, startOffset: 4, endLine: 3, endOffset: 13 };
    const built = toRewriteRequest({ ...input, range: utf16Range });
    if (!built.ok) throw new Error(built.message);
    expect(built.request.selection).toBe('出发 🚀 去海边。');
    expect(built.request.selection).not.toBe('出发 🚀 去海边');
  });

  it('REQ-12.2 ends the selection before the character at endOffset', () => {
    const built = toRewriteRequest(input);
    if (!built.ok) throw new Error(built.message);
    expect(built.request.selection.endsWith('边')).toBe(true);
    expect(built.request.selection.includes('。')).toBe(false);
  });

  it('REQ-12.4 selects across lines with \\n in the body', () => {
    const built = toRewriteRequest({
      ...input,
      range: { startLine: 3, startOffset: 9, endLine: 4, endOffset: 2 },
    });
    if (!built.ok) throw new Error(built.message);
    expect(built.request.selection).toBe('去海边。\n天气');
    expect(built.request.startLine).toBe(3);
    expect(built.request.endLine).toBe(4);
  });
});

describe('REQ-12.3 whole document only when selected', () => {
  it('REQ-12.3 sends exactly the selection, not the whole document', () => {
    const built = toRewriteRequest({
      id: 'essay-main',
      rev: 3,
      body: ESSAY,
      range: { startLine: 3, startOffset: 7, endLine: 3, endOffset: 8 },
      instruction: 'Use a different emoji.',
    });
    if (!built.ok) throw new Error(built.message);
    expect(built.request.selection).toBe('🚀');
    expect(built.request.selection).not.toBe(ESSAY);
  });

  it('REQ-12.3 sends the whole document when the whole document is selected', () => {
    const built = toRewriteRequest({
      id: 'essay-main',
      rev: 3,
      body: ESSAY,
      range: { startLine: 1, startOffset: 0, endLine: 4, endOffset: 5 },
      instruction: 'Rewrite everything.',
    });
    if (!built.ok) throw new Error(built.message);
    expect(built.request.selection).toBe(ESSAY);
  });
});

describe('REQ-12.6 invalid rewrite requests', () => {
  const base = {
    id: 'essay-main',
    rev: 3,
    body: ESSAY,
    range: { startLine: 3, startOffset: 4, endLine: 3, endOffset: 12 },
    instruction: 'Make it friendlier.',
  };

  it('REQ-12.6 rejects an empty or whitespace-only instruction', () => {
    expect(toRewriteRequest({ ...base, instruction: '   \n  ' })).toMatchObject({
      ok: false,
      error: 'empty_instruction',
    });
  });

  it('REQ-12.2 rejects an empty selection', () => {
    expect(toRewriteRequest({ ...base, range: { ...base.range, endOffset: 4 } })).toMatchObject({
      ok: false,
      error: 'invalid_range',
    });
  });

  it('REQ-12.2 rejects a range outside the text', () => {
    expect(toRewriteRequest({ ...base, range: { ...base.range, endLine: 99 } })).toMatchObject({
      ok: false,
      error: 'invalid_range',
    });
    expect(toRewriteRequest({ ...base, range: { ...base.range, startOffset: -1 } })).toMatchObject({
      ok: false,
      error: 'invalid_range',
    });
  });

  it('REQ-10.2 rejects an invalid id and a non-positive rev', () => {
    expect(toRewriteRequest({ ...base, id: 'bad id' })).toMatchObject({ ok: false, error: 'invalid_id' });
    expect(toRewriteRequest({ ...base, rev: 0 })).toMatchObject({ ok: false, error: 'invalid_rev' });
  });

  it('REQ-12.2 trims the instruction in the message', () => {
    const built = toRewriteRequest({ ...base, instruction: '  Make it friendlier.  ' });
    if (!built.ok) throw new Error(built.message);
    expect(built.request.instruction).toBe('Make it friendlier.');
  });
});

describe('REQ-12.5 mapping a working-copy selection back to the base', () => {
  it('REQ-12.5 maps an unchanged selection to the same lines of the base', () => {
    expect(
      mapWorkingRangeToBase('one\ntwo\nthree', 'zero\none\ntwo\nthree', {
        startLine: 2,
        startOffset: 0,
        endLine: 2,
        endOffset: 3,
      }),
    ).toEqual({ startLine: 1, startOffset: 0, endLine: 1, endOffset: 3 });
  });

  it('REQ-12.5 returns null when the selection covers an edited line', () => {
    expect(
      mapWorkingRangeToBase('one\ntwo\nthree', 'one\nTWO\nthree', {
        startLine: 2,
        startOffset: 0,
        endLine: 2,
        endOffset: 3,
      }),
    ).toBeNull();
  });

  it('REQ-12.5 returns null when the selection includes an inserted line', () => {
    expect(
      mapWorkingRangeToBase('a\nb', 'a\nnew\nb', {
        startLine: 1,
        startOffset: 0,
        endLine: 3,
        endOffset: 1,
      }),
    ).toBeNull();
  });

  it('REQ-12.5 keeps the offsets of a multi-line unchanged selection', () => {
    expect(
      mapWorkingRangeToBase('a\nb\nc', 'x\na\nb\nc', {
        startLine: 3,
        startOffset: 1,
        endLine: 4,
        endOffset: 1,
      }),
    ).toEqual({ startLine: 2, startOffset: 1, endLine: 3, endOffset: 1 });
  });

  it('REQ-12.5 returns null for a range that is not valid for the working copy', () => {
    expect(
      mapWorkingRangeToBase('a', 'a', { startLine: 1, startOffset: 0, endLine: 1, endOffset: 0 }),
    ).toBeNull();
  });
});

describe('REQ-12.4 selection extraction', () => {
  it('REQ-12.4 extracts the exact text and validates ranges', () => {
    const range = { startLine: 3, startOffset: 4, endLine: 3, endOffset: 12 };
    expect(isValidRange(ESSAY, range)).toBe(true);
    expect(extractSelection(ESSAY, range)).toBe('出发 🚀 去海边');
    expect(extractSelection(ESSAY, { ...range, endLine: 2 })).toBeNull();
  });

  it('REQ-12.4 extracts a multi-line selection with a newline', () => {
    expect(extractSelection(ESSAY, { startLine: 3, startOffset: 9, endLine: 4, endOffset: 2 })).toBe('去海边。\n天气');
  });
});
