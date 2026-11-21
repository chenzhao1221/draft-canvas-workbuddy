import type { WorkingCopy } from './data';

/** Interface version implemented by this copy of core (ADAPTER_INTERFACE.md section 3). */
export const INTERFACE_VERSION = '1' as const;

/** Where injected next-turn text ends up. */
export type TranscriptFidelity =
  | 'persisted' // text becomes part of the stored user message; visible after reload
  | 'context-only'; // text reaches the model for that turn only; absent from stored history

/** Whether getHistory returned everything the session ever contained. */
export type HistoryCompleteness =
  | 'full' // all persisted messages of the session, from the first one
  | 'window'; // a compacted or truncated window; older messages may be missing

export interface HostCapabilities {
  /** getHistory can return the full persisted history (completeness 'full'). */
  canReadFullHistory: boolean;
  /** assistant_chunk events are emitted while the assistant is streaming. */
  canStreamTokens: boolean;
  /** sendNow can post a user message immediately. */
  canSendNow: boolean;
  /** injectNextTurn lands in the stored user message (fidelity 'persisted'). */
  canRewritePersistedUserMessage: boolean;
  /** injectNextTurn appends to the user's unsent composer text, which the user then sends. */
  canAppendToComposer: boolean;
  /** The adapter can open/focus the Draft Canvas panel programmatically. */
  canAutoOpenPanel: boolean;
  /** adapter.storage is provided. */
  hasHostStorage: boolean;
  /** Upper bound in UTF-8 bytes for injectNextTurn text, if the host imposes one. */
  maxInjectBytes?: number;
  /** Upper bound in UTF-8 bytes for sendNow text, if the host imposes one. */
  maxSendBytes?: number;
}

export interface HostInfo {
  /** Stable lowercase slug, e.g. 'kiro-crew', 'opencode'. */
  id: string;
  /** Human-readable host name, e.g. 'Kiro Crew'. */
  displayName: string;
  /** Detected host version if known, e.g. '0.12.2'. */
  hostVersion?: string;
  /** SemVer of the adapter package. */
  adapterVersion: string;
  /** Always '1' for this document. */
  interfaceVersion: '1';
}

export interface SessionRef {
  /** Host session identifier, opaque to core. Stable across reloads. */
  sessionId: string;
  title?: string;
}

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface Message {
  /** Stable across reloads. If the host has no ids, derive a deterministic one (section 9.3). */
  id: string;
  sessionId: string;
  role: MessageRole;
  /** Full plain text / Markdown exactly as persisted (tool payloads excluded). */
  text: string;
  /** ISO 8601 timestamp. Use the host's timestamp; if absent, the time first seen. */
  createdAt: string;
  /** false only for an assistant message that is still streaming. */
  complete: boolean;
}

export type HostEvent =
  | { type: 'session_changed'; session: SessionRef | null }
  | { type: 'assistant_chunk'; sessionId: string; messageId: string; delta: string }
  | { type: 'assistant_done'; sessionId: string; message: Message }
  | { type: 'user_message'; sessionId: string; message: Message }
  | { type: 'history_reset'; sessionId: string }
  | { type: 'connection'; state: 'connected' | 'reconnecting' | 'disconnected' };

export interface InjectResult {
  /** Resolution means success; failures reject with HostAdapterError. */
  ok: true;
  /** Where the text will end up once the user sends. */
  fidelity: TranscriptFidelity;
  /**
   * true when the text now sits in unsent composer text and only reaches the
   * conversation if the user sends it (Crew primary path). false when the host
   * attaches it to the next turn by itself (e.g. a prompt hook).
   */
  requiresUserSend: boolean;
  /** Optional human-readable note shown in the panel. */
  detail?: string;
}

export interface SendResult {
  ok: true;
  /** Id of the created user message, if the host returns it. */
  messageId?: string;
  detail?: string;
}

export interface WorkingCopyStorage {
  load(sessionId: string, draftId: string): Promise<WorkingCopy | null>;
  save(copy: WorkingCopy): Promise<void>;
  remove(sessionId: string, draftId: string): Promise<void>;
  /** Optional: all working copies of a session (used on rebuild). */
  list?(sessionId: string): Promise<WorkingCopy[]>;
}

export interface HostAdapter {
  readonly info: HostInfo;
  readonly capabilities: HostCapabilities;

  /** Establish host connections. Idempotent. Must resolve before other calls. */
  connect(): Promise<void>;
  /** Release everything. After dispose, every method rejects with 'not_connected'. Idempotent. */
  dispose(): Promise<void>;

  /** The session the panel is attached to, or null if none is active. */
  getActiveSession(): Promise<SessionRef | null>;
  /** Optional: sessions the user can pick from. */
  listSessions?(): Promise<SessionRef[]>;

  /** Persisted history in conversation order (oldest first). */
  getHistory(sessionId: string): Promise<{ messages: Message[]; completeness: HistoryCompleteness }>;

  /** Register a listener. Returns an unsubscribe function. */
  subscribe(listener: (event: HostEvent) => void): () => void;

  /** Attach text (one or more draft-changelog fences) to the user's next turn. */
  injectNextTurn(sessionId: string, text: string): Promise<InjectResult>;

  /** Send text (a draft-rewrite message) as a user message now. */
  sendNow(sessionId: string, text: string): Promise<SendResult>;

  /** Optional: open or focus the panel. Present only if capabilities.canAutoOpenPanel. */
  openPanel?(): Promise<void>;

  /** Optional working-copy storage. Present only if capabilities.hasHostStorage. */
  readonly storage?: WorkingCopyStorage;
}
