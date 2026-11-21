import {
  HostAdapterError,
  utf8ByteLength,
  type Clock,
  type HostAdapter,
  type HostCapabilities,
  type HostEvent,
  type HostInfo,
  type HistoryCompleteness,
  type InjectResult,
  type Message,
  type SendResult,
  type SessionRef,
  type TranscriptFidelity,
  type WorkingCopy,
  type WorkingCopyStorage,
} from '../../src/index';

export const FAKE_CAPABILITIES: HostCapabilities = {
  canReadFullHistory: true,
  canStreamTokens: true,
  canSendNow: true,
  canRewritePersistedUserMessage: true,
  canAppendToComposer: true,
  canAutoOpenPanel: false,
  hasHostStorage: true,
};

export interface FakeHostOptions {
  sessionId?: string;
  title?: string;
  messages?: readonly Message[];
  capabilities?: Partial<HostCapabilities>;
  info?: Partial<Omit<HostInfo, 'interfaceVersion'>> & { interfaceVersion?: HostInfo['interfaceVersion'] };
  completeness?: HistoryCompleteness;
  /** `null` disables host storage (capability `hasHostStorage` becomes false). */
  storage?: WorkingCopyStorage | null;
  fidelity?: TranscriptFidelity;
  requiresUserSend?: boolean;
  maxInjectBytes?: number;
  maxSendBytes?: number;
  /** false: `getActiveSession()` returns null. */
  hasActiveSession?: boolean;
  connectError?: unknown;
  historyError?: unknown;
  injectError?: unknown;
  sendError?: unknown;
}

function copyMessage(message: Message): Message {
  return { ...message };
}

/** In-memory working-copy storage with failure switches (ADAPTER_INTERFACE section 14.2). */
export class FakeHostStorage implements WorkingCopyStorage {
  readonly copies = new Map<string, WorkingCopy>();
  failLoad: unknown = null;
  failSave: unknown = null;
  failList: unknown = null;
  saveCalls = 0;

  private static key(sessionId: string, draftId: string): string {
    return `${sessionId}\u0000${draftId}`;
  }

  async load(sessionId: string, draftId: string): Promise<WorkingCopy | null> {
    if (this.failLoad !== null) throw this.failLoad;
    const copy = this.copies.get(FakeHostStorage.key(sessionId, draftId));
    return copy === undefined ? null : { ...copy };
  }

  async save(copy: WorkingCopy): Promise<void> {
    this.saveCalls += 1;
    if (this.failSave !== null) throw this.failSave;
    this.copies.set(FakeHostStorage.key(copy.sessionId, copy.draftId), { ...copy });
  }

  async remove(sessionId: string, draftId: string): Promise<void> {
    if (this.failSave !== null) throw this.failSave;
    this.copies.delete(FakeHostStorage.key(sessionId, draftId));
  }

  async list(sessionId: string): Promise<WorkingCopy[]> {
    if (this.failList !== null) throw this.failList;
    return [...this.copies.values()].filter((c) => c.sessionId === sessionId).map((c) => ({ ...c }));
  }
}

/**
 * A host adapter backed by in-memory transcripts. It is a test helper, never part
 * of `src`: it stands in for a real host in unit tests and in the conformance
 * suite (docs/ADAPTER_INTERFACE.md section 19).
 *
 * Events caused by `injectNextTurn` and `sendNow` are delivered in a microtask,
 * as ADAPTER_INTERFACE section 5 requires (no re-entrant listener calls).
 */
export class FakeHost implements HostAdapter {
  readonly info: HostInfo;
  readonly capabilities: HostCapabilities;
  readonly storage?: WorkingCopyStorage;

  readonly sessions: SessionRef[];
  readonly transcript = new Map<string, Message[]>();
  readonly injected: { sessionId: string; text: string }[] = [];
  readonly sent: { sessionId: string; text: string }[] = [];

  connectCalls = 0;
  disposeCalls = 0;
  historyCalls = 0;
  activeSessionCalls = 0;

  private readonly listeners = new Set<(event: HostEvent) => void>();
  private connected = false;
  private activeRef: SessionRef | null;
  private readonly completeness: HistoryCompleteness;
  private readonly fidelity: TranscriptFidelity;
  private readonly requiresUserSend: boolean;
  private readonly maxInjectBytes: number | undefined;
  private readonly maxSendBytes: number | undefined;
  private readonly options: FakeHostOptions;
  private composerText = '';
  private nextUserId = 1;
  private nextAssistantId = 1;

  constructor(options: FakeHostOptions = {}) {
    this.options = options;
    const sessionId = options.sessionId ?? 'session-1';
    this.info = {
      id: 'fake-host',
      displayName: 'Fake Host',
      adapterVersion: '0.0.0',
      interfaceVersion: '1',
      ...options.info,
    };
    const capabilities: HostCapabilities = { ...FAKE_CAPABILITIES, ...options.capabilities };
    if (options.storage === null) capabilities.hasHostStorage = false;
    this.capabilities = Object.freeze(capabilities);
    this.storage =
      options.storage === null ? undefined : (options.storage ?? (capabilities.hasHostStorage ? new FakeHostStorage() : undefined));
    this.completeness = options.completeness ?? 'full';
    this.fidelity = options.fidelity ?? 'persisted';
    this.requiresUserSend = options.requiresUserSend ?? true;
    this.maxInjectBytes = options.maxInjectBytes ?? capabilities.maxInjectBytes;
    this.maxSendBytes = options.maxSendBytes ?? capabilities.maxSendBytes;
    const ref: SessionRef = { sessionId, title: options.title ?? 'Fixture session' };
    this.sessions = [ref];
    this.activeRef = options.hasActiveSession === false ? null : ref;
    this.transcript.set(sessionId, (options.messages ?? []).map(copyMessage));
  }

  get sessionId(): string {
    return this.sessions[0]?.sessionId ?? 'session-1';
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** The unsent composer text, as the host would show it. */
  get composer(): string {
    return this.composerText;
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  get lastInjectedText(): string | undefined {
    return this.injected[this.injected.length - 1]?.text;
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.connected) return;
    if (this.options.connectError !== undefined) throw this.options.connectError;
    this.connected = true;
    this.dispatch({ type: 'connection', state: 'connected' });
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    this.connected = false;
    this.listeners.clear();
  }

  async getActiveSession(): Promise<SessionRef | null> {
    this.activeSessionCalls += 1;
    this.assertConnected();
    return this.activeRef === null ? null : { ...this.activeRef };
  }

  async listSessions(): Promise<SessionRef[]> {
    this.assertConnected();
    return this.sessions.map((ref) => ({ ...ref }));
  }

  async getHistory(sessionId: string): Promise<{ messages: Message[]; completeness: HistoryCompleteness }> {
    this.historyCalls += 1;
    this.assertConnected();
    if (this.options.historyError !== undefined) throw this.options.historyError;
    const messages = this.transcript.get(sessionId);
    if (messages === undefined) {
      throw new HostAdapterError('session_not_found', `Unknown session ${sessionId}`);
    }
    return { messages: messages.map(copyMessage), completeness: this.completeness };
  }

  subscribe(listener: (event: HostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async injectNextTurn(sessionId: string, text: string): Promise<InjectResult> {
    this.assertConnected();
    if (this.options.injectError !== undefined) throw this.options.injectError;
    if (!this.capabilities.canAppendToComposer && !this.capabilities.canRewritePersistedUserMessage) {
      throw new HostAdapterError('unsupported', 'This host cannot attach text to the next turn.');
    }
    this.assertKnownSession(sessionId);
    const limit = this.maxInjectBytes;
    if (limit !== undefined && utf8ByteLength(text) > limit) {
      throw new HostAdapterError('payload_too_large', `Text exceeds ${String(limit)} bytes.`);
    }
    this.injected.push({ sessionId, text });
    this.composerText = this.composerText === '' ? text : `${this.composerText}\n\n${text}`;
    return { ok: true, fidelity: this.fidelity, requiresUserSend: this.requiresUserSend };
  }

  async sendNow(sessionId: string, text: string): Promise<SendResult> {
    this.assertConnected();
    if (this.options.sendError !== undefined) throw this.options.sendError;
    if (!this.capabilities.canSendNow) {
      throw new HostAdapterError('unsupported', 'This host cannot send a message now.');
    }
    this.assertKnownSession(sessionId);
    const limit = this.maxSendBytes;
    if (limit !== undefined && utf8ByteLength(text) > limit) {
      throw new HostAdapterError('payload_too_large', `Text exceeds ${String(limit)} bytes.`);
    }
    const message = this.appendUserMessage(sessionId, text);
    this.sent.push({ sessionId, text });
    this.dispatchSoon({ type: 'user_message', sessionId, message: copyMessage(message) });
    return { ok: true, messageId: message.id };
  }

  // -------------------------------------------------------------- test drivers

  /** Delivers an event synchronously to every listener. */
  emit(event: HostEvent): void {
    this.dispatch(event);
  }

  /** Delivers an event in a microtask. */
  emitSoon(event: HostEvent): void {
    this.dispatchSoon(event);
  }

  streamChunk(messageId: string, delta: string, sessionId = this.sessionId): void {
    this.dispatch({ type: 'assistant_chunk', sessionId, messageId, delta });
  }

  /** Adds an assistant message to the transcript and emits one `assistant_done`. */
  finishAssistant(
    text: string,
    options: { id?: string; sessionId?: string; complete?: boolean; createdAt?: string } = {},
  ): Message {
    const sessionId = options.sessionId ?? this.sessionId;
    const message: Message = {
      id: options.id ?? `gen-a${this.nextAssistantId++}`,
      sessionId,
      role: 'assistant',
      text,
      createdAt: options.createdAt ?? '2026-01-01T00:00:00.000Z',
      complete: options.complete ?? true,
    };
    this.upsert(message);
    this.dispatch({ type: 'assistant_done', sessionId, message: copyMessage(message) });
    return message;
  }

  /** Persists an existing message and emits one `assistant_done` for it (conformance driver). */
  deliverAssistantDone(message: Message): void {
    this.upsert({ ...message });
    this.dispatch({ type: 'assistant_done', sessionId: message.sessionId, message: copyMessage(message) });
  }

  /** Persists an existing user message and emits `user_message` (conformance driver). */
  deliverUserMessage(message: Message): void {
    this.upsert({ ...message });
    this.dispatch({ type: 'user_message', sessionId: message.sessionId, message: copyMessage(message) });
  }

  /** Replaces the unsent composer text. */
  setComposer(text: string): void {
    this.composerText = text;
  }

  /** Adds a user message to the transcript and emits `user_message`. */
  sendUserMessage(text: string, options: { id?: string; sessionId?: string } = {}): Message {
    const sessionId = options.sessionId ?? this.sessionId;
    const message: Message = {
      id: options.id ?? `gen-u${this.nextUserId++}`,
      sessionId,
      role: 'user',
      text,
      createdAt: '2026-01-01T00:00:00.000Z',
      complete: true,
    };
    this.upsert(message);
    this.dispatch({ type: 'user_message', sessionId, message: copyMessage(message) });
    return message;
  }

  setConnection(state: 'connected' | 'reconnecting' | 'disconnected'): void {
    if (state === 'connected') this.connected = true;
    this.dispatch({ type: 'connection', state });
  }

  emitHistoryReset(sessionId = this.sessionId): void {
    this.dispatch({ type: 'history_reset', sessionId });
  }

  setActiveSession(ref: SessionRef | null): void {
    this.activeRef = ref === null ? null : { ...ref };
    this.dispatch({ type: 'session_changed', session: ref === null ? null : { ...ref } });
  }

  /** Simulates a full reload: closes the connection without dispatching, then reconnects. */
  async reload(): Promise<void> {
    this.connected = false;
    await this.connect();
  }

  /** Overwrites the transcript of a session (compaction, edits). */
  setMessages(sessionId: string, messages: readonly Message[]): void {
    this.transcript.set(sessionId, messages.map(copyMessage));
  }

  // ------------------------------------------------------------------ private

  private appendUserMessage(sessionId: string, text: string): Message {
    const message: Message = {
      id: `gen-u${this.nextUserId++}`,
      sessionId,
      role: 'user',
      text,
      createdAt: '2026-01-01T00:00:00.000Z',
      complete: true,
    };
    this.upsert(message);
    return message;
  }

  private upsert(message: Message): void {
    const messages = this.transcript.get(message.sessionId) ?? [];
    const index = messages.findIndex((m) => m.id === message.id);
    if (index >= 0) messages[index] = message;
    else messages.push(message);
    this.transcript.set(message.sessionId, messages);
  }

  private assertKnownSession(sessionId: string): void {
    if (!this.transcript.has(sessionId)) {
      throw new HostAdapterError('session_not_found', `Unknown session ${sessionId}`);
    }
  }

  private assertConnected(): void {
    if (!this.connected) throw new HostAdapterError('not_connected', 'connect() has not completed');
  }

  private dispatch(event: HostEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // ADAPTER_INTERFACE section 5: a throwing listener must not stop delivery.
      }
    }
  }

  private dispatchSoon(event: HostEvent): void {
    queueMicrotask(() => {
      if (this.connected) this.dispatch(event);
    });
  }
}

/** A clock with manually advanced timers, for the controller's debounce (REQ-7.4). */
export class FakeClock implements Clock {
  private current: number;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  constructor(startIso = '2026-01-01T00:00:00.000Z') {
    this.current = Date.parse(startIso);
  }

  now(): number {
    return this.current;
  }

  setTimer(callback: () => void, delayMs: number): () => void {
    this.seq += 1;
    const id = this.seq;
    this.timers.set(id, { at: this.current + delayMs, callback });
    return () => {
      this.timers.delete(id);
    };
  }

  get pendingTimers(): number {
    return this.timers.size;
  }

  /** Runs every timer due within `ms`, in time order, then lets promises settle. */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at);
      if (due.length === 0) break;
      const [id, timer] = due[0] as [number, { at: number; callback: () => void }];
      this.timers.delete(id);
      this.current = timer.at;
      timer.callback();
      await Promise.resolve();
    }
    this.current = target;
    await flushMicrotasks();
  }
}

/** Lets queued microtasks run (`queueMicrotask` events from the fake host). */
export async function flushMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}
