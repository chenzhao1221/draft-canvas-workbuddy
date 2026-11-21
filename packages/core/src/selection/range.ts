import { codePointLength, codePointToUtf16, normalizeEol, splitLines } from '../text';

/**
 * A half-open selection (ADAPTER_INTERFACE section 12.1). Lines are 1-based.
 * Offsets are Unicode code points from the start of their line; `startOffset`
 * is inclusive and `endOffset` is exclusive.
 */
export interface SelectionRange {
  startLine: number;
  startOffset: number;
  endLine: number;
  endOffset: number;
}

function isInt(n: number): boolean {
  return Number.isInteger(n);
}

/**
 * True if `range` lies inside `text` and is non-empty: lines in bounds,
 * `endLine >= startLine`, offsets within their lines, and
 * `endOffset > startOffset` when both ends are on the same line.
 */
export function isValidRange(text: string, range: SelectionRange): boolean {
  const lines = splitLines(normalizeEol(text));
  const { startLine, startOffset, endLine, endOffset } = range;
  if (![startLine, startOffset, endLine, endOffset].every(isInt)) return false;
  if (startLine < 1 || endLine < startLine || endLine > lines.length) return false;
  if (startOffset < 0 || endOffset < 0) return false;
  if (startOffset > codePointLength(lines[startLine - 1] as string)) return false;
  if (endOffset > codePointLength(lines[endLine - 1] as string)) return false;
  if (startLine === endLine && endOffset <= startOffset) return false;
  return true;
}

/**
 * The exact text covered by `range`, with `\n` between lines.
 * Returns null if the range is not valid for `text`.
 */
export function extractSelection(text: string, range: SelectionRange): string | null {
  if (!isValidRange(text, range)) return null;
  const lines = splitLines(normalizeEol(text));
  const first = lines[range.startLine - 1] as string;
  const last = lines[range.endLine - 1] as string;
  if (range.startLine === range.endLine) {
    return first.slice(codePointToUtf16(first, range.startOffset), codePointToUtf16(first, range.endOffset));
  }
  const parts: string[] = [first.slice(codePointToUtf16(first, range.startOffset))];
  for (let l = range.startLine; l < range.endLine - 1; l += 1) parts.push(lines[l] as string);
  parts.push(last.slice(0, codePointToUtf16(last, range.endOffset)));
  return parts.join('\n');
}

/** The range covering `text[from, to)` (UTF-16 indexes into `text`, which uses `\n` line endings). */
function rangeFromIndexes(text: string, from: number, to: number): SelectionRange {
  const at = (index: number): { line: number; offset: number } => {
    const before = text.slice(0, index);
    const lineStart = before.lastIndexOf('\n') + 1;
    const line = before.split('\n').length;
    return { line, offset: codePointLength(text.slice(lineStart, index)) };
  };
  const start = at(from);
  const end = at(to);
  return { startLine: start.line, startOffset: start.offset, endLine: end.line, endOffset: end.offset };
}

/**
 * Finds where `quote` is in `text` now. If `hint` still covers exactly `quote`, it is returned as is.
 * Otherwise the occurrence of `quote` nearest to the hint's old start line is used. `null` when `quote`
 * no longer appears (the user edited the commented text itself).
 */
export function locateQuote(text: string, quote: string, hint: SelectionRange): SelectionRange | null {
  const normalized = normalizeEol(text);
  if (quote === '') return null;
  if (extractSelection(normalized, hint) === quote) return hint;
  let best: SelectionRange | null = null;
  let bestDistance = Infinity;
  for (let index = normalized.indexOf(quote); index !== -1; index = normalized.indexOf(quote, index + 1)) {
    const range = rangeFromIndexes(normalized, index, index + quote.length);
    const distance = Math.abs(range.startLine - hint.startLine);
    if (distance < bestDistance) {
      best = range;
      bestDistance = distance;
    }
  }
  return best;
}
