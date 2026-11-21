import {
  HostAdapterError,
  MemoryWorkingCopyStorage,
  type HostAdapter,
  type HostCapabilities,
  type HostEvent,
  type HistoryCompleteness,
  type InjectResult,
  type Message,
  type SendResult,
  type SessionRef,
  type WorkingCopyStorage,
} from '@draft-canvas/core';

/**
 * In-memory host for component tests (T-38). It implements only the adapter interface the panel uses and
 * records what the panel staged or sent. It is a test helper, never part of `src`, and copies no host code.
 */

export const UI_TEST_CAPABILITIES: HostCapabilities = {
  canReadFullHistory: true,
  canStreamTokens: true,
  canSendNow: true,
  canRewritePersistedUserMessage: false,
  canAppendToComposer: true,
  canAutoOpenPanel: false,
  hasHostStorage: true,
};

export interface UiFakeHostOptions {
  sessionId?: string;
  title?: string;
  messages?: readonly Message[];
  capabilities?: Partial<HostCapabilities>;
}

export class UiFakeHost implements HostAdapter {
  readonly info = {
    id: 'ui-test-host',
    displayName: 'UI test host',
    adapterVersion: '0.0.0',
    interfaceVersion: '1' as const,
  };
  readonly capabilities: HostCapabilities;
  readonly storage: WorkingCopyStorage = new MemoryWorkingCopyStorage();

  readonly injected: string[] = [];
  readonly sent: string[] = [];

  private readonly sessionRef: SessionRef;
  private readonly transcript: Message[];
  private readonly listeners = new Set<(event: HostEvent) => void>();
  private connected = false;

  constructor(options: UiFakeHostOptions = {}) {
    const sessionId = options.sessionId ?? 'session-1';
    this.sessionRef = { sessionId, title: options.title ?? 'Test chat' };
    this.transcript = (options.messages ?? []).map((message) => ({ ...message }));
    this.capabilities = { ...UI_TEST_CAPABILITIES, ...options.capabilities };
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async dispose(): Promise<void> {
    this.connected = false;
    this.listeners.clear();
  }

  async getActiveSession(): Promise<SessionRef | null> {
    this.assertConnected();
    return { ...this.sessionRef };
  }

  async listSessions(): Promise<SessionRef[]> {
    this.assertConnected();
    return [{ ...this.sessionRef }];
  }

  async getHistory(sessionId: string): Promise<{ messages: Message[]; completeness: HistoryCompleteness }> {
    this.assertConnected();
    if (sessionId !== this.sessionRef.sessionId) {
      throw new HostAdapterError('session_not_found', `Unknown session ${sessionId}`);
    }
    return { messages: this.transcript.map((message) => ({ ...message })), completeness: 'full' };
  }

  subscribe(listener: (event: HostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async injectNextTurn(sessionId: string, text: string): Promise<InjectResult> {
    this.assertConnected();
    if (sessionId !== this.sessionRef.sessionId) {
      throw new HostAdapterError('session_not_found', `Unknown session ${sessionId}`);
    }
    this.injected.push(text);
    return { ok: true, fidelity: 'context-only', requiresUserSend: true };
  }

  async sendNow(sessionId: string, text: string): Promise<SendResult> {
    this.assertConnected();
    if (sessionId !== this.sessionRef.sessionId) {
      throw new HostAdapterError('session_not_found', `Unknown session ${sessionId}`);
    }
    this.sent.push(text);
    return { ok: true };
  }

  // -------------------------------------------------------------- test drivers

  /** Delivers a `HostEvent` to the controller list synchronously. */
  emit(event: HostEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  /** Appends an assistant message and emits one `assistant_done`. */
  finishAssistant(text: string, id: string): void {
    const message: Message = {
      id,
      sessionId: this.sessionRef.sessionId,
      role: 'assistant',
      text,
      createdAt: '2026-01-01T00:00:00.000Z',
      complete: true,
    };
    this.transcript.push(message);
    this.emit({ type: 'assistant_done', sessionId: message.sessionId, message });
  }

  private assertConnected(): void {
    if (!this.connected) throw new HostAdapterError('not_connected', 'connect() has not completed');
  }
}

/** One assistant reply carrying a single draft fence. */
export function draftReply(id: string, body: string, title?: string): string {
  const titleAttr = title === undefined ? '' : ` title="${title}"`;
  return [`\`\`\`draft id="${id}"${titleAttr}`, body, '```'].join('\n');
}
