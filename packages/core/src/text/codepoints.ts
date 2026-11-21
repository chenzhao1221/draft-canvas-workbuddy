function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/**
 * Reads the code point starting at UTF-16 index `index`.
 * A lone surrogate is returned as itself. `width` is 1 or 2 code units.
 */
export function readCodePoint(text: string, index: number): { value: number; width: 1 | 2 } {
  const unit = text.charCodeAt(index);
  if (isHighSurrogate(unit) && index + 1 < text.length) {
    const next = text.charCodeAt(index + 1);
    if (isLowSurrogate(next)) {
      return { value: (unit - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000, width: 2 };
    }
  }
  return { value: unit, width: 1 };
}

/** Number of Unicode code points in `text`. */
export function codePointLength(text: string): number {
  let count = 0;
  let index = 0;
  while (index < text.length) {
    index += readCodePoint(text, index).width;
    count += 1;
  }
  return count;
}

/**
 * Converts a UTF-16 index into a code point offset: the number of code points
 * that start before `index`. The index is clamped to `[0, line.length]`; an
 * index inside a surrogate pair counts that pair as one code point.
 */
export function utf16ToCodePoint(line: string, index: number): number {
  const limit = Math.min(Math.max(Math.trunc(index), 0), line.length);
  let count = 0;
  let position = 0;
  while (position < limit) {
    position += readCodePoint(line, position).width;
    count += 1;
  }
  return count;
}

/**
 * Converts a code point offset into a UTF-16 index (start of the `offset`-th
 * code point). Offsets below 0 give 0; offsets past the end give `line.length`.
 */
export function codePointToUtf16(line: string, offset: number): number {
  const target = Math.max(Math.trunc(offset), 0);
  let count = 0;
  let position = 0;
  while (count < target && position < line.length) {
    position += readCodePoint(line, position).width;
    count += 1;
  }
  return position;
}
