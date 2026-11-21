export type FenceKind = 'draft' | 'draft-changelog' | 'draft-rewrite';

/** A parsed `draft` fence. */
export interface DraftFence {
  id: string;
  /** The model's advisory rev attribute, verbatim. Never used for numbering. */
  rev?: string;
  title?: string;
  /** Defaults to 'markdown'. */
  lang: string;
  /** Text between the opening and closing fence lines, LF-normalized, no trailing newline. */
  body: string;
  /** false if the message ended before a closing fence. Never committed. */
  closed: boolean;
  /** 0-based index of this fence among recognized draft fences of the message. */
  fenceIndex: number;
  /** Number of backticks in the opening fence (>= 3). */
  fenceLength: number;
}

/** A committed version. */
export interface DraftVersion {
  draftId: string;
  /** 1-based plugin version number: count of committed appearances of draftId in the session. */
  n: number;
  sourceMessageId: string;
  fenceIndex: number;
  revHint?: string;
  title?: string;
  lang: string;
  body: string;
  /** createdAt of the source message. */
  createdAt: string;
}

/** Uncommitted local edits against a committed version. */
export interface WorkingCopy {
  sessionId: string;
  draftId: string;
  /** n of the committed version the edits are based on. */
  baseVersion: number;
  /** hashText(body of the base version); detects a base that changed after rebuild. */
  baseHash: string;
  /** Full current text of the working copy. */
  text: string;
  /** ISO 8601. */
  updatedAt: string;
  /** hashText(canonical changelog fence) last appended to the composer, if any. */
  stagedHash?: string;
  /** hashText(canonical changelog fence) last seen in a sent user message, if any. */
  sentHash?: string;
}

export interface SearchReplaceBlock {
  /** Lines of the base version (joined with '\n'). Empty only if the base body is empty. */
  search: string;
  /** Replacement lines (joined with '\n'). May be empty (deletion). */
  replace: string;
}

/** A `draft-changelog` fence. */
export interface ChangelogFence {
  id: string;
  /** n of the base version. */
  from: number;
  /** from + 1: the version number the next draft fence for id will receive. Advisory. */
  to: number;
  blocks: SearchReplaceBlock[];
}

/** A `draft-rewrite` request. */
export interface RewriteRequest {
  id: string;
  /** n of the version the coordinates refer to. */
  rev: number;
  startLine: number; // 1-based
  endLine: number; // 1-based, >= startLine
  startOffset: number; // code points from the start of startLine, inclusive
  endOffset: number; // code points from the start of endLine, exclusive
  /** Exact selected text of version rev. */
  selection: string;
  /** The user's instruction, non-empty, written after the fence. */
  instruction: string;
}
