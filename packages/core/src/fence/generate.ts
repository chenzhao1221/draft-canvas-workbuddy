import type { ChangelogFence, DraftFence, FenceKind, RewriteRequest } from '../adapter';
import { formatChangelogBody } from '../changelog/body';
import { normalizeEol, splitLines } from '../text';
import { formatAttrs, type AttrInput } from './attrs';

const LEADING_TICKS = /^ {0,3}(`+)/;

/**
 * Fence length for `body` (ADAPTER_INTERFACE section 10.4):
 * `max(3, 1 + longest run of backticks that starts a body line after 0-3 spaces)`.
 */
export function fenceLengthFor(body: string): number {
  let longest = 0;
  for (const line of splitLines(normalizeEol(body))) {
    const m = LEADING_TICKS.exec(line);
    if (m !== null && (m[1] as string).length > longest) longest = (m[1] as string).length;
  }
  return Math.max(3, longest + 1);
}

/** Writes one fence. An empty body is written as zero lines between the fence lines. */
function formatFence(kind: FenceKind, attrs: AttrInput, rawBody: string): string {
  const body = normalizeEol(rawBody);
  const ticks = '`'.repeat(fenceLengthFor(body));
  const head = `${ticks}${kind}${formatAttrs(attrs)}`;
  return body === '' ? `${head}\n${ticks}` : `${head}\n${body}\n${ticks}`;
}

export type DraftFenceInput = Pick<DraftFence, 'id' | 'body'> & Partial<Pick<DraftFence, 'rev' | 'title' | 'lang'>>;

/** A `draft` fence (written by the assistant; the plugin only generates it for tests and docs). */
export function formatDraftFence(draft: DraftFenceInput): string {
  return formatFence(
    'draft',
    { id: draft.id, rev: draft.rev, title: draft.title, lang: draft.lang ?? 'markdown' },
    draft.body,
  );
}

/**
 * A `draft-changelog` fence. The output is the canonical text that
 * `stagedHash` and `sentHash` are computed from.
 */
export function formatChangelogFence(changelog: ChangelogFence): string {
  return formatFence(
    'draft-changelog',
    { id: changelog.id, from: changelog.from, to: changelog.to },
    formatChangelogBody(changelog.blocks),
  );
}

/** Several changelog fences joined by one blank line, as `injectNextTurn` expects. */
export function joinFences(fences: readonly string[]): string {
  return fences.join('\n\n');
}

/** The message sent for a selection rewrite: the fence, a blank line, the instruction. */
export function formatRewriteMessage(request: RewriteRequest): string {
  const fence = formatFence(
    'draft-rewrite',
    {
      id: request.id,
      rev: request.rev,
      start_line: request.startLine,
      end_line: request.endLine,
      start_offset: request.startOffset,
      end_offset: request.endOffset,
    },
    request.selection,
  );
  return `${fence}\n\n${request.instruction}`;
}
