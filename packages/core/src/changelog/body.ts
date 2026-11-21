import type { SearchReplaceBlock } from '../adapter';
import { splitLines } from '../text';

export const MARKER_BEGIN_PATCH = '*** Begin Patch';
export const MARKER_END_PATCH = '*** End Patch';
export const MARKER_SEARCH = '<<<<<<< SEARCH';
export const MARKER_DIVIDER = '=======';
export const MARKER_REPLACE = '>>>>>>> REPLACE';

/** Lines that cannot appear as SEARCH or REPLACE content (ADAPTER_INTERFACE section 11.2 rule 9). */
export const CHANGELOG_MARKERS: readonly string[] = [
  MARKER_SEARCH,
  MARKER_DIVIDER,
  MARKER_REPLACE,
  MARKER_BEGIN_PATCH,
  MARKER_END_PATCH,
];

export function isMarkerLine(line: string): boolean {
  return CHANGELOG_MARKERS.includes(line);
}

/**
 * Formats blocks as the body of a `draft-changelog` fence.
 *
 * An empty `search` or `replace` string is written as zero lines (this is how
 * a deletion and the "empty base" block look on the wire). The builder never
 * produces a block whose text is a single empty line for the same reason.
 */
export function formatChangelogBody(blocks: readonly SearchReplaceBlock[]): string {
  const out: string[] = [MARKER_BEGIN_PATCH];
  for (const block of blocks) {
    out.push(MARKER_SEARCH);
    if (block.search !== '') out.push(...splitLines(block.search));
    out.push(MARKER_DIVIDER);
    if (block.replace !== '') out.push(...splitLines(block.replace));
    out.push(MARKER_REPLACE);
  }
  out.push(MARKER_END_PATCH);
  return out.join('\n');
}

/**
 * Parses the body of a `draft-changelog` fence. Returns null if the body is
 * not exactly `*** Begin Patch`, one or more blocks, `*** End Patch`.
 */
export function parseChangelogBody(body: string): SearchReplaceBlock[] | null {
  const lines = splitLines(body);
  if (lines.length < 5 || lines[0] !== MARKER_BEGIN_PATCH || lines[lines.length - 1] !== MARKER_END_PATCH) {
    return null;
  }
  const blocks: SearchReplaceBlock[] = [];
  let i = 1;
  const end = lines.length - 1;
  while (i < end) {
    if (lines[i] !== MARKER_SEARCH) return null;
    i += 1;
    const search: string[] = [];
    while (i < end && lines[i] !== MARKER_DIVIDER) {
      if (isMarkerLine(lines[i] as string)) return null;
      search.push(lines[i] as string);
      i += 1;
    }
    if (i >= end) return null;
    i += 1; // divider
    const replace: string[] = [];
    while (i < end && lines[i] !== MARKER_REPLACE) {
      if (isMarkerLine(lines[i] as string)) return null;
      replace.push(lines[i] as string);
      i += 1;
    }
    if (i >= end) return null;
    i += 1; // replace marker
    blocks.push({ search: search.join('\n'), replace: replace.join('\n') });
  }
  return blocks.length > 0 ? blocks : null;
}
