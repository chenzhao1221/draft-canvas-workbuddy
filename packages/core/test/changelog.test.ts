import { describe, expect, it } from 'vitest';

import {
  applyChangelog,
  buildChangelog,
  ChangelogApplyError,
  formatChangelogFence,
  isChangelogError,
  joinFences,
  parseChangelogFences,
  validateChangelog,
  type ChangelogFence,
  type SearchReplaceBlock,
} from '../src/index';

/**
 * T-22: SEARCH/REPLACE changelogs (requirements.md REQ-8, ADAPTER_INTERFACE
 * section 11). The worked examples use the exact text from AI 11.3-11.5.
 */

function blocks(id: string, base: string, baseN: number, text: string): SearchReplaceBlock[] {
  const result = buildChangelog(id, base, baseN, text);
  if (isChangelogError(result)) throw new Error(`unexpected ${result.error}: ${result.message}`);
  return result.blocks;
}

function occurrences(haystack: readonly string[], needle: readonly string[]): number {
  let count = 0;
  for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    let j = 0;
    while (j < needle.length && haystack[i + j] === needle[j]) j += 1;
    if (j === needle.length) count += 1;
  }
  return count;
}

function lines(text: string): string[] {
  return text.split('\n');
}

describe('REQ-8.1 / REQ-8.2 AI 11.3 worked example', () => {
  const base = '# Trip note\n\nWe leave today.\nThe weather is fine.\nSee you there.';
  const working = '# Trip note\n\nWe leave today.\nThe weather is perfect.\nSee you there.\nBring a hat.';

  it('REQ-8.1 builds a fence with id, from = base version and to = from + 1', () => {
    const result = buildChangelog('trip-note', base, 2, working);
    expect(isChangelogError(result)).toBe(false);
    expect(result).toMatchObject({ id: 'trip-note', from: 2, to: 3 });
  });

  it('REQ-8.2 produces the two blocks of AI 11.3 in base order', () => {
    expect(blocks('trip-note', base, 2, working)).toEqual([
      { search: 'The weather is fine.', replace: 'The weather is perfect.' },
      { search: 'See you there.', replace: 'See you there.\nBring a hat.' },
    ]);
  });

  it('REQ-8.3 formats the canonical fence shown in AI 11.3', () => {
    const result = buildChangelog('trip-note', base, 2, working) as ChangelogFence;
    const expected = [
      '```draft-changelog id="trip-note" from="2" to="3"',
      '*** Begin Patch',
      '<<<<<<< SEARCH',
      'The weather is fine.',
      '=======',
      'The weather is perfect.',
      '>>>>>>> REPLACE',
      '<<<<<<< SEARCH',
      'See you there.',
      '=======',
      'See you there.',
      'Bring a hat.',
      '>>>>>>> REPLACE',
      '*** End Patch',
      '```',
    ].join('\n');
    expect(formatChangelogFence(result)).toBe(expected);
  });

  it('REQ-8.3 applies the changelog to the base to give the working copy exactly', () => {
    expect(applyChangelog(base, blocks('trip-note', base, 2, working))).toBe(working);
  });

  it('REQ-8.3 parses the generated fence back to the same blocks', () => {
    const result = buildChangelog('trip-note', base, 2, working) as ChangelogFence;
    const parsed = parseChangelogFences(formatChangelogFence(result));
    expect(parsed).toEqual([{ id: 'trip-note', from: 2, to: 3, blocks: result.blocks }]);
  });
});

describe('REQ-8.2 AI 11.4 widening for uniqueness', () => {
  const base = '## Day one\nBring water.\n## Day two\nBring water.\nLeave early.';
  const working = '## Day one\nBring water.\n## Day two\nBring water and snacks.\nLeave early.';

  it('REQ-8.2 adds one line of context so that the SEARCH matches exactly once', () => {
    expect(blocks('packing', base, 1, working)).toEqual([
      { search: '## Day two\nBring water.', replace: '## Day two\nBring water and snacks.' },
    ]);
  });

  it('REQ-8.2 formats the canonical fence shown in AI 11.4', () => {
    const result = buildChangelog('packing', base, 1, working) as ChangelogFence;
    expect(formatChangelogFence(result)).toBe(
      [
        '```draft-changelog id="packing" from="1" to="2"',
        '*** Begin Patch',
        '<<<<<<< SEARCH',
        '## Day two',
        'Bring water.',
        '=======',
        '## Day two',
        'Bring water and snacks.',
        '>>>>>>> REPLACE',
        '*** End Patch',
        '```',
      ].join('\n'),
    );
    expect(applyChangelog(base, result.blocks)).toBe(working);
  });

  it('REQ-8.2 widens towards the next line when the match is at the start of the base', () => {
    const result = blocks('top', 'same\nsame\nother', 1, 'same\nsame\nother\nmore');
    expect(result).toEqual([{ search: 'other', replace: 'other\nmore' }]);
  });
});

describe('REQ-8.3 AI 11.5 code content, deletion and two drafts', () => {
  const setupBase = 'Install the tool:\n\n```sh\nnpm install example\n```\n\nThen restart.';
  const setupWorking = 'Install the tool:\n\n```bash\nnpm install example\n```';
  const tripBase = '# Trip note\n\nWe leave today.\nThe weather is fine.\nSee you there.';
  const tripWorking = '# Trip note\n\nWe leave tomorrow.\nThe weather is fine.\nSee you there.';

  it('REQ-8.3 produces a code-line change and a two-line deletion', () => {
    expect(blocks('setup-guide', setupBase, 4, setupWorking)).toEqual([
      { search: '```sh', replace: '```bash' },
      { search: '\nThen restart.', replace: '' },
    ]);
  });

  it('REQ-8.3 wraps the fence in four backticks because the body contains a code fence', () => {
    const result = buildChangelog('setup-guide', setupBase, 4, setupWorking) as ChangelogFence;
    const text = formatChangelogFence(result);
    expect(text.startsWith('````draft-changelog ')).toBe(true);
    expect(text.endsWith('\n````')).toBe(true);
    expect(applyChangelog(setupBase, result.blocks)).toBe(setupWorking);
  });

  it('REQ-8.3 joins two draft changelogs with one blank line (AI 11.5)', () => {
    const first = buildChangelog('setup-guide', setupBase, 4, setupWorking) as ChangelogFence;
    const second = buildChangelog('trip-note', tripBase, 2, tripWorking) as ChangelogFence;
    const injected = joinFences([formatChangelogFence(first), formatChangelogFence(second)]);
    expect(parseChangelogFences(injected)).toEqual([
      { id: 'setup-guide', from: 4, to: 5, blocks: first.blocks },
      { id: 'trip-note', from: 2, to: 3, blocks: second.blocks },
    ]);
    expect(injected).toContain('````\n\n```draft-changelog id="trip-note"');
  });
});

describe('REQ-8.2 / REQ-8.3 insertion, deletion and empty base', () => {
  it('REQ-8.3 deletes whole lines with an empty REPLACE', () => {
    const result = blocks('deletion', 'alpha\nbeta\ngamma', 1, 'alpha\ngamma');
    expect(result).toEqual([{ search: 'beta', replace: '' }]);
    expect(applyChangelog('alpha\nbeta\ngamma', result)).toBe('alpha\ngamma');
  });

  it('REQ-8.2 sets the whole text when the base body is empty', () => {
    const result = blocks('empty-base', '', 1, 'First line.\nSecond line.');
    expect(result).toEqual([{ search: '', replace: 'First line.\nSecond line.' }]);
    expect(applyChangelog('', result)).toBe('First line.\nSecond line.');
    expect(validateChangelog('', result)).toEqual({ ok: true });
  });

  it('REQ-8.3 inserts a line before the first base line', () => {
    const result = blocks('insert-top', 'first\nsecond', 1, 'heading\nfirst\nsecond');
    expect(result).toEqual([{ search: 'first', replace: 'heading\nfirst' }]);
    expect(applyChangelog('first\nsecond', result)).toBe('heading\nfirst\nsecond');
  });

  it('REQ-8.2 inserts an empty line with context so that the block is not a lone empty line', () => {
    const result = blocks('blank-insert', 'one\n\ntwo', 1, 'one\n\ntwo\n');
    expect(result).toEqual([{ search: 'two', replace: 'two\n' }]);
    expect(applyChangelog('one\n\ntwo', result)).toBe('one\n\ntwo\n');
  });

  it('REQ-8.3 merges blocks whose widened ranges overlap', () => {
    // "a" occurs three times, so both changes widen to the whole base and merge.
    const result = blocks('merge', 'a\na\na', 1, 'A\na\nB');
    expect(result).toEqual([{ search: 'a\na\na', replace: 'A\na\nB' }]);
    expect(applyChangelog('a\na\na', result)).toBe('A\na\nB');
  });

  it('REQ-8.3 widens to the whole base when no smaller SEARCH is expressible', () => {
    // The builder also self-checks every changelog against the base and falls back
    // to a single whole-base block if the blocks do not reproduce the working copy.
    // That branch is defensive and not reachable through the public API, so the
    // invariant it protects is covered by the corpus below.
    const result = blocks('whole', 'only line\n', 1, 'only line');
    expect(result).toEqual([{ search: 'only line\n', replace: 'only line' }]);
    expect(applyChangelog('only line\n', result)).toBe('only line');
  });

  it('REQ-1.6 normalizes a CRLF working copy before building', () => {
    const result = blocks('crlf-change', 'first\nsecond', 1, 'first\r\nsecond changed\r\n');
    expect(applyChangelog('first\nsecond', result)).toBe('first\nsecond changed\n');
  });
});

describe('REQ-8.5 marker conflicts', () => {
  it('REQ-8.5 refuses a changelog whose REPLACE line equals a marker', () => {
    const result = buildChangelog('marker-replace', 'heading\nold line', 1, 'heading\n=======');
    expect(isChangelogError(result)).toBe(true);
    if (isChangelogError(result)) {
      expect(result.error).toBe('marker_conflict');
      expect(result.line).toBe('=======');
      expect(result.section).toBe('replace');
      expect(result.message).toContain('=======');
    }
  });

  it('REQ-8.5 refuses a changelog whose SEARCH line equals a marker', () => {
    const result = buildChangelog('marker-search', 'heading\n=======', 1, 'heading\nnew line');
    expect(isChangelogError(result)).toBe(true);
    if (isChangelogError(result)) {
      expect(result.error).toBe('marker_conflict');
      expect(result.line).toBe('=======');
      expect(result.section).toBe('search');
    }
  });
});

describe('REQ-8.6 no changes', () => {
  it('REQ-8.6 produces no changelog for identical text', () => {
    expect(buildChangelog('same', 'same text', 3, 'same text')).toEqual({
      error: 'no_changes',
      message: 'There are no changes to add.',
    });
  });

  it('REQ-8.6 treats CRLF and LF forms of the same text as no changes', () => {
    expect(isChangelogError(buildChangelog('same', 'a\nb', 1, 'a\r\nb'))).toBe(true);
  });
});

describe('REQ-8.3 validity of every generated changelog', () => {
  it('REQ-8.3 every SEARCH occurs exactly once, blocks are ordered and apply gives the working copy', () => {
    const base = 'one two three\nsecond line\nthird\nfourth\nfifth';
    const working = 'one two three\nsecond line changed\nthird\nfourth\nfifth\nsixth';
    const result = blocks('multi', base, 2, working);
    expect(validateChangelog(base, result)).toEqual({ ok: true });
    let previousEnd = -1;
    for (const block of result) {
      const search = lines(block.search);
      expect(occurrences(lines(base), search)).toBe(1);
      const position = lines(base).findIndex((_, i) => lines(base).slice(i, i + search.length).join('\n') === block.search);
      expect(position).toBeGreaterThan(previousEnd);
      previousEnd = position + search.length;
    }
    expect(applyChangelog(base, result)).toBe(working);
  });

  it('REQ-8.3 apply(base) equals the working copy for a corpus of random edits', () => {
    let seed = 0x2f6e2b1;
    const random = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const alphabet = ['alpha', 'beta', '', 'gamma delta', '# Heading', 'text', 'code line', 'x'];
    const edit = (base: string): string => {
      const current = lines(base);
      const operation = pick(['insert', 'delete', 'replace'] as const);
      const index = Math.floor(random() * (current.length + 1));
      if (operation === 'insert') {
        current.splice(index, 0, pick(alphabet));
      } else if (operation === 'delete' && current.length > 1) {
        current.splice(Math.min(index, current.length - 1), 1);
      } else {
        current[Math.min(index, current.length - 1)] = pick(alphabet);
      }
      return current.join('\n');
    };

    let checked = 0;
    for (let i = 0; i < 250; i += 1) {
      let base = Array.from({ length: 1 + Math.floor(random() * 6) }, () => pick(alphabet)).join('\n');
      let working = base;
      const edits = 1 + Math.floor(random() * 3);
      for (let e = 0; e < edits; e += 1) working = edit(working);
      if (working === base) continue;

      const result = buildChangelog('random', base, 1, working);
      if (isChangelogError(result)) continue; // no_changes cannot happen; marker lines are not in the alphabet
      expect(applyChangelog(base, result.blocks)).toBe(working);
      expect(validateChangelog(base, result.blocks)).toEqual({ ok: true });
      checked += 1;
    }
    expect(checked).toBeGreaterThan(100);
  });
});

describe('REQ-8.3 applying an invalid changelog', () => {
  it('REQ-8.3 rejects an ambiguous SEARCH', () => {
    expect(validateChangelog('a\na', [{ search: 'a', replace: 'b' }])).toMatchObject({
      ok: false,
      reason: 'ambiguous',
    });
    expect(() => applyChangelog('a\na', [{ search: 'a', replace: 'b' }])).toThrow(ChangelogApplyError);
  });

  it('REQ-8.3 rejects a SEARCH that is not in the base and overlapping blocks', () => {
    expect(validateChangelog('a\nb', [{ search: 'missing', replace: '' }])).toMatchObject({
      ok: false,
      reason: 'no_match',
    });
    expect(
      validateChangelog('a\nb\nc\nd', [
        { search: 'a\nb', replace: 'x' },
        { search: 'b\nc', replace: 'y' },
      ]),
    ).toMatchObject({ ok: false, reason: 'overlap' });
  });
});
