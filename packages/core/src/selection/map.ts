import { diffLineHunks, normalizeEol, splitLines } from '../text';
import { isValidRange, type SelectionRange } from './range';

/**
 * For each working line, the index of the same line in the base, or -1 if the
 * line was added or changed.
 */
function unchangedLineMap(baseLines: readonly string[], workLines: readonly string[]): number[] {
  const map: number[] = new Array<number>(workLines.length).fill(-1);
  let a = 0;
  let b = 0;
  for (const h of diffLineHunks(baseLines, workLines)) {
    while (b < h.bStart) {
      map[b] = a;
      a += 1;
      b += 1;
    }
    a = h.aEnd;
    b = h.bEnd;
  }
  while (b < workLines.length) {
    map[b] = a;
    a += 1;
    b += 1;
  }
  return map;
}

/**
 * Maps a selection made in the working copy back to the base version
 * (ADAPTER_INTERFACE section 12.1). Succeeds only if every line the selection
 * touches is unchanged since the base and the lines are still adjacent there;
 * otherwise (edited, added or removed text inside the selection) returns null.
 * `range` must be valid for `working`.
 */
export function mapWorkingRangeToBase(
  base: string,
  working: string,
  range: SelectionRange,
): SelectionRange | null {
  if (!isValidRange(working, range)) return null;
  const map = unchangedLineMap(splitLines(normalizeEol(base)), splitLines(normalizeEol(working)));
  const first = map[range.startLine - 1] as number;
  if (first < 0) return null;
  for (let line = range.startLine; line <= range.endLine; line += 1) {
    const mapped = map[line - 1] as number;
    if (mapped < 0 || mapped !== first + (line - range.startLine)) return null;
  }
  return {
    startLine: first + 1,
    startOffset: range.startOffset,
    endLine: first + 1 + (range.endLine - range.startLine),
    endOffset: range.endOffset,
  };
}
