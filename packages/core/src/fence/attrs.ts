/** Parsed fence attributes. Keys are lowercase ASCII; the object has no prototype. */
export type Attrs = Readonly<Record<string, string>>;

export type AttrInput = Readonly<Record<string, string | number | undefined>>;

const BARE_VALUE = /^[A-Za-z0-9._-]+$/;
const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

function isWsp(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t';
}

function isLower(code: number): boolean {
  return code >= 0x61 && code <= 0x7a;
}

function isKeyChar(code: number): boolean {
  return isLower(code) || (code >= 0x30 && code <= 0x39) || code === 0x5f;
}

/** Index of the first whitespace at or after `from` (or the string length). */
function skipToken(info: string, from: number): number {
  let i = from;
  while (i < info.length && !isWsp(info[i])) i += 1;
  return i;
}

/**
 * Reads a double-quoted value starting just after the opening quote.
 * Only `\"` and `\\` are escapes. Returns null if the value is malformed
 * (no closing quote, other escape, backtick or line break inside).
 */
function readQuoted(info: string, from: number): { value: string; end: number } | null {
  let value = '';
  let i = from;
  while (i < info.length) {
    const ch = info[i] as string;
    if (ch === '"') return { value, end: i + 1 };
    if (ch === '\\') {
      const next = info[i + 1];
      if (next !== '"' && next !== '\\') return null;
      value += next;
      i += 2;
      continue;
    }
    if (ch === '`' || ch === '\n' || ch === '\r') return null;
    value += ch;
    i += 1;
  }
  return null;
}

/**
 * Parses the attribute part of a fence info string (the text after the kind),
 * per ADAPTER_INTERFACE section 10.1: quoted values with `\"` and `\\`, bare
 * values, unknown keys kept (callers ignore them), the last repeated key wins,
 * tokens that are not valid attributes are ignored.
 */
export function parseAttrs(info: string): Attrs {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  const n = info.length;
  let i = 0;
  while (i < n) {
    while (i < n && isWsp(info[i])) i += 1;
    if (i >= n) break;
    const keyStart = i;
    if (!isLower(info.charCodeAt(i))) {
      i = skipToken(info, i);
      continue;
    }
    i += 1;
    while (i < n && isKeyChar(info.charCodeAt(i))) i += 1;
    if (info[i] !== '=') {
      i = skipToken(info, i);
      continue;
    }
    const key = info.slice(keyStart, i);
    i += 1;
    if (info[i] === '"') {
      const quoted = readQuoted(info, i + 1);
      if (quoted === null) {
        i = skipToken(info, i);
        continue;
      }
      if (quoted.end < n && !isWsp(info[quoted.end])) {
        i = skipToken(info, quoted.end);
        continue;
      }
      out[key] = quoted.value;
      i = quoted.end;
    } else {
      const start = i;
      i = skipToken(info, i);
      const token = info.slice(start, i);
      if (BARE_VALUE.test(token)) out[key] = token;
    }
  }
  return out;
}

/** Makes a value safe for a quoted attribute (section 10.1 rule 5). */
export function escapeAttrValue(value: string): string {
  return value
    .replace(/`/g, "'")
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

/**
 * Formats attributes as ` key="value" key2="value2"` (with a leading space
 * before each pair, so it can follow the kind directly). Undefined values and
 * invalid keys are skipped. Values are always quoted.
 */
export function formatAttrs(attrs: AttrInput): string {
  let out = '';
  for (const key of Object.keys(attrs)) {
    const value = attrs[key];
    if (value === undefined || !KEY_PATTERN.test(key)) continue;
    out += ` ${key}="${escapeAttrValue(String(value))}"`;
  }
  return out;
}
