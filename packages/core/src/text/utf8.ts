import { readCodePoint } from './codepoints';

/** Replacement character, used for lone surrogates (as a UTF-8 encoder would). */
const REPLACEMENT = 0xfffd;

function isLoneSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdfff;
}

/** Calls `visit` with each UTF-8 byte of `text`, without allocating a byte array. */
export function forEachUtf8Byte(text: string, visit: (byte: number) => void): void {
  let index = 0;
  while (index < text.length) {
    const { value, width } = readCodePoint(text, index);
    index += width;
    const cp = isLoneSurrogate(value) ? REPLACEMENT : value;
    if (cp < 0x80) {
      visit(cp);
    } else if (cp < 0x800) {
      visit(0xc0 | (cp >> 6));
      visit(0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      visit(0xe0 | (cp >> 12));
      visit(0x80 | ((cp >> 6) & 0x3f));
      visit(0x80 | (cp & 0x3f));
    } else {
      visit(0xf0 | (cp >> 18));
      visit(0x80 | ((cp >> 12) & 0x3f));
      visit(0x80 | ((cp >> 6) & 0x3f));
      visit(0x80 | (cp & 0x3f));
    }
  }
}

/** Length of `text` in UTF-8 bytes. */
export function utf8ByteLength(text: string): number {
  let total = 0;
  let index = 0;
  while (index < text.length) {
    const { value, width } = readCodePoint(text, index);
    index += width;
    const cp = isLoneSurrogate(value) ? REPLACEMENT : value;
    total += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return total;
}
