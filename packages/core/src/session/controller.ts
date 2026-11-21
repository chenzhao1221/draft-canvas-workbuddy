import {
  HostAdapterError,
  INTERFACE_VERSION,
  type ChangelogFence,
  type DraftVersion,
  type HistoryCompleteness,
  type HostAdapter,
  type HostEvent,
  type InjectResult,
  type Message,
  type SessionRef,
  type TranscriptFidelity,
  type WorkingCopy,
  type WorkingCopyStorage,
} from '../adapter';
import { buildChangelog, isChangelogError, type ChangelogError } from '../changelog';
import {
  formatChangelogFence,
  formatRewriteMessage,
  joinFences,
  parseChangelogFences,
  parseRewriteFences,
  StreamTracker,
  type StreamPreview,
} from '../fence';
import { computeHunks, resolveReview, type HunkDecision, type ReviewState } from '../review';
import {
  isValidRange,
  locateQuote,
  mapWorkingRangeToBase,
  toRewriteRequest,
  type SelectionRange,
} from '../selection';
import { hashText, normalizeEol, utf8ByteLength } from '../text';
import {
  applyAssistantMessage,
  emptyVersionStore,
  getLatestVersion,
  getVersions,
  rebuild,
  type VersionStore,
} from '../versions';
import { systemClock, type Clock } from './clock';
import { MemoryWorkingCopyStorage } from './memory-storage';
import type {
  ConnectionState,
  DraftComment,
  DraftSendResult,
  DraftState,
  Notice,
  NoticeCode,
  NoticeLevel,
  PendingRewrite,
  RewriteMode,
  RewriteResult,
  SessionPhase,
  SessionSnapshot,
  StageResult,
  StaleReason,
  WorkingCopyStatus,
} from './types';

export interface DraftSessionControllerOptions {
  adapter: HostAdapter;
  /** Time source; defaults to `Date.now` and the runtime timers. */
  clock?: Clock;
  /** Working-copy storage; defaults to `adapter.storage`, then to memory. */
  storage?: WorkingCopyStorage;
  /** Debounce for working-copy saves, per draft. Default 500 ms. */
  saveDebounceMs?: number;
  /** Re-read the current chat this often while visible (a safety net for lost pushes). Off when absent. */
  refreshIntervalMs?: number;
}

export type RewriteCheck = { ok: true } | { ok: false; status: RewriteResult['status']; message: string };

type SnapshotListener = (snapshot: SessionSnapshot) => void;

type LoadMode = { kind: 'active' } | { kind: 'current' } | { kind: 'session'; ref: SessionRef };

type CurrentChangelog =
  | { kind: 'none' }
  | { kind: 'error'; error: ChangelogError }
  | { kind: 'ok'; fence: ChangelogFence; text: string; hash: string };

interface ChangelogCacheEntry {
  text: string;
  baseVersion: number;
  baseBody: string;
  result: CurrentChangelog;
}

const DEFAULT_SAVE_DEBOUNCE_MS = 500;
const DEFAULT_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 10_000;

const OVERLAP_MESSAGE =
  'This selection includes unsent edits. Add your changes to your message and send it, or discard them, then try again.';

const COMMENT_MOVED_MESSAGE = 'A comment points at text that has changed. Remove it and add it again.';

/** Notice codes from a failed read that a later successful read makes obsolete. */
const TRANSIENT_READ_ERRORS: ReadonlySet<string> = new Set(['host_error', 'not_connected', 'rate_limited']);

function isHostAdapterError(err: unknown): err is HostAdapterError {
  if (err instanceof HostAdapterError) return true;
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'HostAdapterError' &&
    typeof (err as { code?: unknown }).code === 'string'
  );
}

function errorMessage(err: unknown): string {
  if (isHostAdapterError(err)) {
    switch (err.code) {
      case 'not_connected':
        return 'Not connected to the chat. Try again.';
      case 'payload_too_large':
        return 'Too large to send.';
      case 'unsupported':
        return 'The chat host does not support this action.';
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

function errorCode(err: unknown): NoticeCode {
  return isHostAdapterError(err) ? err.code : 'host_error';
}

function isWorkingCopy(value: unknown): value is WorkingCopy {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['sessionId'] === 'string' &&
    typeof v['draftId'] === 'string' &&
    typeof v['baseVersion'] === 'number' &&
    typeof v['baseHash'] === 'string' &&
    typeof v['text'] === 'string' &&
    typeof v['updatedAt'] === 'string'
  );
}

/**
 * Orchestrates one adapter, the version store and working-copy storage for a
 * panel (ADAPTER_INTERFACE section 5, design sections 3 and 5). It is the only
 * core module that calls the adapter. State changes are published as
 * immutable `SessionSnapshot` values.
 *
 * Nothing is ever staged automatically: `stage()` runs only when the user asks.
 * `dispose()` releases the controller's own subscription and timers; the
 * adapter's lifetime belongs to the host.
 */
export class DraftSessionController {
  private readonly adapter: HostAdapter;
  private readonly clock: Clock;
  private readonly storage: WorkingCopyStorage;
  private readonly storageMode: 'host' | 'memory';
  private readonly saveDebounceMs: number;

  private readonly listeners = new Set<SnapshotListener>();
  private snapshot: SessionSnapshot | null = null;

  private unsubscribeHost: (() => void) | null = null;
  private startPromise: Promise<void> | null = null;
  private disposed = false;
  private active: boolean | undefined = undefined;
  private dirtySinceHidden = false;

  private phase: SessionPhase = 'idle';
  private connection: ConnectionState = 'disconnected';
  private fidelity: TranscriptFidelity;
  private session: SessionRef | null = null;
  private sessions: SessionRef[] = [];
  private completeness: HistoryCompleteness = 'full';

  private store: VersionStore = emptyVersionStore();
  private readonly tracker = new StreamTracker();
  private readonly previews = new Map<string, StreamPreview[]>();
  private workingCopies = new Map<string, WorkingCopy>();
  private reviews = new Map<string, ReviewState>();
  private pendingRewrites = new Map<string, PendingRewrite>();
  private seenUserMessages = new Set<string>();
  /** Drafts injected on a path where the user does not send (draftId -> changelog hash). */
  private contextOnlyPending = new Map<string, string>();
  private readonly changelogCache = new Map<string, ChangelogCacheEntry>();

  private notices: Notice[] = [];
  private noticeSeq = 0;
  private readonly dismissedUnclosed = new Set<string>();

  private buffer: HostEvent[] | null = null;
  private epoch = 0;
  private staging = false;
  private readonly saveTimers = new Map<string, () => void>();

  constructor(options: DraftSessionControllerOptions) {
    this.adapter = options.adapter;
    this.clock = options.clock ?? systemClock;
    this.saveDebounceMs = options.saveDebounceMs ?? DEFAULT_SAVE_DEBOUNCE_MS;
    const provided = options.storage ?? this.adapter.storage;
    this.storage = provided ?? new MemoryWorkingCopyStorage();
    this.storageMode = provided === undefined ? 'memory' : 'host';
    this.fidelity = this.adapter.capabilities.canRewritePersistedUserMessage ? 'persisted' : 'context-only';
    this.refreshIntervalMs = options.refreshIntervalMs;
  }

  private readonly refreshIntervalMs: number | undefined;
  private cancelRefresh: (() => void) | null = null;

  /**
   * Safety net for hosts whose push events can be lost or arrive before the message is stored: re-reads the
   * current chat every `refreshIntervalMs` while the panel is visible and nothing else is loading.
   */
  private scheduleRefresh(): void {
    if (this.cancelRefresh !== null || this.refreshIntervalMs === undefined || this.disposed) return;
    this.cancelRefresh = this.clock.setTimer(() => {
      this.cancelRefresh = null;
      if (this.disposed) return;
      if (this.active !== false && this.session !== null && this.buffer === null && !this.staging) {
        void this.loadSession({ kind: 'current' });
      }
      this.scheduleRefresh();
    }, this.refreshIntervalMs);
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Connects, subscribes (buffering events), attaches to the active session,
   * rebuilds from history and loads working copies. Idempotent; resolves when
   * the first load has finished. Never rejects: failures become notices.
   */
  start(): Promise<void> {
    if (this.startPromise === null) this.startPromise = this.doStart();
    return this.startPromise;
  }

  /** Tries `connect()` again after a failure (user action). */
  retryConnect(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.startPromise = null;
    return this.start();
  }

  /** Stops listening and saves pending working copies. Does not dispose the adapter. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch += 1;
    if (this.cancelRefresh !== null) {
      this.cancelRefresh();
      this.cancelRefresh = null;
    }
    if (this.unsubscribeHost !== null) {
      this.unsubscribeHost();
      this.unsubscribeHost = null;
    }
    this.buffer = null;
    await this.flushSaves();
    this.listeners.clear();
  }

  getSnapshot(): SessionSnapshot {
    if (this.snapshot === null) this.snapshot = this.buildSnapshot();
    return this.snapshot;
  }

  /** Subscribes to snapshots. The listener is not called with the current snapshot on subscribe. */
  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Tells the controller whether the panel is visible (`undefined` counts as
   * visible). While hidden it records that events arrived and does nothing
   * else; on becoming visible it performs one history fetch and rebuild if
   * anything arrived.
   */
  async setActive(active: boolean | undefined): Promise<void> {
    const wasHidden = this.active === false;
    this.active = active;
    if (active === false) {
      if (!wasHidden) this.publish(true);
      return;
    }
    if (!wasHidden) return;
    if (this.dirtySinceHidden && this.phase !== 'idle') {
      this.dirtySinceHidden = false;
      await this.loadSession({ kind: 'active' });
    } else {
      this.publish();
    }
  }

  /** Attaches to a session chosen from the picker. */
  selectSession(ref: SessionRef): Promise<void> {
    return this.loadSession({ kind: 'session', ref });
  }

  /** Re-fetches the history of the current session (or re-reads the active session) and rebuilds. */
  refresh(): Promise<void> {
    return this.loadSession(this.session === null ? { kind: 'active' } : { kind: 'current' });
  }

  /** Saves pending working copies now. */
  async flush(): Promise<void> {
    await this.flushSaves();
  }

  dismissNotice(id: string): void {
    const found = this.notices.find((n) => n.id === id);
    if (found === undefined) return;
    if (found.code === 'unclosed_draft') this.dismissedUnclosed.add(`${found.draftId ?? ''}|${found.message}`);
    this.notices = this.notices.filter((n) => n.id !== id);
    this.publish();
  }

  // ----------------------------------------------------------------- editing

  /**
   * Records the editor text of a draft's latest version as a working copy.
   * Text equal to the latest version removes the working copy. Returns false
   * (and changes nothing) if the draft has no version, a review is open, or
   * the working copy is stale.
   */
  edit(draftId: string, text: string): boolean {
    const session = this.session;
    const latest = getLatestVersion(this.store, draftId);
    if (session === null || latest === undefined || this.reviews.has(draftId)) return false;
    const existing = this.workingCopies.get(draftId);
    if (existing !== undefined && this.staleReason(draftId, existing) !== null) return false;

    const next = normalizeEol(text);
    if (next === latest.body) {
      if (existing !== undefined) {
        this.workingCopies.delete(draftId);
        this.scheduleSave(draftId);
      }
      this.publish();
      return true;
    }
    const base: WorkingCopy = existing ?? {
      sessionId: session.sessionId,
      draftId,
      baseVersion: latest.n,
      baseHash: hashText(latest.body),
      text: next,
      updatedAt: this.nowIso(),
    };
    this.workingCopies.set(draftId, { ...base, text: next, updatedAt: this.nowIso() });
    this.scheduleSave(draftId);
    this.publish();
    return true;
  }

  /** Removes the working copy (and any open review) of a draft. The UI asks for confirmation first. */
  discardChanges(draftId: string): void {
    const hadCopy = this.workingCopies.delete(draftId);
    const hadReview = this.reviews.delete(draftId);
    this.changelogCache.delete(draftId);
    if (hadCopy) this.scheduleSave(draftId);
    if (hadCopy || hadReview) this.publish();
  }

  // ----------------------------------------------------------------- staging

  /**
   * Builds a changelog for every draft with unstaged edits and hands them to
   * `adapter.injectNextTurn` in one call. Explicit only: the panel calls this
   * when the user clicks "Add changes to my message".
   */
  async stage(options: { draftIds?: readonly string[] } = {}): Promise<StageResult> {
    const session = this.session;
    const empty = (status: StageResult['status'], message: string): StageResult => ({
      status,
      stagedDraftIds: [],
      blockedDraftIds: [],
      message,
    });
    if (session === null) return empty('no_session', 'No active chat.');
    if (this.staging) return empty('busy', 'Already adding changes to your message.');

    const entries: { id: string; text: string; hash: string }[] = [];
    const blocked: string[] = [];
    for (const id of this.store.order) {
      if (options.draftIds !== undefined && !options.draftIds.includes(id)) continue;
      const state = this.evaluate(id);
      if (state.status !== 'dirty' && state.status !== 'staged-stale') continue;
      if (state.current.kind === 'error') {
        blocked.push(id);
        this.addNotice('warning', state.current.error.error === 'marker_conflict' ? 'marker_conflict' : 'host_error', state.current.error.message, id);
        continue;
      }
      if (state.current.kind === 'ok') entries.push({ id, text: state.current.text, hash: state.current.hash });
    }
    if (entries.length === 0) {
      this.publish();
      return blocked.length > 0
        ? { ...empty('blocked', 'No changelog could be built.'), blockedDraftIds: blocked }
        : empty('nothing_to_stage', 'There are no changes to add.');
    }

    const text = joinFences(entries.map((e) => e.text));
    const limit = this.adapter.capabilities.maxInjectBytes;
    if (limit !== undefined && utf8ByteLength(text) > limit) {
      const message = 'Too large to send. Add fewer drafts to your message at a time.';
      this.addNotice('warning', 'too_large', message);
      return { ...empty('too_large', message), blockedDraftIds: blocked };
    }

    this.staging = true;
    let result: InjectResult;
    try {
      result = await this.withRetry(() => this.adapter.injectNextTurn(session.sessionId, text));
    } catch (err) {
      const message = errorMessage(err);
      if (this.session?.sessionId === session.sessionId) this.addNotice('error', errorCode(err), message);
      return { ...empty('error', message), blockedDraftIds: blocked };
    } finally {
      this.staging = false;
    }

    const ids = entries.map((e) => e.id);
    if (this.session?.sessionId === session.sessionId) {
      this.fidelity = result.fidelity;
      for (const entry of entries) {
        const wc = this.workingCopies.get(entry.id);
        if (wc !== undefined) {
          this.workingCopies.set(entry.id, { ...wc, stagedHash: entry.hash });
          this.scheduleSave(entry.id);
        }
        if (!result.requiresUserSend) this.contextOnlyPending.set(entry.id, entry.hash);
      }
      this.publish();
    }
    return {
      status: 'staged',
      stagedDraftIds: ids,
      blockedDraftIds: blocked,
      fidelity: result.fidelity,
      requiresUserSend: result.requiresUserSend,
      message:
        result.detail ??
        (result.requiresUserSend
          ? 'Added to your message. Send it in the chat when ready.'
          : 'Your changes will go with your next message.'),
    };
  }

  // ----------------------------------------------------------------- rewrite

  /** Checks whether a selection (in editor coordinates) can be sent as a rewrite now. */
  checkRewrite(draftId: string, range: SelectionRange): RewriteCheck {
    const prepared = this.prepareRewrite(draftId, range);
    return prepared.ok ? { ok: true } : { ok: false, status: prepared.status, message: prepared.message };
  }

  /**
   * Sends a `draft-rewrite` message for a selection of the latest version
   * (`sendNow`), or, on a host without `sendNow`, puts it in the composer.
   * `range` is in the coordinates of the editor text (the working copy if one exists).
   */
  async sendRewrite(input: { draftId: string; range: SelectionRange; instruction: string }): Promise<RewriteResult> {
    const session = this.session;
    if (session === null) return { status: 'no_session', message: 'No active chat.' };
    const mode = this.rewriteMode();
    if (mode === 'unavailable') {
      return { status: 'unavailable', message: 'This chat host cannot send a rewrite request.' };
    }
    const prepared = this.prepareRewrite(input.draftId, input.range);
    if (!prepared.ok) return { status: prepared.status, message: prepared.message };

    const built = toRewriteRequest({
      id: input.draftId,
      rev: prepared.version.n,
      body: prepared.version.body,
      range: prepared.baseRange,
      instruction: input.instruction,
    });
    if (!built.ok) {
      return {
        status: built.error === 'empty_instruction' ? 'empty_instruction' : 'invalid_selection',
        message: built.message,
      };
    }
    const text = formatRewriteMessage(built.request);
    const caps = this.adapter.capabilities;
    const limit = mode === 'send' ? caps.maxSendBytes : caps.maxInjectBytes;
    if (limit !== undefined && utf8ByteLength(text) > limit) {
      const message = 'Too large to send. Select a shorter passage.';
      this.addNotice('warning', 'too_large', message, input.draftId);
      return { status: 'too_large', message };
    }

    // Declared outside the try so the catch can undo a pending entry for a send that failed.
    let ownPending: PendingRewrite | undefined;
    let previousPending: PendingRewrite | undefined;
    try {
      if (mode === 'send') {
        // Record the pending rewrite BEFORE the send. A host may echo the user message
        // in a microtask queued by `sendNow`; that echo must find this entry and upgrade
        // it to `confirmed: true` (detectRewrite), and nothing may overwrite it afterwards.
        previousPending = this.pendingRewrites.get(input.draftId);
        ownPending = { rev: built.request.rev, sentAt: this.nowIso(), confirmed: false };
        this.pendingRewrites.set(input.draftId, ownPending);
        await this.withRetry(() => this.adapter.sendNow(session.sessionId, text));
        if (this.session?.sessionId === session.sessionId) this.publish();
        return { status: 'sent', message: 'Rewrite request sent.' };
      }
      const injected = await this.withRetry(() => this.adapter.injectNextTurn(session.sessionId, text));
      if (this.session?.sessionId === session.sessionId) {
        this.fidelity = injected.fidelity;
        this.publish();
      }
      return {
        status: 'queued_in_composer',
        message: injected.detail ?? 'Added to your message. Send it in the chat to start the rewrite.',
      };
    } catch (err) {
      // The send did not happen: drop our unconfirmed entry (a confirmed one means the
      // host did echo the message, so it stays). Entries replaced by detectRewrite or a
      // reset are not ours and are left alone.
      if (ownPending !== undefined && this.pendingRewrites.get(input.draftId) === ownPending) {
        if (previousPending !== undefined) this.pendingRewrites.set(input.draftId, previousPending);
        else this.pendingRewrites.delete(input.draftId);
      }
      const message = errorMessage(err);
      if (this.session?.sessionId === session.sessionId) this.addNotice('error', errorCode(err), message, input.draftId);
      return { status: 'error', message };
    }
  }

  // ------------------------------------------------------------------ review

  /**
   * The one "send to the agent" action: every draft's unsent edits (as `draft-changelog` fences) and every
   * comment (as `draft-rewrite` fences) go out in ONE user message. A comment on a draft that has edits
   * refers to the edited text: its `rev` is the changelog's `to`, so the agent applies the edits first and
   * then the comments. Sent with `sendNow` when the host has it, otherwise put in the composer.
   */
  async sendAll(input: { comments: readonly DraftComment[] }): Promise<DraftSendResult> {
    const session = this.session;
    const fail = (status: DraftSendResult['status'], message: string, commentIndex?: number): DraftSendResult => ({
      status,
      message,
      draftIds: [],
      ...(commentIndex !== undefined ? { commentIndex } : {}),
    });
    if (session === null) return fail('no_session', 'No active chat.');
    if (this.staging) return fail('busy', 'Already adding changes to your message.');
    const caps = this.adapter.capabilities;
    const send = caps.canSendNow === true;
    if (!send && !caps.canAppendToComposer && !caps.canRewritePersistedUserMessage) {
      return fail('unavailable', 'The chat host does not support this action.');
    }

    // 0. Re-read the chat first. If live updates were missed (no event grant, a dropped socket), the edits
    //    may sit on a version that is no longer the latest; sending them would overwrite the agent's newer
    //    text. The draft then shows the stale banner ("Review against latest"), and nothing is sent.
    const involved = new Set<string>([...this.workingCopies.keys(), ...input.comments.map((c) => c.draftId)]);
    const latestBefore = new Map<string, number>();
    for (const id of involved) latestBefore.set(id, getLatestVersion(this.store, id)?.n ?? 0);
    this.staging = true;
    try {
      await this.loadSession({ kind: 'current' });
    } finally {
      this.staging = false;
    }
    // A version found by the re-read before sending opens the review (unsent edits) or moves the editor on.
    if (this.session?.sessionId !== session.sessionId) return fail('no_session', 'No active chat.');
    for (const [id, before] of latestBefore) {
      if ((getLatestVersion(this.store, id)?.n ?? 0) > before) {
        return fail('newer_version', 'A newer version arrived. Look at it first, then send again.');
      }
    }

    // 1. Edits. Every draft with a working copy whose changelog can be built, sent or not: repeating an
    //    already sent changelog is harmless (the last one per id wins) and keeps this message complete.
    const changelogs = new Map<string, { text: string; hash: string; to: number }>();
    const commented = new Set(input.comments.map((c) => c.draftId));
    for (const id of this.store.order) {
      const state = this.evaluate(id);
      if (state.wc === undefined) continue;
      if (state.stale !== null) {
        // A stale draft cannot be sent; it only blocks the send when a comment points into it.
        if (commented.has(id)) {
          return fail('stale_base', 'Your changes are based on an older version. Review or discard them first.');
        }
        continue;
      }
      if (state.current.kind === 'error') {
        this.addNotice('warning', state.current.error.error === 'marker_conflict' ? 'marker_conflict' : 'host_error', state.current.error.message, id);
        return fail('blocked', 'No changelog could be built.');
      }
      if (state.current.kind === 'ok') {
        changelogs.set(id, { text: state.current.text, hash: state.current.hash, to: state.current.fence.to });
      }
    }

    // 2. Comments, in the coordinates of the text the user sees.
    const rewrites: string[] = [];
    const pendingRevs = new Map<string, number>();
    for (const [index, comment] of input.comments.entries()) {
      const latest = getLatestVersion(this.store, comment.draftId);
      if (latest === undefined) return fail('comment_moved', COMMENT_MOVED_MESSAGE, index);
      const wc = this.workingCopies.get(comment.draftId);
      const text = wc?.text ?? latest.body;
      const range = locateQuote(text, comment.quote, comment.range);
      if (range === null) return fail('comment_moved', COMMENT_MOVED_MESSAGE, index);
      const changelog = changelogs.get(comment.draftId);
      const built = toRewriteRequest({
        id: comment.draftId,
        rev: changelog?.to ?? latest.n,
        body: text,
        range,
        instruction: comment.instruction,
      });
      if (!built.ok) {
        return built.error === 'empty_instruction'
          ? fail('empty_instruction', built.message, index)
          : fail('comment_moved', COMMENT_MOVED_MESSAGE, index);
      }
      rewrites.push(formatRewriteMessage(built.request));
      pendingRevs.set(comment.draftId, latest.n);
    }

    if (changelogs.size === 0 && rewrites.length === 0) {
      return fail('nothing_to_send', 'Nothing to send. Edit the draft or add a comment first.');
    }

    // Edits first, then the comments that may point into the edited text.
    const text = joinFences([...[...changelogs.values()].map((c) => c.text), ...rewrites]);
    const limit = send ? caps.maxSendBytes : caps.maxInjectBytes;
    if (limit !== undefined && utf8ByteLength(text) > limit) {
      const message = 'Too large to send.';
      this.addNotice('warning', 'too_large', message);
      return fail('too_large', message);
    }

    const draftIds = [...new Set([...changelogs.keys(), ...pendingRevs.keys()])];
    // Record pending rewrites before the send, as sendRewrite does: an echo may arrive during the call.
    const previous = new Map<string, PendingRewrite | undefined>();
    const own = new Map<string, PendingRewrite>();
    for (const [id, rev] of pendingRevs) {
      previous.set(id, this.pendingRewrites.get(id));
      const entry: PendingRewrite = { rev, sentAt: this.nowIso(), confirmed: false };
      own.set(id, entry);
      this.pendingRewrites.set(id, entry);
    }

    this.staging = true;
    let injected: InjectResult | undefined;
    try {
      if (send) await this.withRetry(() => this.adapter.sendNow(session.sessionId, text));
      else injected = await this.withRetry(() => this.adapter.injectNextTurn(session.sessionId, text));
    } catch (err) {
      for (const [id, entry] of own) {
        if (this.pendingRewrites.get(id) !== entry) continue;
        const before = previous.get(id);
        if (before !== undefined) this.pendingRewrites.set(id, before);
        else this.pendingRewrites.delete(id);
      }
      const message = errorMessage(err);
      if (this.session?.sessionId === session.sessionId) this.addNotice('error', errorCode(err), message);
      return { status: 'error', message, draftIds: [] };
    } finally {
      this.staging = false;
    }

    if (this.session?.sessionId === session.sessionId) {
      if (injected !== undefined) this.fidelity = injected.fidelity;
      for (const [id, changelog] of changelogs) {
        const wc = this.workingCopies.get(id);
        if (wc === undefined) continue;
        const delivered = send || injected?.requiresUserSend === false;
        this.workingCopies.set(id, {
          ...wc,
          stagedHash: changelog.hash,
          ...(delivered ? { sentHash: changelog.hash } : {}),
        });
        this.scheduleSave(id);
      }
      this.publish();
    }
    return send
      ? { status: 'sent', message: 'Sent to the chat.', draftIds }
      : {
          status: 'queued_in_composer',
          message: injected?.detail ?? 'Added to your message. Send it in the chat when ready.',
          draftIds,
        };
  }

  // ------------------------------------------------------------------ review

  /**
   * Opens a review on demand. A stale working copy is reviewed against the
   * latest version; otherwise the latest version is reviewed against the
   * previous one. Returns false if there is nothing to review.
   */
  openReview(draftId: string): boolean {
    const latest = getLatestVersion(this.store, draftId);
    if (latest === undefined) return false;
    const wc = this.workingCopies.get(draftId);
    let left: string;
    let label: string;
    if (wc !== undefined && this.staleReason(draftId, wc) !== null) {
      left = wc.text;
      label = 'Your changes';
    } else {
      const previous = getVersions(this.store, draftId)[latest.n - 2];
      if (previous === undefined) return false;
      left = previous.body;
      label = `Version ${previous.n}`;
    }
    if (normalizeEol(left) === latest.body) return false;
    this.setReview(draftId, left, label, latest);
    this.publish();
    return true;
  }

  setReviewDecision(draftId: string, hunkIndex: number, decision: HunkDecision | null): void {
    const review = this.reviews.get(draftId);
    if (review === undefined || hunkIndex < 0 || hunkIndex >= review.decisions.length) return;
    const decisions = review.decisions.slice();
    decisions[hunkIndex] = decision;
    this.reviews.set(draftId, { ...review, decisions });
    this.publish();
  }

  setAllReviewDecisions(draftId: string, decision: HunkDecision | null): void {
    const review = this.reviews.get(draftId);
    if (review === undefined) return;
    this.reviews.set(draftId, { ...review, decisions: review.hunks.map(() => decision) });
    this.publish();
  }

  /**
   * Ends the review. The result (accepted hunks from the new version, rejected
   * hunks from the previous text; undecided hunks keep the previous text)
   * becomes a working copy against the latest version, or removes the working
   * copy if it equals the latest version. Committed versions are not touched.
   */
  finishReview(draftId: string): boolean {
    const review = this.reviews.get(draftId);
    const latest = getLatestVersion(this.store, draftId);
    const session = this.session;
    if (review === undefined || latest === undefined || session === null) return false;
    const text = resolveReview(review.leftText, review.rightText, review.decisions);
    this.reviews.delete(draftId);
    this.changelogCache.delete(draftId);
    if (text === latest.body) {
      this.workingCopies.delete(draftId);
    } else {
      this.workingCopies.set(draftId, {
        sessionId: session.sessionId,
        draftId,
        baseVersion: latest.n,
        baseHash: hashText(latest.body),
        text,
        updatedAt: this.nowIso(),
      });
    }
    this.scheduleSave(draftId);
    this.publish();
    return true;
  }

  /** Closes the review without changing the working copy. */
  cancelReview(draftId: string): void {
    if (this.reviews.delete(draftId)) this.publish();
  }

  // ------------------------------------------------------- start / load flow

  private async doStart(): Promise<void> {
    if (this.adapter.info.interfaceVersion !== INTERFACE_VERSION) {
      this.phase = 'error';
      this.addNotice(
        'error',
        'unsupported_interface',
        `This adapter implements interface version ${String(this.adapter.info.interfaceVersion)}, but Draft Canvas supports version ${INTERFACE_VERSION}.`,
      );
      return;
    }
    this.phase = 'connecting';
    this.publish();
    try {
      await this.adapter.connect();
    } catch (err) {
      if (this.disposed) return;
      this.phase = 'error';
      this.connection = 'disconnected';
      this.addNotice('error', errorCode(err), errorMessage(err));
      return;
    }
    if (this.disposed) return;
    this.connection = 'connected';
    if (this.unsubscribeHost === null) {
      this.buffer = [];
      this.unsubscribeHost = this.adapter.subscribe((event) => this.onHostEvent(event));
    }
    await this.loadSession({ kind: 'active' });
    this.scheduleRefresh();
  }

  /** Steps 4 and 5 of the lifecycle: determine the session, fetch history, rebuild, load working copies. */
  private async loadSession(mode: LoadMode): Promise<void> {
    if (this.disposed) return;
    const epoch = ++this.epoch;
    if (this.buffer === null) this.buffer = [];
    if (this.phase !== 'ready') this.phase = 'loading';
    this.publish();

    let followUp: 'none' | 'active' = 'none';
    try {
      await this.flushSaves();
      let ref: SessionRef | null;
      if (mode.kind === 'active') ref = await this.adapter.getActiveSession();
      else if (mode.kind === 'session') ref = mode.ref;
      else ref = this.session;
      if (epoch !== this.epoch) return;

      const sameSession = ref !== null && this.session !== null && ref.sessionId === this.session.sessionId;
      if (!sameSession) this.resetSessionState();
      this.session = ref;
      await this.loadSessionList(epoch);
      if (epoch !== this.epoch) return;
      if (ref === null) {
        this.phase = 'ready';
        return;
      }

      let history: { messages: Message[]; completeness: HistoryCompleteness };
      try {
        history = await this.adapter.getHistory(ref.sessionId);
      } catch (err) {
        if (epoch !== this.epoch) return;
        if (isHostAdapterError(err) && err.code === 'session_not_found' && mode.kind !== 'active') followUp = 'active';
        throw err;
      }
      if (epoch !== this.epoch) return;

      const stored = sameSession ? null : await this.loadStoredWorkingCopies(ref.sessionId, history.messages);
      if (epoch !== this.epoch) return;
      this.applyHistory(history.messages, history.completeness, stored);
      // A read worked again: drop errors from earlier failed reads ("Failed to fetch" after sleep etc.).
      const before = this.notices.length;
      this.notices = this.notices.filter((n) => !TRANSIENT_READ_ERRORS.has(n.code));
      if (this.notices.length !== before) this.publish();
      this.phase = 'ready';
    } catch (err) {
      if (epoch !== this.epoch) return;
      this.phase = 'ready';
      this.addNotice('error', errorCode(err), errorMessage(err));
    } finally {
      if (epoch === this.epoch) this.finishLoad(followUp);
    }
  }

  private async loadSessionList(epoch: number): Promise<void> {
    if (this.adapter.listSessions === undefined) return;
    try {
      const list = await this.adapter.listSessions();
      if (epoch === this.epoch) this.sessions = list;
    } catch {
      // The picker is optional; a failure here is not worth a notice.
    }
  }

  private async loadStoredWorkingCopies(
    sessionId: string,
    messages: readonly Message[],
  ): Promise<Map<string, WorkingCopy>> {
    const out = new Map<string, WorkingCopy>();
    try {
      let list: WorkingCopy[];
      if (this.storage.list !== undefined) {
        list = await this.storage.list(sessionId);
      } else {
        // Without `list`, ask for every draft id that appears in the history.
        const ids = rebuild(messages).store.order;
        list = [];
        for (const id of ids) {
          const copy = await this.storage.load(sessionId, id);
          if (copy !== null) list.push(copy);
        }
      }
      for (const copy of list) {
        if (isWorkingCopy(copy) && copy.sessionId === sessionId) out.set(copy.draftId, copy);
      }
    } catch (err) {
      this.addNotice('warning', 'storage_error', `Could not read saved changes: ${errorMessage(err)}`);
    }
    return out;
  }

  /** Replaces versions with a rebuild of `messages`, restores sent state, and re-checks working copies. */
  private applyHistory(
    messages: readonly Message[],
    completeness: HistoryCompleteness,
    stored: Map<string, WorkingCopy> | null,
  ): void {
    // On a re-read of the same chat, versions that were missed (a lost push, a push that came before the
    // message was stored, the periodic refresh) are handled like a pushed version once the rebuild is done.
    const latestBefore = new Map<string, number>();
    if (stored === null) {
      for (const id of this.store.order) latestBefore.set(id, getLatestVersion(this.store, id)?.n ?? 0);
    }
    const rebuilt = rebuild(messages);
    this.store = rebuilt.store;
    this.completeness = completeness;
    this.tracker.clear();
    this.previews.clear();
    this.changelogCache.clear();

    if (stored !== null) this.workingCopies = stored;
    // A working copy needs its draft; copies for unknown drafts stay in storage only.
    for (const id of [...this.workingCopies.keys()]) {
      if (!this.store.versions.has(id)) this.workingCopies.delete(id);
    }
    for (const [id, review] of [...this.reviews]) {
      const latest = getLatestVersion(this.store, id);
      if (latest === undefined || latest.n < review.rightVersion) this.reviews.delete(id);
    }

    // Sent detection from the persisted history (REQ-4.6); this never creates versions.
    const previouslySeen = this.seenUserMessages;
    const seen = new Set<string>();
    let sawNewUserMessage = false;
    for (const message of messages) {
      if (message.role !== 'user') continue;
      seen.add(message.id);
      if (!previouslySeen.has(message.id)) sawNewUserMessage = true;
      this.detectSent(message.text);
    }
    this.seenUserMessages = seen;
    if (sawNewUserMessage && previouslySeen.size > 0) this.resolveContextOnlyPending();

    for (const unclosed of rebuilt.unclosed) this.addUnclosedNotice(unclosed.draftId);

    // A rewrite that was answered while we were not looking: open the review now.
    for (const [id, before] of latestBefore) {
      const latest = getLatestVersion(this.store, id);
      if (latest !== undefined && before > 0 && latest.n > before) this.onNewVersion(latest);
    }
    for (const [id, pending] of [...this.pendingRewrites]) {
      const latest = getLatestVersion(this.store, id);
      if (latest !== undefined && latest.n > pending.rev) this.onNewVersion(latest);
    }
  }

  /** Called when a load finishes: delivers events that arrived during the load. */
  private finishLoad(followUp: 'none' | 'active'): void {
    const events = this.buffer ?? [];
    this.buffer = null;
    let next: LoadMode | null = followUp === 'active' ? { kind: 'active' } : null;
    if (next === null) {
      for (const event of events) {
        if (event.type === 'session_changed') {
          next = { kind: 'active' };
          break;
        }
        if (this.eventNeedsReload(event)) {
          next = this.session === null ? { kind: 'active' } : { kind: 'current' };
          break;
        }
        this.handleEvent(event);
      }
    }
    this.publish();
    if (next !== null) void this.loadSession(next);
  }

  private eventNeedsReload(event: HostEvent): boolean {
    if (event.type === 'history_reset') return this.session?.sessionId === event.sessionId;
    return event.type === 'connection' && event.state === 'connected' && this.connection !== 'connected';
  }

  private resetSessionState(): void {
    this.store = emptyVersionStore();
    this.tracker.clear();
    this.previews.clear();
    this.workingCopies = new Map();
    this.reviews = new Map();
    this.pendingRewrites = new Map();
    this.seenUserMessages = new Set();
    this.contextOnlyPending = new Map();
    this.changelogCache.clear();
    this.completeness = 'full';
    this.sessions = [];
    this.notices = [];
    this.dismissedUnclosed.clear();
  }

  // ------------------------------------------------------------------ events

  private onHostEvent(event: HostEvent): void {
    if (this.disposed) return;
    if (this.buffer !== null) {
      this.buffer.push(event);
      return;
    }
    try {
      this.handleEvent(event);
    } catch (err) {
      this.addNotice('error', 'host_error', errorMessage(err));
    }
  }

  private handleEvent(event: HostEvent): void {
    if (event.type === 'connection') {
      const previous = this.connection;
      this.connection = event.state;
      if (event.state === 'connected' && previous !== 'connected') {
        if (this.active === false) this.dirtySinceHidden = true;
        else void this.loadSession(this.session === null ? { kind: 'active' } : { kind: 'current' });
      }
      this.publish();
      return;
    }
    if (this.active === false) {
      this.dirtySinceHidden = true;
      return;
    }
    switch (event.type) {
      case 'session_changed':
        void this.loadSession({ kind: 'active' });
        return;
      case 'history_reset':
        if (this.session?.sessionId === event.sessionId) void this.loadSession({ kind: 'current' });
        return;
      case 'assistant_chunk': {
        if (this.session?.sessionId !== event.sessionId) return;
        const before = this.tracker.previews(event.messageId);
        const after = this.tracker.push(event.messageId, event.delta);
        if (after !== before) {
          this.previews.set(event.messageId, after);
          this.publish();
        }
        return;
      }
      case 'assistant_done':
        if (this.session?.sessionId !== event.sessionId) return;
        this.tracker.end(event.message.id);
        this.previews.delete(event.message.id);
        this.onAssistantMessage(event.message);
        return;
      case 'user_message':
        if (this.session?.sessionId !== event.sessionId) return;
        this.onUserMessage(event.message);
        return;
      default:
        // Unknown event types are ignored (ADAPTER_INTERFACE section 3).
        return;
    }
  }

  private onAssistantMessage(message: Message): void {
    const outcome = applyAssistantMessage(this.store, message);
    if (outcome.status === 'text_changed') {
      void this.loadSession({ kind: 'current' });
      return;
    }
    if (outcome.status === 'applied') {
      this.store = outcome.store;
      for (const unclosed of outcome.unclosed) this.addUnclosedNotice(unclosed.draftId);
      const answered = new Set<string>();
      for (const version of outcome.committed) {
        answered.add(version.draftId);
        this.onNewVersion(version);
      }
      for (const [id, pending] of [...this.pendingRewrites]) {
        if (pending.confirmed && !answered.has(id)) {
          this.pendingRewrites.delete(id);
          this.addNotice('info', 'rewrite_unanswered', `The reply did not contain a new version of "${id}".`, id);
        }
      }
    }
    this.publish();
  }

  /**
   * A new committed version arrived. The editor moves to it and a notice says so, except when the user has
   * edits the agent has not seen (made after the last send, or never sent): those exist in no version, so a
   * review between them and the new version opens instead. Older versions stay in the pager. (0.1.9: before,
   * every reply to a sent change or rewrite opened a review.)
   */
  private onNewVersion(version: DraftVersion): void {
    const id = version.draftId;
    this.pendingRewrites.delete(id);
    const wc = this.workingCopies.get(id);
    const existing = this.reviews.get(id);

    if (existing !== undefined && normalizeEol(existing.leftText) !== version.body) {
      // A review is already open: move it to the newest version.
      this.setReview(id, existing.leftText, existing.leftLabel, version);
      return;
    }
    this.reviews.delete(id);
    if (wc !== undefined && this.hasUnseenEdits(id, wc) && normalizeEol(wc.text) !== version.body) {
      this.setReview(id, wc.text, 'Your changes', version);
      return;
    }
    if (wc !== undefined) {
      this.workingCopies.delete(id);
      this.changelogCache.delete(id);
      this.scheduleSave(id);
    }
    this.notices = this.notices.filter((n) => !(n.code === 'version_updated' && n.draftId === id));
    this.addNotice('info', 'version_updated', `Updated to version ${version.n}.`, id);
  }

  /** true if the working copy holds edits the agent has not received: never sent, or changed since. */
  private hasUnseenEdits(draftId: string, wc: WorkingCopy): boolean {
    const current = this.currentChangelog(draftId, wc);
    if (current.kind === 'none') return false;
    if (current.kind === 'error') return true;
    return wc.sentHash !== current.hash;
  }

  private setReview(draftId: string, left: string, label: string, right: DraftVersion): void {
    const leftText = normalizeEol(left);
    const hunks = computeHunks(leftText, right.body);
    this.reviews.set(draftId, {
      leftText,
      leftLabel: label,
      rightVersion: right.n,
      rightText: right.body,
      hunks,
      decisions: hunks.map(() => null),
    });
  }

  private onUserMessage(message: Message): void {
    if (message.role !== 'user' || this.seenUserMessages.has(message.id)) return;
    this.seenUserMessages.add(message.id);
    this.detectSent(message.text);
    this.detectRewrite(message.text);
    this.resolveContextOnlyPending();
    this.publish();
  }

  /** ADAPTER_INTERFACE section 8.2: the last changelog per id with a matching base counts as sent. */
  private detectSent(text: string): void {
    const lastById = new Map<string, ChangelogFence>();
    for (const fence of parseChangelogFences(text)) lastById.set(fence.id, fence);
    for (const [id, fence] of lastById) {
      const wc = this.workingCopies.get(id);
      if (wc === undefined || fence.from !== wc.baseVersion) continue;
      const hash = hashText(formatChangelogFence(fence));
      if (wc.sentHash !== hash) {
        this.workingCopies.set(id, { ...wc, sentHash: hash });
        this.scheduleSave(id);
      }
    }
  }

  private detectRewrite(text: string): void {
    for (const request of parseRewriteFences(text)) {
      const latest = getLatestVersion(this.store, request.id);
      if (latest === undefined) continue;
      const pending = this.pendingRewrites.get(request.id);
      // A rewrite sent with a changelog names the changelog's `to` (latest + 1). The answer is a new version
      // after `latest`, so the pending entry must count from `latest`.
      const rev = Math.min(request.rev, latest.n);
      this.pendingRewrites.set(
        request.id,
        pending === undefined
          ? { rev, sentAt: this.nowIso(), confirmed: true }
          : { ...pending, confirmed: true },
      );
    }
  }

  /** Context-only path: the next user message after the injection carries the changes. */
  private resolveContextOnlyPending(): void {
    if (this.contextOnlyPending.size === 0) return;
    for (const [id, hash] of this.contextOnlyPending) {
      const wc = this.workingCopies.get(id);
      if (wc !== undefined && wc.stagedHash === hash && wc.sentHash !== hash) {
        this.workingCopies.set(id, { ...wc, sentHash: hash });
        this.scheduleSave(id);
      }
    }
    this.contextOnlyPending = new Map();
  }

  // ----------------------------------------------------- derived draft state

  private staleReason(draftId: string, wc: WorkingCopy): StaleReason | null {
    const versions = getVersions(this.store, draftId);
    const base = versions[wc.baseVersion - 1];
    if (base === undefined) return 'base_missing';
    if (hashText(base.body) !== wc.baseHash) return 'base_changed';
    if (wc.baseVersion !== versions.length) return 'newer_version';
    return null;
  }

  private currentChangelog(draftId: string, wc: WorkingCopy): CurrentChangelog {
    const base = getVersions(this.store, draftId)[wc.baseVersion - 1];
    if (base === undefined) return { kind: 'none' };
    const cached = this.changelogCache.get(draftId);
    if (
      cached !== undefined &&
      cached.text === wc.text &&
      cached.baseVersion === wc.baseVersion &&
      cached.baseBody === base.body
    ) {
      return cached.result;
    }
    const built = buildChangelog(draftId, base.body, base.n, wc.text);
    let result: CurrentChangelog;
    if (isChangelogError(built)) {
      result = built.error === 'no_changes' ? { kind: 'none' } : { kind: 'error', error: built };
    } else {
      const text = formatChangelogFence(built);
      result = { kind: 'ok', fence: built, text, hash: hashText(text) };
    }
    this.changelogCache.set(draftId, { text: wc.text, baseVersion: wc.baseVersion, baseBody: base.body, result });
    return result;
  }

  private evaluate(draftId: string): {
    wc: WorkingCopy | undefined;
    stale: StaleReason | null;
    current: CurrentChangelog;
    status: WorkingCopyStatus;
  } {
    const wc = this.workingCopies.get(draftId);
    if (wc === undefined) return { wc, stale: null, current: { kind: 'none' }, status: 'clean' };
    const stale = this.staleReason(draftId, wc);
    if (stale !== null) return { wc, stale, current: { kind: 'none' }, status: 'stale-base' };
    const current = this.currentChangelog(draftId, wc);
    let status: WorkingCopyStatus;
    if (current.kind === 'none') status = 'clean';
    else if (current.kind === 'error') status = 'dirty';
    else if (wc.sentHash === current.hash) status = 'sent';
    else if (wc.stagedHash === current.hash) status = 'staged';
    else if (wc.stagedHash !== undefined && wc.stagedHash !== wc.sentHash) status = 'staged-stale';
    else status = 'dirty';
    return { wc, stale, current, status };
  }

  private rewriteMode(): RewriteMode {
    const caps = this.adapter.capabilities;
    if (caps.canSendNow) return 'send';
    if (caps.canAppendToComposer || caps.canRewritePersistedUserMessage) return 'compose';
    return 'unavailable';
  }

  private prepareRewrite(
    draftId: string,
    range: SelectionRange,
  ):
    | { ok: true; version: DraftVersion; baseRange: SelectionRange }
    | { ok: false; status: RewriteResult['status']; message: string } {
    const invalid = { ok: false as const, status: 'invalid_selection' as const, message: 'The selection is empty or outside the text.' };
    const latest = getLatestVersion(this.store, draftId);
    if (latest === undefined) return invalid;
    const wc = this.workingCopies.get(draftId);
    if (wc === undefined) {
      return isValidRange(latest.body, range) ? { ok: true, version: latest, baseRange: range } : invalid;
    }
    if (this.staleReason(draftId, wc) !== null) {
      return {
        ok: false,
        status: 'stale_base',
        message: 'Your changes are based on an older version. Review or discard them first.',
      };
    }
    if (!isValidRange(wc.text, range)) return invalid;
    const mapped = mapWorkingRangeToBase(latest.body, wc.text, range);
    if (mapped === null) return { ok: false, status: 'overlaps_edits', message: OVERLAP_MESSAGE };
    return { ok: true, version: latest, baseRange: mapped };
  }

  // ------------------------------------------------------------- persistence

  private scheduleSave(draftId: string): void {
    if (this.session === null || this.saveTimers.has(draftId)) return;
    const sessionId = this.session.sessionId;
    const cancel = this.clock.setTimer(() => {
      this.saveTimers.delete(draftId);
      void this.persist(sessionId, draftId);
    }, this.saveDebounceMs);
    this.saveTimers.set(draftId, cancel);
  }

  private async persist(sessionId: string, draftId: string): Promise<void> {
    if (this.session?.sessionId !== sessionId) return;
    const wc = this.workingCopies.get(draftId);
    try {
      if (wc === undefined) await this.storage.remove(sessionId, draftId);
      else await this.storage.save(wc);
    } catch (err) {
      this.addNotice('warning', 'storage_error', `Could not save your changes (kept in memory): ${errorMessage(err)}`, draftId);
    }
  }

  private async flushSaves(): Promise<void> {
    const ids = [...this.saveTimers.keys()];
    for (const id of ids) {
      const cancel = this.saveTimers.get(id);
      if (cancel !== undefined) cancel();
      this.saveTimers.delete(id);
    }
    if (this.session === null) return;
    const sessionId = this.session.sessionId;
    for (const id of ids) await this.persist(sessionId, id);
  }

  // ----------------------------------------------------------------- helpers

  private nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.clock.setTimer(resolve, ms);
    });
  }

  /** Retries once after a `rate_limited` rejection (ADAPTER_INTERFACE section 15); nothing else is retried. */
  private async withRetry<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      if (isHostAdapterError(err) && err.code === 'rate_limited') {
        const wait = Math.min(err.options.retryAfterMs ?? DEFAULT_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS);
        await this.sleep(wait);
        return await call();
      }
      throw err;
    }
  }

  private addUnclosedNotice(draftId: string): void {
    const message = `Draft "${draftId}" was not finished and was not saved.`;
    if (this.dismissedUnclosed.has(`${draftId}|${message}`)) return;
    this.addNotice('warning', 'unclosed_draft', message, draftId);
  }

  private addNotice(level: NoticeLevel, code: NoticeCode, message: string, draftId?: string): void {
    const duplicate = this.notices.some((n) => n.code === code && n.message === message && n.draftId === draftId);
    if (!duplicate) {
      this.noticeSeq += 1;
      const notice: Notice = { id: `n${this.noticeSeq}`, level, code, message };
      if (draftId !== undefined) notice.draftId = draftId;
      this.notices = [...this.notices, notice];
    }
    this.publish();
  }

  // ---------------------------------------------------------------- snapshot

  /** Invalidates the cached snapshot and notifies listeners (not while hidden, unless `force`). */
  private publish(force = false): void {
    this.snapshot = null;
    if (this.active === false && !force) return;
    if (this.listeners.size === 0) return;
    const snapshot = this.getSnapshot();
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch {
        // A failing listener must not break the others.
      }
    }
  }

  private buildSnapshot(): SessionSnapshot {
    const ids = [...this.store.order];
    const previewByDraft = new Map<string, StreamPreview>();
    if (this.active !== false) {
      for (const messageId of this.tracker.messageIds()) {
        for (const preview of this.previews.get(messageId) ?? []) {
          previewByDraft.set(preview.draftId, preview);
          if (!ids.includes(preview.draftId)) ids.push(preview.draftId);
        }
      }
    }

    const drafts: DraftState[] = ids.map((id) => {
      const versions = [...getVersions(this.store, id)];
      const state = this.evaluate(id);
      const preview = previewByDraft.get(id);
      const latestWithTitle = [...versions].reverse().find((v) => v.title !== undefined);
      const lastVersion = versions[versions.length - 1];
      const review = this.reviews.get(id);
      const pending = this.pendingRewrites.get(id);
      const draft: DraftState = {
        draftId: id,
        lang: lastVersion?.lang ?? preview?.lang ?? 'markdown',
        versions,
        status: state.status,
        editable: lastVersion !== undefined && review === undefined && state.stale === null,
      };
      const title = latestWithTitle?.title ?? preview?.title;
      if (title !== undefined) draft.title = title;
      if (state.wc !== undefined) draft.workingCopy = state.wc;
      if (state.current.kind === 'error') draft.changelogError = state.current.error;
      if (state.stale !== null) draft.staleReason = state.stale;
      if (preview !== undefined) draft.preview = preview;
      if (review !== undefined) draft.review = review;
      if (pending !== undefined) draft.pendingRewrite = pending;
      return draft;
    });

    return {
      host: { info: this.adapter.info, capabilities: this.adapter.capabilities },
      phase: this.phase,
      session: this.session,
      sessions: this.sessions,
      completeness: this.completeness,
      fidelity: this.fidelity,
      connection: this.connection,
      active: this.active !== false,
      storageMode: this.storageMode,
      rewrite: this.rewriteMode(),
      drafts,
      notices: this.notices,
    };
  }
}
