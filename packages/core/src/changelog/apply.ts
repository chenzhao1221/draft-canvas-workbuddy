import type { SearchReplaceBlock } from '../adapter';
import { joinLines, normalizeEol, splitLines } from '../text';
import { locateBlocks, replaceLinesOf, type ChangelogValidationReason } from './locate';

export class ChangelogApplyError extends Error {
  readonly name = 'ChangelogApplyError';
  constructor(
    readonly reason: ChangelogValidationReason,
    readonly blockIndex: number,
  ) {
    super(`Cannot apply changelog: block ${blockIndex + 1} (${reason})`);
  }
}

/** Applies already-located blocks; returns null if they cannot be located in `baseLines`. */
export function tryApplyChangelogLines(
  baseLines: readonly string[],
  blocks: readonly SearchReplaceBlock[],
): string | null {
  const located = locateBlocks(baseLines, blocks);
  if (!located.ok) return null;
  const out: string[] = [];
  let pos = 0;
  for (let b = 0; b < blocks.length; b += 1) {
    const range = located.ranges[b] as { start: number; end: number };
    for (let i = pos; i < range.start; i += 1) out.push(baseLines[i] as string);
    out.push(...replaceLinesOf((blocks[b] as SearchReplaceBlock).replace));
    pos = range.end;
  }
  for (let i = pos; i < baseLines.length; i += 1) out.push(baseLines[i] as string);
  return joinLines(out);
}

/**
 * Applies `blocks` to `base`. Every SEARCH is located in the base text, not in
 * the partly edited result (ADAPTER_INTERFACE section 11.2 rule 6).
 * Throws `ChangelogApplyError` if a block cannot be located; use
 * `validateChangelog` to check first without throwing.
 */
export function applyChangelog(base: string, blocks: readonly SearchReplaceBlock[]): string {
  const baseLines = splitLines(normalizeEol(base));
  const located = locateBlocks(baseLines, blocks);
  if (!located.ok) throw new ChangelogApplyError(located.reason, located.blockIndex);
  const result = tryApplyChangelogLines(baseLines, blocks);
  /* c8 ignore next */
  if (result === null) throw new ChangelogApplyError('no_match', 0);
  return result;
}
