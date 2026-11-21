import type { ChangelogFence, DraftFence, RewriteRequest } from '../adapter';
import { parseChangelogBody } from '../changelog/body';
import { normalizeEol, splitLines } from '../text';
import type { Attrs } from './attrs';
import { scanFences, type ScannedFence } from './scan';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DECIMAL = /^[0-9]+$/;

/**
 * Id given to a `draft` fence that has no `id` attribute at all. Every id-less
 * draft of a session shares it, so they form one version chain.
 */
export const DEFAULT_DRAFT_ID = 'draft-1';

/** True if `id` satisfies ADAPTER_INTERFACE section 10.2. */
export function isValidDraftId(id: string | undefined): id is string {
  return id !== undefined && ID_PATTERN.test(id);
}

/** A decimal integer >= `min` (and a safe integer), or null. */
function parseInteger(value: string | undefined, min: number): number | null {
  if (value === undefined || !DECIMAL.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min ? n : null;
}

/** True if the info text names an id key, even when its value is malformed and was dropped. */
function mentionsId(attrText: string): boolean {
  return /(?:^|[ \t])id=/.test(attrText);
}

function idOf(attrs: Attrs): string | null {
  const id = attrs['id'];
  return isValidDraftId(id) ? id : null;
}

/**
 * All `draft` fences with a valid id, in message order, closed or not.
 * A fence with no `id` attribute gets `DEFAULT_DRAFT_ID`; a fence whose
 * explicit `id` is empty or invalid is skipped.
 * Callers that commit versions must keep only `closed` fences.
 */
export function parseDraftFences(text: string): DraftFence[] {
  const out: DraftFence[] = [];
  for (const fence of scanFences(text)) {
    if (fence.kind !== 'draft') continue;
    const id = fence.attrs['id'] === undefined && !mentionsId(fence.attrText) ? DEFAULT_DRAFT_ID : idOf(fence.attrs);
    if (id === null) continue;
    const lang = fence.attrs['lang'];
    const draft: DraftFence = {
      id,
      lang: lang === undefined || lang === '' ? 'markdown' : lang,
      body: fence.body,
      closed: fence.closed,
      fenceIndex: out.length,
      fenceLength: fence.fenceLength,
    };
    const rev = fence.attrs['rev'];
    if (rev !== undefined) draft.rev = rev;
    const title = fence.attrs['title'];
    if (title !== undefined) draft.title = title;
    out.push(draft);
  }
  return out;
}

/** Closed `draft-changelog` fences with valid `id`, `from`, `to` and body, in message order. */
export function parseChangelogFences(text: string): ChangelogFence[] {
  const out: ChangelogFence[] = [];
  for (const fence of scanFences(text)) {
    if (fence.kind !== 'draft-changelog' || !fence.closed) continue;
    const id = idOf(fence.attrs);
    const from = parseInteger(fence.attrs['from'], 1);
    const to = parseInteger(fence.attrs['to'], 1);
    if (id === null || from === null || to === null) continue;
    const blocks = parseChangelogBody(fence.body);
    if (blocks === null) continue;
    out.push({ id, from, to, blocks });
  }
  return out;
}

/** The text between the end of `fence` and the start of the next scanned fence (or the end), trimmed. */
function instructionAfter(lines: readonly string[], fence: ScannedFence, next: ScannedFence | undefined): string {
  const from = fence.endLine + 1;
  const to = next === undefined ? lines.length : next.startLine;
  return lines.slice(from, to).join('\n').trim();
}

/**
 * Closed `draft-rewrite` fences with valid attributes, consistent coordinates
 * and a non-empty instruction, in message order. The instruction is the text
 * after the fence, up to the next recognized fence.
 */
export function parseRewriteFences(text: string): RewriteRequest[] {
  const lines = splitLines(normalizeEol(text));
  const fences = scanFences(text);
  const out: RewriteRequest[] = [];
  for (let i = 0; i < fences.length; i += 1) {
    const fence = fences[i] as ScannedFence;
    if (fence.kind !== 'draft-rewrite' || !fence.closed) continue;
    const id = idOf(fence.attrs);
    const rev = parseInteger(fence.attrs['rev'], 1);
    const startLine = parseInteger(fence.attrs['start_line'], 1);
    const endLine = parseInteger(fence.attrs['end_line'], 1);
    const startOffset = parseInteger(fence.attrs['start_offset'], 0);
    const endOffset = parseInteger(fence.attrs['end_offset'], 0);
    if (id === null || rev === null || startLine === null || endLine === null) continue;
    if (startOffset === null || endOffset === null) continue;
    if (endLine < startLine) continue;
    if (endLine === startLine && endOffset <= startOffset) continue;
    if (splitLines(fence.body).length !== endLine - startLine + 1) continue;
    const instruction = instructionAfter(lines, fence, fences[i + 1]);
    if (instruction === '') continue;
    out.push({ id, rev, startLine, endLine, startOffset, endOffset, selection: fence.body, instruction });
  }
  return out;
}
