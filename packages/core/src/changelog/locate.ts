import type { SearchReplaceBlock } from '../adapter';
import { normalizeEol, splitLines } from '../text';
import { isMarkerLine } from './body';

export type ChangelogValidationReason =
  | 'empty_search' // SEARCH is empty but the base is not an empty body
  | 'no_match' // SEARCH does not occur in the base
  | 'ambiguous' // SEARCH occurs more than once in the base
  | 'out_of_order' // blocks are not ordered by position in the base
  | 'overlap' // matched ranges overlap
  | 'marker_conflict'; // a SEARCH or REPLACE line equals a marker line

export type ChangelogValidation =
  | { ok: true }
  | { ok: false; reason: ChangelogValidationReason; blockIndex: number; message: string };

/** Half-open range of base lines `[start, end)`. */
export interface LineRange {
  start: number;
  end: number;
}

export type LocateResult =
  | { ok: true; ranges: LineRange[] }
  | { ok: false; reason: ChangelogValidationReason; blockIndex: number };

/** Lines of a SEARCH string against `baseLines`; null if the SEARCH is not allowed to be empty. */
export function searchLinesOf(search: string, baseLines: readonly string[]): string[] | null {
  if (search === '') return baseLines.length === 1 && baseLines[0] === '' ? [''] : null;
  return splitLines(search);
}

/** Lines of a REPLACE string; the empty string means zero lines (a deletion). */
export function replaceLinesOf(replace: string): string[] {
  return replace === '' ? [] : splitLines(replace);
}

/** Start positions of `needle` in `hay`, stopping after `limit` hits. */
export function findRuns(hay: readonly string[], needle: readonly string[], limit = 2): number[] {
  const hits: number[] = [];
  if (needle.length === 0 || needle.length > hay.length) return hits;
  const first = needle[0];
  for (let i = 0; i + needle.length <= hay.length; i += 1) {
    if (hay[i] !== first) continue;
    let j = 1;
    while (j < needle.length && hay[i + j] === needle[j]) j += 1;
    if (j === needle.length) {
      hits.push(i);
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

/**
 * Finds every block in the base (never in partly edited text). Each SEARCH must
 * match exactly once; ranges must be ordered and must not overlap.
 */
export function locateBlocks(baseLines: readonly string[], blocks: readonly SearchReplaceBlock[]): LocateResult {
  const ranges: LineRange[] = [];
  for (let b = 0; b < blocks.length; b += 1) {
    const block = blocks[b] as SearchReplaceBlock;
    const lines = searchLinesOf(block.search, baseLines);
    if (lines === null) return { ok: false, reason: 'empty_search', blockIndex: b };
    const hits = findRuns(baseLines, lines, 2);
    if (hits.length === 0) return { ok: false, reason: 'no_match', blockIndex: b };
    if (hits.length > 1) return { ok: false, reason: 'ambiguous', blockIndex: b };
    const start = hits[0] as number;
    const range = { start, end: start + lines.length };
    const prev = ranges[ranges.length - 1];
    if (prev !== undefined) {
      if (range.start < prev.start) return { ok: false, reason: 'out_of_order', blockIndex: b };
      if (range.start < prev.end) return { ok: false, reason: 'overlap', blockIndex: b };
    }
    ranges.push(range);
  }
  return { ok: true, ranges };
}

const REASON_TEXT: Record<ChangelogValidationReason, string> = {
  empty_search: 'SEARCH is empty, but the base text is not empty',
  no_match: 'SEARCH text was not found in the base',
  ambiguous: 'SEARCH text occurs more than once in the base',
  out_of_order: 'blocks are not ordered by position in the base',
  overlap: 'SEARCH ranges overlap',
  marker_conflict: 'a SEARCH or REPLACE line equals a changelog marker',
};

/** Finds the first block whose SEARCH or REPLACE has a marker line, if any. */
export function findMarkerConflict(
  blocks: readonly SearchReplaceBlock[],
): { blockIndex: number; section: 'search' | 'replace'; line: string } | null {
  for (let b = 0; b < blocks.length; b += 1) {
    const block = blocks[b] as SearchReplaceBlock;
    for (const line of block.search === '' ? [] : splitLines(block.search)) {
      if (isMarkerLine(line)) return { blockIndex: b, section: 'search', line };
    }
    for (const line of replaceLinesOf(block.replace)) {
      if (isMarkerLine(line)) return { blockIndex: b, section: 'replace', line };
    }
  }
  return null;
}

/**
 * Checks that `blocks` can be applied to `base` as ADAPTER_INTERFACE section
 * 11.2 requires. Does not throw.
 */
export function validateChangelog(base: string, blocks: readonly SearchReplaceBlock[]): ChangelogValidation {
  const baseLines = splitLines(normalizeEol(base));
  const conflict = findMarkerConflict(blocks);
  if (conflict !== null) {
    return {
      ok: false,
      reason: 'marker_conflict',
      blockIndex: conflict.blockIndex,
      message: `Block ${conflict.blockIndex + 1}: ${REASON_TEXT.marker_conflict}`,
    };
  }
  if (blocks.length === 0) {
    return { ok: false, reason: 'empty_search', blockIndex: 0, message: 'The changelog has no blocks' };
  }
  const located = locateBlocks(baseLines, blocks);
  if (!located.ok) {
    return {
      ok: false,
      reason: located.reason,
      blockIndex: located.blockIndex,
      message: `Block ${located.blockIndex + 1}: ${REASON_TEXT[located.reason]}`,
    };
  }
  return { ok: true };
}
