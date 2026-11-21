import type { RewriteRequest } from '../adapter';
import { isValidDraftId } from '../fence/parse';
import { extractSelection, isValidRange, type SelectionRange } from './range';

export type RewriteErrorCode = 'invalid_id' | 'invalid_rev' | 'invalid_range' | 'empty_instruction';

export type RewriteBuildResult =
  | { ok: true; request: RewriteRequest }
  | { ok: false; error: RewriteErrorCode; message: string };

export interface RewriteInput {
  /** Draft id. */
  id: string;
  /** Plugin version number `n` of `body`. */
  rev: number;
  /** Full text of version `rev` (not a working copy). */
  body: string;
  /** Selection in the coordinates of `body`. */
  range: SelectionRange;
  /** The user's instruction; must be non-empty after trimming. */
  instruction: string;
}

/**
 * Builds the `draft-rewrite` request for a selection of a committed version.
 * The selection text is cut from `body` itself, so it is exact by construction.
 * Coordinates are 1-based lines and code-point offsets, end exclusive.
 */
export function toRewriteRequest(input: RewriteInput): RewriteBuildResult {
  if (!isValidDraftId(input.id)) {
    return { ok: false, error: 'invalid_id', message: 'The draft id is not valid.' };
  }
  if (!Number.isInteger(input.rev) || input.rev < 1) {
    return { ok: false, error: 'invalid_rev', message: 'The version number must be 1 or greater.' };
  }
  const instruction = input.instruction.trim();
  if (instruction === '') {
    return { ok: false, error: 'empty_instruction', message: 'Write an instruction for the selected text.' };
  }
  if (!isValidRange(input.body, input.range)) {
    return { ok: false, error: 'invalid_range', message: 'The selection is empty or outside the text.' };
  }
  const selection = extractSelection(input.body, input.range) as string;
  return {
    ok: true,
    request: {
      id: input.id,
      rev: input.rev,
      startLine: input.range.startLine,
      endLine: input.range.endLine,
      startOffset: input.range.startOffset,
      endOffset: input.range.endOffset,
      selection,
      instruction,
    },
  };
}
