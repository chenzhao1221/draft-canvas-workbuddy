import { diffLineHunks, joinLines, normalizeEol, splitLines } from '../text';

/**
 * One run of differing lines between a left text and a right text. Line
 * indices are 0-based and the ends are exclusive. A pure insertion has
 * `leftStart === leftEnd`; a pure deletion has `rightStart === rightEnd`.
 */
export interface Hunk {
  /** Position in the list returned by `computeHunks`. */
  index: number;
  leftStart: number;
  leftEnd: number;
  rightStart: number;
  rightEnd: number;
  /** The left lines of the hunk joined with `\n` ('' for a pure insertion). */
  leftText: string;
  /** The right lines of the hunk joined with `\n` ('' for a pure deletion). */
  rightText: string;
}

/** A reviewer's choice for one hunk. `accept` takes the right text, `reject` keeps the left text. */
export type HunkDecision = 'accept' | 'reject';

/** State of a per-hunk review (design section 3.1). `null` decisions are undecided. */
export interface ReviewState {
  /** The text the user is reviewing against (their working copy, or the previous version). */
  leftText: string;
  leftLabel: string;
  /** The new version being reviewed. */
  rightVersion: number;
  rightText: string;
  hunks: Hunk[];
  decisions: (HunkDecision | null)[];
}

/** Line-based hunks that turn `left` into `right`, in ascending order. */
export function computeHunks(left: string, right: string): Hunk[] {
  const leftLines = splitLines(normalizeEol(left));
  const rightLines = splitLines(normalizeEol(right));
  return diffLineHunks(leftLines, rightLines).map((h, index) => ({
    index,
    leftStart: h.aStart,
    leftEnd: h.aEnd,
    rightStart: h.bStart,
    rightEnd: h.bEnd,
    leftText: joinLines(leftLines.slice(h.aStart, h.aEnd)),
    rightText: joinLines(rightLines.slice(h.bStart, h.bEnd)),
  }));
}

/**
 * Combines `left` and `right` according to per-hunk decisions: an accepted
 * hunk takes the right lines, a rejected hunk keeps the left lines. A missing
 * or `null` decision counts as `reject`, so the user's own text is never
 * dropped by accident. All `accept` gives `right`; all `reject` gives `left`.
 */
export function resolveReview(
  left: string,
  right: string,
  decisions: readonly (HunkDecision | null | undefined)[],
): string {
  const leftLines = splitLines(normalizeEol(left));
  const rightLines = splitLines(normalizeEol(right));
  const out: string[] = [];
  let pos = 0;
  diffLineHunks(leftLines, rightLines).forEach((h, i) => {
    for (let l = pos; l < h.aStart; l += 1) out.push(leftLines[l] as string);
    if (decisions[i] === 'accept') {
      for (let l = h.bStart; l < h.bEnd; l += 1) out.push(rightLines[l] as string);
    } else {
      for (let l = h.aStart; l < h.aEnd; l += 1) out.push(leftLines[l] as string);
    }
    pos = h.aEnd;
  });
  for (let l = pos; l < leftLines.length; l += 1) out.push(leftLines[l] as string);
  return joinLines(out);
}
