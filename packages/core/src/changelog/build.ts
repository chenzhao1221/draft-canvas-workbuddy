import type { ChangelogFence, SearchReplaceBlock } from '../adapter';
import { diffLineHunks, joinLines, normalizeEol, splitLines, type LineHunk } from '../text';
import { tryApplyChangelogLines } from './apply';
import { findMarkerConflict, findRuns } from './locate';

export type ChangelogErrorCode = 'marker_conflict' | 'no_changes';

/** Returned by `buildChangelog` when no changelog can be produced. */
export interface ChangelogError {
  error: ChangelogErrorCode;
  message: string;
  /** marker_conflict: the offending line. */
  line?: string;
  /** marker_conflict: where the line would appear. */
  section?: 'search' | 'replace';
}

export function isChangelogError(result: ChangelogFence | ChangelogError): result is ChangelogError {
  return 'error' in result;
}

/** A block under construction: base lines `[start, end)` plus the hunks it owns. */
interface Plan {
  start: number;
  end: number;
  hunks: LineHunk[];
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** Replacement lines of a plan: its base range with the owned hunks applied. */
function renderReplacement(plan: Plan, base: readonly string[], work: readonly string[]): string[] {
  const out: string[] = [];
  let pos = plan.start;
  for (const h of plan.hunks) {
    for (let i = pos; i < h.aStart; i += 1) out.push(base[i] as string);
    for (let i = h.bStart; i < h.bEnd; i += 1) out.push(work[i] as string);
    pos = h.aEnd;
  }
  for (let i = pos; i < plan.end; i += 1) out.push(base[i] as string);
  return out;
}

/**
 * A plan is final when it covers at least one base line, its SEARCH occurs
 * exactly once, and neither text is ambiguous on the wire: a lone empty line is
 * indistinguishable from "no lines" in `SearchReplaceBlock` strings, so it is
 * only allowed when the block covers the whole document.
 */
function isFinal(plan: Plan, base: readonly string[], work: readonly string[]): boolean {
  if (plan.end <= plan.start) return false;
  const whole = plan.start === 0 && plan.end === base.length;
  const search = base.slice(plan.start, plan.end);
  if (!whole && search.length === 1 && search[0] === '') return false;
  const replace = renderReplacement(plan, base, work);
  if (!whole && replace.length === 1 && replace[0] === '') return false;
  return findRuns(base, search, 2).length === 1;
}

/**
 * Adds context lines, one before then one after, alternating (the other side
 * when one side runs out), until the plan is final. The whole document is
 * always final, so this terminates.
 */
function widen(plan: Plan, base: readonly string[], work: readonly string[]): void {
  let nextBefore = true;
  for (;;) {
    if (isFinal(plan, base, work)) return;
    const canBefore = plan.start > 0;
    const canAfter = plan.end < base.length;
    if (!canBefore && !canAfter) return;
    if ((nextBefore && canBefore) || !canAfter) plan.start -= 1;
    else plan.end += 1;
    nextBefore = !nextBefore;
  }
}

/** Merges plans whose base ranges overlap. Input must be ordered by start. */
function mergeOverlapping(plans: Plan[]): Plan[] {
  const merged: Plan[] = [];
  for (const plan of plans) {
    const last = merged[merged.length - 1];
    if (last !== undefined && plan.start < last.end) {
      last.end = Math.max(last.end, plan.end);
      last.hunks = last.hunks.concat(plan.hunks).sort((a, b) => a.aStart - b.aStart || a.aEnd - b.aEnd);
    } else {
      merged.push({ start: plan.start, end: plan.end, hunks: plan.hunks.slice() });
    }
  }
  return merged;
}

function planBlocks(base: readonly string[], work: readonly string[], hunks: readonly LineHunk[]): Plan[] {
  let plans: Plan[] = hunks.map((h) => ({ start: h.aStart, end: h.aEnd, hunks: [h] }));
  for (;;) {
    for (const plan of plans) widen(plan, base, work);
    plans.sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = mergeOverlapping(plans);
    if (merged.length === plans.length) return merged;
    plans = merged;
  }
}

function toBlock(plan: Plan, base: readonly string[], work: readonly string[]): SearchReplaceBlock {
  return {
    search: joinLines(base.slice(plan.start, plan.end)),
    replace: joinLines(renderReplacement(plan, base, work)),
  };
}

function conflictError(blocks: readonly SearchReplaceBlock[]): ChangelogError | null {
  const conflict = findMarkerConflict(blocks);
  if (conflict === null) return null;
  return {
    error: 'marker_conflict',
    line: conflict.line,
    section: conflict.section,
    message:
      `The line "${conflict.line}" would appear in the ${conflict.section.toUpperCase()} part of the changelog ` +
      'and cannot be expressed there. Change that line (for example, write a Setext underline with a different ' +
      'number of "=" characters, or use a "#" heading) and try again.',
  };
}

/**
 * Builds the changelog that turns `base` (committed version `baseN` of draft
 * `id`) into `text`, as SEARCH/REPLACE blocks (ADAPTER_INTERFACE section 11).
 *
 * - Each SEARCH occurs exactly once in the base; context lines are added until it does.
 * - Blocks are ordered by base position; overlapping blocks are merged.
 * - The blocks are applied to the base as a self-check; on a mismatch a single
 *   block whose SEARCH is the whole base is emitted instead.
 * - Returns `{ error: 'no_changes' }` for identical text and
 *   `{ error: 'marker_conflict' }` when a line equals a marker line.
 */
export function buildChangelog(
  id: string,
  base: string,
  baseN: number,
  text: string,
): ChangelogFence | ChangelogError {
  const baseNorm = normalizeEol(base);
  const textNorm = normalizeEol(text);
  const baseLines = splitLines(baseNorm);
  const workLines = splitLines(textNorm);
  if (sameLines(baseLines, workLines)) {
    return { error: 'no_changes', message: 'There are no changes to add.' };
  }

  const hunks = diffLineHunks(baseLines, workLines);
  let blocks = planBlocks(baseLines, workLines, hunks).map((plan) => toBlock(plan, baseLines, workLines));
  if (blocks.length === 0 || tryApplyChangelogLines(baseLines, blocks) !== textNorm) {
    blocks = [{ search: baseNorm, replace: textNorm }];
  }

  const conflict = conflictError(blocks);
  if (conflict !== null) return conflict;
  return { id, from: baseN, to: baseN + 1, blocks };
}
