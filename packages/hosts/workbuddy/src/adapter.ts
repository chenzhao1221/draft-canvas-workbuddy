import {
  HostAdapterError,
  type HistoryCompleteness,
  type HostAdapter,
  type HostCapabilities,
  type HostEvent,
  type HostInfo,
  type InjectResult,
  type Message,
  type MessageRole,
  type SendResult,
  type SessionRef,
  type WorkingCopyStorage,
} from '@draft-canvas/core';
import {
  ADAPTER_VERSION,
  HOST_DISPLAY_NAME,
  HOST_ID,
  isRecord,
  pickString,
  type HistoryBody,
  type HubInfo,
  type InjectBody,
  type StreamFrame,
} from './protocol';
import { LocalStorageWorkingCopies, type KeyValueStorage } from './storage';
import { diag } from './diag';

/** What the adapter needs from the browser: two REST calls and one SSE stream. */
export interface Transport {
  get(path: string): Promise<unknown>;
  post(path: string, body?: unknown): Promise<unknown>;
  /** Subscribes to hub frames; returns an unsubscribe function. */
  stream(onFrame: (frame: StreamFrame) => void, onState: (state: 'connected' | 'reconnecting' | 'disconnected') => void): () => void;
}

export interface WorkBuddyAdapterOptions {
  transport: Transport;
  /**
   * `'hub'` (default): the panel is a page talking to `draft-canvas-wb`; there is no way to post a
   * message. `'app'`: the panel is an MCP App widget, and `ui/message` posts a real user message.
   */
  mode?: 'hub' | 'app';
  /** Defaults to `window.localStorage`. */
  storageBackend?: KeyValueStorage;
  now?: () => number;
}

const ROLES: ReadonlySet<string> = new Set(['user', 'assistant', 'system', 'tool']);

function isMessage(value: unknown): value is Message {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.sessionId === 'string' &&
    typeof value.role === 'string' &&
    ROLES.has(value.role) &&
    typeof value.text === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.complete === 'boolean'
  );
}

/**
 * WorkBuddy host adapter (ADAPTER_INTERFACE section 5).
 *
 * There is no host SDK to call: WorkBuddy exposes no API to a panel. Everything therefore goes
 * through the local hub the user started (`draft-canvas-wb start`), which
 *
 * - reads the session transcript for `getHistory`,
 * - forwards `UserPromptSubmit` / `Stop` hooks and transcript growth as events,
 * - writes queued changelogs into the file that the `UserPromptSubmit` hook prints as extra context.
 *
 * Capabilities are reported from what the host actually allows (`docs/hosts/workbuddy.md`):
 * history is complete, nothing streams (the host persists no assistant text), nothing can be typed
 * into the composer, and `sendNow` does not exist — so a rewrite request goes
 * through `injectNextTurn` and the "Send to the agent" button reads "put it in my next message".
 */
export class WorkBuddyAdapter implements HostAdapter {
  readonly capabilities: HostCapabilities;

  readonly storage: WorkingCopyStorage;

  private readonly transport: Transport;
  private readonly listeners = new Set<(event: HostEvent) => void>();
  private infoSnapshot: HubInfo | null = null;
  /** Session core last read the history of — the panel's choice, or the hub's active session. */
  private attached: string | null = null;
  private connected = false;
  private disposed = false;
  private unsubscribe: (() => void) | null = null;
  private lastConnection: 'connected' | 'reconnecting' | 'disconnected' | null = null;

  constructor(options: WorkBuddyAdapterOptions) {
    this.transport = options.transport;
    this.storage = new LocalStorageWorkingCopies(options.storageBackend);
    this.capabilities = {
      canReadFullHistory: true,
      // Q-2: the host writes no assistant text to the transcript, so there is nothing to stream.
      canStreamTokens: false,
      // Only the MCP App version can post a message: `ui/message` writes a real user turn.
      canSendNow: options.mode === 'app',
      // `ui/message` posts a real user turn, so the changes ARE in the stored history; the hook path
      // (hub mode) only adds context to the turn.
      canRewritePersistedUserMessage: options.mode === 'app',
      canAppendToComposer: false,
      // Q-5: nothing can open the panel on the user's behalf, in either mode.
      canAutoOpenPanel: false,
      hasHostStorage: true,
    };
  }

  get info(): HostInfo {
    return {
      id: HOST_ID,
      displayName: HOST_DISPLAY_NAME,
      adapterVersion: ADAPTER_VERSION,
      interfaceVersion: '1',
    };
  }

  // ---------------------------------------------------------------- lifecycle

  async connect(): Promise<void> {
    if (this.disposed) throw new HostAdapterError('not_connected', 'The adapter was disposed.');
    if (this.connected) return;
    try {
      this.infoSnapshot = this.parseInfo(await this.transport.get('/api/info'));
    } catch (err) {
      throw this.toError(err, 'reach the hub');
    }
    this.connected = true;
    try {
      this.unsubscribe = this.transport.stream(
        (frame) => this.onFrame(frame),
        (state) => this.onConnection(state),
      );
    } catch (err) {
      this.connected = false;
      diag(`event stream FAILED (${this.describe(err)})`);
      throw new HostAdapterError('host_error', `Could not open the event stream: ${this.describe(err)}`, { cause: err });
    }
    diag(`connected (${this.infoSnapshot.sessions.length} sessions, live=${String(this.infoSnapshot.liveUpdates)})`);
    this.emit({ type: 'connection', state: 'connected' });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.connected = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.listeners.clear();
  }

  // ----------------------------------------------------------------- sessions

  async getActiveSession(): Promise<SessionRef | null> {
    this.assertConnected();
    const sessionId = this.attached ?? this.infoSnapshot?.activeSessionId ?? null;
    if (sessionId === null) return null;
    return this.refOf(sessionId);
  }

  async listSessions(): Promise<SessionRef[]> {
    this.assertConnected();
    let sessions = this.infoSnapshot?.sessions ?? [];
    try {
      const payload = await this.transport.get('/api/sessions');
      if (isRecord(payload) && Array.isArray(payload.sessions)) sessions = payload.sessions as HubInfo['sessions'];
    } catch (err) {
      diag(`listSessions FAILED (${this.describe(err)})`);
    }
    return sessions.map((session) => this.refOf(session.sessionId, session.title));
  }

  async getHistory(sessionId: string): Promise<{ messages: Message[]; completeness: HistoryCompleteness }> {
    this.assertConnected();
    let body: HistoryBody;
    try {
      const payload = await this.transport.get(`/api/sessions/${encodeURIComponent(sessionId)}/history`);
      if (!isRecord(payload) || !Array.isArray(payload.messages)) {
        throw new HostAdapterError('host_error', 'The hub returned no message list.');
      }
      body = payload as unknown as HistoryBody;
    } catch (err) {
      diag(`history ${sessionId.slice(0, 8)}: FAILED (${this.describe(err)})`);
      throw this.toError(err, 'read this chat');
    }
    const messages = body.messages.filter(isMessage).map((message) => ({
      ...message,
      // The hub reports the session it was asked about; trust it over the record.
      sessionId,
      role: message.role as MessageRole,
    }));
    this.attached = sessionId;
    diag(`history ${sessionId.slice(0, 8)}: ${messages.length} messages (${body.source}, ${body.completeness})${body.note === undefined ? '' : ` — ${body.note}`}`);
    return { messages, completeness: body.completeness === 'window' ? 'window' : 'full' };
  }

  subscribe(listener: (event: HostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ------------------------------------------------------------------ writing

  /**
   * Queues the text for the user's next message in this chat (ADAPTER_INTERFACE section 8).
   *
   * Fidelity is `'context-only'`: the `UserPromptSubmit` hook prints the text as `additionalContext`,
   * so the model sees it but the stored user message does not contain it. `requiresUserSend` is
   * `false` because the hub attaches it by itself — the user only has to send *something*.
   */
  async injectNextTurn(sessionId: string, text: string): Promise<InjectResult> {
    this.assertConnected();
    let body: InjectBody;
    try {
      const payload = await this.transport.post(`/api/sessions/${encodeURIComponent(sessionId)}/inject`, { text });
      if (!isRecord(payload)) throw new HostAdapterError('host_error', 'The hub accepted no text.');
      body = payload as unknown as InjectBody;
    } catch (err) {
      diag(`inject ${sessionId.slice(0, 8)}: FAILED (${this.describe(err)})`);
      throw this.toError(err, 'queue your changes');
    }
    diag(`inject ${sessionId.slice(0, 8)}: queued ${text.length} chars (${body.pending ?? '?'} waiting)`);
    return {
      ok: true,
      fidelity: 'context-only',
      requiresUserSend: false,
      ...(typeof body.note === 'string' ? { detail: body.note } : {}),
    };
  }

  /**
   * In `app` mode the transport turns this into `ui/message`: a real user message in this chat, which
   * also wakes the agent. In `hub` mode there is no such route and this rejects with `unsupported`.
   */
  async sendNow(sessionId: string, text: string): Promise<SendResult> {
    this.assertConnected();
    if (!this.capabilities.canSendNow) {
      throw new HostAdapterError('unsupported', 'WorkBuddy has no API to post a message as the user.');
    }
    try {
      const payload = await this.transport.post(`/api/sessions/${encodeURIComponent(sessionId)}/inject`, { text });
      const detail = isRecord(payload) && typeof payload.note === 'string' ? payload.note : undefined;
      return { ok: true, ...(detail !== undefined ? { detail } : {}) };
    } catch (err) {
      diag(`send ${sessionId.slice(0, 8)}: FAILED (${this.describe(err)})`);
      throw this.toError(err, 'send your changes');
    }
  }

  /** Records the chat the user picked, so `getActiveSession` stops following the last hook event. */
  async attach(sessionId: string): Promise<void> {
    this.assertConnected();
    this.attached = sessionId;
    try {
      await this.transport.post(`/api/sessions/${encodeURIComponent(sessionId)}/attach`, {});
    } catch (err) {
      diag(`attach ${sessionId.slice(0, 8)}: FAILED (${this.describe(err)})`);
    }
  }

  /** Diagnostics for the panel header: hub state plus the adapter's own view. */
  diagnostics(extra: string[] = []): string {
    const info = this.infoSnapshot;
    const lines = [
      `${HOST_DISPLAY_NAME} adapter ${ADAPTER_VERSION} (interface 1)`,
      info === null
        ? 'hub: not connected'
        : `hub: ${info.hubVersion} at ${info.host.home} protocol=${info.protocol} live=${String(info.liveUpdates)}${info.demo === true ? ' demo' : ''}`,
      `attached: ${this.attached ?? '-'}  active: ${info?.activeSessionId ?? '-'}  sessions: ${info?.sessions.length ?? 0}`,
      `capabilities: send=${String(this.capabilities.canSendNow)} composer=${String(this.capabilities.canAppendToComposer)} stream=${String(this.capabilities.canStreamTokens)}`,
      ...extra,
    ];
    return lines.join('\n');
  }

  // ------------------------------------------------------------------- frames

  private onFrame(frame: StreamFrame): void {
    if (this.disposed) return;
    if (frame.type === 'hello') {
      this.infoSnapshot = frame.info;
      return;
    }
    if (frame.type === 'sessions') {
      const previous = this.infoSnapshot?.activeSessionId ?? null;
      if (this.infoSnapshot !== null) {
        this.infoSnapshot = {
          ...this.infoSnapshot,
          activeSessionId: frame.activeSessionId,
          sessions: frame.sessions,
        };
      }
      if (frame.activeSessionId !== previous) {
        diag(`active session: ${frame.activeSessionId === null ? '-' : frame.activeSessionId.slice(0, 8)}`);
        if (this.attached === null) this.emit({ type: 'session_changed', session: frame.activeSessionId === null ? null : this.refOf(frame.activeSessionId) });
      }
      return;
    }
    const event = frame.event;
    if (!isRecord(event) || typeof event.type !== 'string') return;
    if (event.type === 'connection') return;
    const sessionId = typeof event.sessionId === 'string' ? event.sessionId : undefined;
    if (sessionId !== undefined && this.attached !== null && sessionId !== this.attached) {
      // Events for other chats: dropped, exactly like the Crew adapter with `slots:user`.
      if (event.type !== 'assistant_chunk') diag(`event ${event.type}: other chat`);
      return;
    }
    if (event.type !== 'assistant_chunk') diag(`event ${event.type}${sessionId === undefined ? '' : ` ${sessionId.slice(0, 8)}`}`);
    this.emit(event as unknown as HostEvent);
  }

  private onConnection(state: 'connected' | 'reconnecting' | 'disconnected'): void {
    if (this.disposed || state === this.lastConnection) return;
    const recovered = state === 'connected' && this.lastConnection !== null && this.lastConnection !== 'connected';
    this.lastConnection = state;
    diag(`connection: ${state}`);
    this.emit({ type: 'connection', state });
    if (recovered && this.attached !== null) {
      // Pushes may have been missed while the stream was down: rebuild from history.
      this.emit({ type: 'history_reset', sessionId: this.attached });
    }
  }

  private refOf(sessionId: string, title?: string): SessionRef {
    const known = title ?? this.infoSnapshot?.sessions.find((session) => session.sessionId === sessionId)?.title;
    return known === undefined ? { sessionId } : { sessionId, title: known };
  }

  private parseInfo(value: unknown): HubInfo {
    if (!isRecord(value) || !isRecord(value.host) || !Array.isArray(value.sessions)) {
      throw new HostAdapterError('host_error', 'The hub sent an unexpected /api/info payload.');
    }
    const protocol = pickString(value, ['protocol']);
    if (protocol !== '1') {
      throw new HostAdapterError('host_error', `The hub speaks protocol ${protocol ?? '?'}; this panel expects 1. Update both together.`);
    }
    return value as unknown as HubInfo;
  }

  private emit(event: HostEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        console.error('draft-canvas: a listener failed');
      }
    }
  }

  private assertConnected(): void {
    if (this.disposed || !this.connected) {
      throw new HostAdapterError('not_connected', 'Not connected to the hub. Call connect() first.');
    }
  }

  private describe(err: unknown): string {
    if (err instanceof HostAdapterError) return `${err.code}: ${err.message}`;
    return err instanceof Error ? err.message : String(err);
  }

  private toError(err: unknown, action: string): HostAdapterError {
    if (err instanceof HostAdapterError) return err;
    const code = isRecord(err) && typeof err.status === 'number' && err.status === 403 ? 'permission_denied' : 'host_error';
    const detail = err instanceof Error ? err.message : String(err);
    return new HostAdapterError(code, `Could not ${action}: ${detail}`, { cause: err });
  }
}
