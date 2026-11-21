import type { FenceKind } from '../adapter';
import { normalizeEol, splitLines } from '../text';
import { parseAttrs, type Attrs } from './attrs';

/** A top-level fence of one of the three reserved kinds. */
export interface ScannedFence {
  kind: FenceKind;
  attrs: Attrs;
  /** The raw text after the kind in the info string (before attribute parsing). */
  attrText: string;
  /** Lines strictly between the opening and closing lines, joined with `\n`. */
  body: string;
  closed: boolean;
  /** Number of backticks in the opening fence. */
  fenceLength: number;
  /** Spaces before the opening fence (0-3). */
  indent: number;
  /** 0-based index of the opening line in the LF-normalized text. */
  startLine: number;
  /** 0-based index of the closing line, or of the last line when unclosed. */
  endLine: number;
}

const OPEN_LINE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const KIND_INFO = /^(draft-changelog|draft-rewrite|draft)(?:[ \t]+(.*?))?[ \t]*$/;
/** A list marker at indent 0-3: bullet or ordered, followed by spaces or end of line. */
const LIST_MARKER = /^( {0,3})([-+*]|\d{1,9}[.)])( *)(.*)$/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?: *\1){2,} *$/;

/**
 * Content indent of a list item that starts on `line`, or null if the line does
 * not start one. Follows CommonMark: 1-4 spaces after the marker set the content
 * column; 5 or more, or nothing after the marker, mean marker width + 1.
 */
function listContentIndent(line: string): number | null {
  if (THEMATIC_BREAK.test(line)) return null;
  const m = LIST_MARKER.exec(line);
  if (m === null) return null;
  const spaces = (m[3] as string).length;
  const rest = m[4] as string;
  // A marker must be followed by a space or end the line.
  if (spaces === 0 && rest !== '') return null;
  const base = (m[1] as string).length + (m[2] as string).length;
  return spaces >= 1 && spaces <= 4 && rest !== '' ? base + spaces : base + 1;
}

function leadingSpaces(line: string): number {
  let i = 0;
  while (line[i] === ' ') i += 1;
  return i;
}

interface OpenFence {
  char: '`' | '~';
  length: number;
  indent: number;
  startLine: number;
  /** Kind and attribute text when the opener is a reserved kind. */
  kind: FenceKind | null;
  attrText: string;
}

/** True if `line` closes a fence opened with `length` copies of `char`. */
function closesFence(line: string, char: string, length: number): boolean {
  let i = 0;
  while (i < 3 && line[i] === ' ') i += 1;
  let run = 0;
  while (line[i + run] === char) run += 1;
  if (run < length) return false;
  for (let j = i + run; j < line.length; j += 1) {
    const ch = line[j];
    if (ch !== ' ' && ch !== '\t') return false;
  }
  return true;
}

function stripIndent(line: string, indent: number): string {
  let i = 0;
  while (i < indent && line[i] === ' ') i += 1;
  return i === 0 ? line : line.slice(i);
}

function finish(open: OpenFence, bodyLines: string[], closed: boolean, endLine: number): ScannedFence | null {
  if (open.kind === null) return null;
  return {
    kind: open.kind,
    attrs: parseAttrs(open.attrText),
    attrText: open.attrText,
    body: bodyLines.map((l) => stripIndent(l, open.indent)).join('\n'),
    closed,
    fenceLength: open.length,
    indent: open.indent,
    startLine: open.startLine,
    endLine,
  };
}

/**
 * Scans a message for top-level fenced blocks (ADAPTER_INTERFACE section 10.1)
 * and returns those whose kind is `draft`, `draft-changelog` or `draft-rewrite`.
 *
 * All backtick and tilde fences are tracked, so a draft opener inside another
 * fenced block is content. Fences in block quotes or list items and lines
 * indented by 4 or more spaces are not fences. Never throws.
 */
export function scanFences(text: string): ScannedFence[] {
  const lines = splitLines(normalizeEol(text));
  const found: ScannedFence[] = [];
  let open: OpenFence | null = null;
  let bodyLines: string[] = [];
  /** Content indent of the list item the scanner is currently inside, or null. */
  let listIndent: number | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (open === null) {
      // Lightweight list-item context (blank lines never end an item).
      let insideItem = false;
      if (line.trim() !== '') {
        if (listIndent !== null && leadingSpaces(line) < listIndent) listIndent = null;
        if (listIndent === null) listIndent = listContentIndent(line);
        else insideItem = true;
      }
      const m = OPEN_LINE.exec(line);
      if (m === null) continue;
      const ticks = m[2] as string;
      const rest = m[3] as string;
      const char = ticks[0] as '`' | '~';
      if (char === '`' && rest.includes('`')) continue; // not a fence opener (CommonMark)
      let kind: FenceKind | null = null;
      let attrText = '';
      if (char === '`' && !insideItem) {
        const k = KIND_INFO.exec(rest);
        if (k !== null) {
          kind = k[1] as FenceKind;
          attrText = k[2] ?? '';
        }
      }
      // A fence inside a list item is still tracked (its body is content) but never reported.
      open = { char, length: ticks.length, indent: (m[1] as string).length, startLine: i, kind, attrText };
      bodyLines = [];
      continue;
    }
    if (closesFence(line, open.char, open.length)) {
      const fence = finish(open, bodyLines, true, i);
      if (fence !== null) found.push(fence);
      open = null;
      bodyLines = [];
      continue;
    }
    bodyLines.push(line);
  }

  if (open !== null) {
    // A trailing newline produces a final empty element that is not a real line.
    if (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '' && lines[lines.length - 1] === '') {
      bodyLines.pop();
    }
    const fence = finish(open, bodyLines, false, Math.max(open.startLine, open.startLine + bodyLines.length));
    if (fence !== null) found.push(fence);
  }
  return found;
}
