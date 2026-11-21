import { diffLines } from 'diff';

/**
 * One maximal run of differing lines: `a[aStart, aEnd)` is replaced by
 * `b[bStart, bEnd)`. Indices are 0-based and the ends are exclusive. A pure
 * insertion has `aStart === aEnd`; a pure deletion has `bStart === bEnd`.
 */
export interface LineHunk {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

function countLines(chunk: string): number {
  let count = 0;
  for (let i = 0; i < chunk.length; i += 1) {
    if (chunk.charCodeAt(i) === 10) count += 1;
  }
  return count;
}

/** Terminates every line with `\n` so that jsdiff compares whole lines exactly. */
function toDiffInput(lines: readonly string[]): string {
  let out = '';
  for (const line of lines) out += `${line}\n`;
  return out;
}

/** Line diff of two line arrays using jsdiff's `diffLines`. Hunks are in ascending order. */
export function diffLineHunks(a: readonly string[], b: readonly string[]): LineHunk[] {
  if (a.length === 0 && b.length === 0) return [];
  const changes = diffLines(toDiffInput(a), toDiffInput(b));
  const hunks: LineHunk[] = [];
  let ia = 0;
  let ib = 0;
  let open: LineHunk | null = null;
  for (const change of changes) {
    const lines = countLines(change.value);
    if (change.added !== true && change.removed !== true) {
      open = null;
      ia += lines;
      ib += lines;
      continue;
    }
    if (open === null) {
      open = { aStart: ia, aEnd: ia, bStart: ib, bEnd: ib };
      hunks.push(open);
    }
    if (change.removed === true) {
      ia += lines;
      open.aEnd = ia;
    } else {
      ib += lines;
      open.bEnd = ib;
    }
  }
  return hunks;
}
