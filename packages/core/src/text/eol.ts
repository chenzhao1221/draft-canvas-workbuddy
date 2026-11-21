/** Converts `\r\n` and lone `\r` to `\n`. */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** Splits on `\n`. The empty string is one empty line, so the result is never empty. */
export function splitLines(text: string): string[] {
  return text.split('\n');
}

/** Inverse of `splitLines`. */
export function joinLines(lines: readonly string[]): string {
  return lines.join('\n');
}
