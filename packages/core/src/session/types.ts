import type {
  DraftVersion,
  HistoryCompleteness,
  HostCapabilities,
  HostAdapterErrorCode,
  HostInfo,
  SessionRef,
  TranscriptFidelity,
  WorkingCopy,
} from '../adapter';
import type { ChangelogError } from '../changelog';
import type { StreamPreview } from '../fence';
import type { ReviewState } from '../review';

export type WorkingCopyStatus =
  | 'clean' // no working copy
  | 'dirty' // edits not staged
  | 'staged' // the current changelog was appended to the composer and not yet seen in a user message
  | 'staged-stale' // edited after staging: the composer holds an outdated changelog
  | 'sent' // a user message contains a changelog equal to the current one
  | 'stale-base'; // the base version is missing, changed, or no longer the latest

export type StaleReason = 'base_missing' | 'base_changed' | 'newer_version';

export interface PendingRewrite {
  /** n of the version the rewrite request referred to. */
  rev: number;
  /** ISO 8601, controller clock. */
  sentAt: string;
  /** true once the user message carrying the rewrite fence was seen. */
  confirmed: boolean;
}

export interface DraftState {
  draftId: string;
  /** Title of the latest version that has one. */
  title?: string;
  lang: string;
  /** Committed versions, `n = index + 1`. Empty for a draft that exists only as a streaming preview. */
  versions: DraftVersion[];
  workingCopy?: WorkingCopy;
  status: WorkingCopyStatus;
  /** Set when the working copy cannot be turned into a changelog (a marker line). */
  changelogError?: ChangelogError;
  /** Set with status `stale-base`. */
  staleReason?: StaleReason;
  /** true if the user may edit the latest version now (no review open, base is current). */
  editable: boolean;
  /** Streaming preview. Read-only, never a version; absent while the panel is hidden. */
  preview?: StreamPreview;
  review?: ReviewState;
  pendingRewrite?: PendingRewrite;
}

export type NoticeLevel = 'info' | 'warning' | 'error';

export type NoticeCode =
  | 'unclosed_draft'
  | 'version_updated'
  | 'rewrite_unanswered'
  | 'marker_conflict'
  | 'too_large'
  | 'storage_error'
  | 'unsupported_interface'
  | HostAdapterErrorCode;

export interface Notice {
  id: string;
  level: NoticeLevel;
  code: NoticeCode;
  message: string;
  draftId?: string;
}

export type SessionPhase = 'idle' | 'connecting' | 'loading' | 'ready' | 'error';

export type ConnectionState = 'connected' | 'reconnecting' | 'disconnected';

/** How the rewrite action reaches the host. */
export type RewriteMode =
  | 'send' // sendNow
  | 'compose' // no sendNow: the rewrite message goes into the composer and the user sends it
  | 'unavailable';

export interface SessionSnapshot {
  host: { info: HostInfo; capabilities: HostCapabilities };
  phase: SessionPhase;
  session: SessionRef | null;
  /** Sessions the user can pick from (empty if the adapter has no `listSessions`). */
  sessions: SessionRef[];
  completeness: HistoryCompleteness;
  /** From the capabilities, updated by the last `InjectResult`. */
  fidelity: TranscriptFidelity;
  connection: ConnectionState;
  /** false while the panel is hidden. */
  active: boolean;
  /** Where working copies are kept. `memory` means they are lost when the panel unmounts. */
  storageMode: 'host' | 'memory';
  rewrite: RewriteMode;
  /** Draft ids in order of first appearance, then preview-only drafts. */
  drafts: DraftState[];
  notices: Notice[];
}

export type StageStatus =
  | 'staged'
  | 'nothing_to_stage'
  | 'blocked' // every candidate has a marker conflict
  | 'too_large'
  | 'busy'
  | 'no_session'
  | 'error';

export interface StageResult {
  status: StageStatus;
  /** Drafts whose changelog was handed to the host. */
  stagedDraftIds: string[];
  /** Drafts skipped because their changelog cannot be expressed. */
  blockedDraftIds: string[];
  fidelity?: TranscriptFidelity;
  requiresUserSend?: boolean;
  /** Human-readable message for the panel. */
  message: string;
}

export type RewriteStatus =
  | 'sent'
  | 'queued_in_composer'
  | 'invalid_selection'
  | 'overlaps_edits'
  | 'empty_instruction'
  | 'stale_base'
  | 'too_large'
  | 'unavailable'
  | 'no_session'
  | 'error';

export interface RewriteResult {
  status: RewriteStatus;
  message: string;
}

/** A comment the user attached to a passage, waiting for the one combined send. */
export interface DraftComment {
  draftId: string;
  /** Range in the editor text (the working copy if one exists) when the comment was added. */
  range: { startLine: number; startOffset: number; endLine: number; endOffset: number };
  /** The text the range covered then; used to find the passage again after later edits. */
  quote: string;
  instruction: string;
}

export type DraftSendStatus =
  | 'sent'
  | 'queued_in_composer'
  | 'nothing_to_send'
  | 'blocked' // a changelog cannot be expressed (marker line)
  | 'stale_base'
  | 'newer_version' // the re-read before sending found a version the panel had not shown yet
  | 'comment_moved' // the commented text was edited away
  | 'empty_instruction'
  | 'too_large'
  | 'unavailable'
  | 'busy'
  | 'no_session'
  | 'error';

export interface DraftSendResult {
  status: DraftSendStatus;
  message: string;
  /** Drafts whose edits or comments went out. */
  draftIds: string[];
  /** For `comment_moved` and `empty_instruction`: index of the comment at fault. */
  commentIndex?: number;
}
