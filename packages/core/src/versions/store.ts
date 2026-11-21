import type { DraftFence, DraftVersion, Message } from '../adapter';
import { parseDraftFences } from '../fence/parse';
import { hashText, normalizeEol } from '../text';

/** An unclosed `draft` fence found in a complete assistant message. Nothing was committed for it. */
export interface UnclosedDraftNotice {
  draftId: string;
  messageId: string;
}

/**
 * Committed versions of one session, built only from complete assistant
 * messages (ADAPTER_INTERFACE section 13). Treat it as immutable: every
 * function returns a new store and leaves its input unchanged.
 */
export interface VersionStore {
  /** Draft ids in order of first appearance. */
  readonly order: readonly string[];
  /** Versions per draft id, `n = index + 1`. */
  readonly versions: ReadonlyMap<string, readonly DraftVersion[]>;
  /** Assistant message id -> hash of the text that was processed (idempotence, REQ-4.3). */
  readonly processed: ReadonlyMap<string, string>;
}

export type ApplyStatus =
  | 'applied' // the message was processed (it may have committed zero versions)
  | 'duplicate' // same message id and same text were processed before: nothing changed
  | 'text_changed' // same message id, different text: the caller must rebuild from history
  | 'ignored'; // not an assistant message, or not complete

export interface ApplyOutcome {
  store: VersionStore;
  status: ApplyStatus;
  /** Versions committed by this message, ordered by fence index. */
  committed: DraftVersion[];
  /** Unclosed draft fences of this message. */
  unclosed: UnclosedDraftNotice[];
}

export interface RebuildResult {
  store: VersionStore;
  /** Unclosed draft fences across the whole history, in message order. */
  unclosed: UnclosedDraftNotice[];
}

export function emptyVersionStore(): VersionStore {
  return { order: [], versions: new Map(), processed: new Map() };
}

/** Versions of a draft, oldest first; empty if the id is unknown. */
export function getVersions(store: VersionStore, draftId: string): readonly DraftVersion[] {
  return store.versions.get(draftId) ?? [];
}

/** The latest committed version of a draft, if any. */
export function getLatestVersion(store: VersionStore, draftId: string): DraftVersion | undefined {
  const list = store.versions.get(draftId);
  return list === undefined || list.length === 0 ? undefined : list[list.length - 1];
}

/** Closed fences of a message, keeping only the last one per id (last-fence rule), ordered by fenceIndex. */
function committableFences(fences: readonly DraftFence[]): DraftFence[] {
  const lastById = new Map<string, DraftFence>();
  for (const fence of fences) {
    if (fence.closed) lastById.set(fence.id, fence);
  }
  return [...lastById.values()].sort((a, b) => a.fenceIndex - b.fenceIndex);
}

/**
 * Processes one message. Only complete assistant messages count; `draft`
 * fences in user, system and tool messages are ignored. The `rev` attribute is
 * kept as `revHint` and is never used for numbering.
 */
export function applyAssistantMessage(store: VersionStore, message: Message): ApplyOutcome {
  const none: ApplyOutcome = { store, status: 'ignored', committed: [], unclosed: [] };
  if (message.role !== 'assistant' || !message.complete) return none;

  const text = normalizeEol(message.text);
  const textHash = hashText(text);
  const seen = store.processed.get(message.id);
  if (seen !== undefined) {
    return { store, status: seen === textHash ? 'duplicate' : 'text_changed', committed: [], unclosed: [] };
  }

  const fences = parseDraftFences(text);
  const unclosed = fences.filter((f) => !f.closed).map((f) => ({ draftId: f.id, messageId: message.id }));
  const kept = committableFences(fences);

  const order = store.order.slice();
  const versions = new Map(store.versions);
  const committed: DraftVersion[] = [];
  for (const fence of kept) {
    const existing = versions.get(fence.id);
    if (existing === undefined) order.push(fence.id);
    const list = existing === undefined ? [] : existing.slice();
    const version: DraftVersion = {
      draftId: fence.id,
      n: list.length + 1,
      sourceMessageId: message.id,
      fenceIndex: fence.fenceIndex,
      lang: fence.lang,
      body: fence.body,
      createdAt: message.createdAt,
    };
    if (fence.rev !== undefined) version.revHint = fence.rev;
    if (fence.title !== undefined) version.title = fence.title;
    list.push(version);
    versions.set(fence.id, list);
    committed.push(version);
  }

  const processed = new Map(store.processed);
  processed.set(message.id, textHash);
  return { store: { order, versions, processed }, status: 'applied', committed, unclosed };
}

/**
 * Rebuilds all versions from a history (oldest first). Idempotent: the same
 * history gives the same store, and it equals the store built by applying the
 * same messages one at a time.
 */
export function rebuild(messages: readonly Message[]): RebuildResult {
  let store = emptyVersionStore();
  const unclosed: UnclosedDraftNotice[] = [];
  for (const message of messages) {
    const outcome = applyAssistantMessage(store, message);
    store = outcome.store;
    unclosed.push(...outcome.unclosed);
  }
  return { store, unclosed };
}
