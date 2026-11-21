import type { HostEvent } from '@draft-canvas/core';
import type { Transport } from './adapter';
import type { HistoryBody, HubInfo, StreamFrame } from './protocol';
import { diag } from './diag';

/**
 * The `HostAdapter` transport for the MCP App version.
 *
 * Same three calls as the local hub (`get`, `post`, `stream`), different pipe:
 * - reads become `resources/read` on `ui://draft-canvas/*` (no approval prompt: the spec treats a
 *   resource read as a safe GET);
 * - "send" becomes `ui/message`, which posts a real user message and wakes the agent — the one thing
 *   the browser version could not do;
 * - there is no push, so `stream()` polls the state resource and turns differences into host events.
 */
export interface McpBridge {
  readResource(uri: string): Promise<string>;
  /** Posts a user message into the chat. Rejects when the host refuses. */
  sendUserMessage(text: string): Promise<void>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export const STATE_URI = 'ui://draft-canvas/state';
export const HISTORY_PREFIX = 'ui://draft-canvas/history/';
const POLL_MS = 1_500;

export class McpTransport implements Transport {
  private sessionId: string | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private known = new Map<string, { id: string; text: string }>();
  private lastActive: string | null = null;
  private stopped = false;

  /** Side channel for the widget: the adapter consumes the frames, the chrome wants to react too. */
  onHostEvent: ((event: HostEvent) => void) | undefined;

  constructor(
    private readonly bridge: McpBridge,
    private readonly pollMs: number = POLL_MS,
  ) {}

  async get(path: string): Promise<unknown> {
    if (path === '/api/info' || path === '/api/sessions') return this.readJson<HubInfo>(STATE_URI);
    const match = /^\/api\/sessions\/([^/]+)\/history$/.exec(path);
    if (match !== null) {
      const sessionId = decodeURIComponent(match[1] ?? '');
      this.sessionId = sessionId;
      const body = await this.readJson<HistoryBody>(`${HISTORY_PREFIX}${encodeURIComponent(sessionId)}`);
      this.known = new Map(body.messages.map((message) => [message.id, { id: message.id, text: message.text }]));
      return body;
    }
    throw new Error(`the MCP transport has no route for ${path}`);
  }

  async post(path: string, body?: unknown): Promise<unknown> {
    const match = /^\/api\/sessions\/([^/]+)\/(inject|attach)$/.exec(path);
    if (match === null) throw new Error(`the MCP transport has no route for ${path}`);
    const sessionId = decodeURIComponent(match[1] ?? '');
    const action = match[2];
    if (action === 'attach') {
      this.sessionId = sessionId;
      return { ok: true };
    }
    const text = typeof body === 'object' && body !== null ? (body as { text?: unknown }).text : undefined;
    if (typeof text !== 'string') throw new Error('inject needs a text field');
    try {
      await this.bridge.sendUserMessage(text);
      diag(`send: ${text.length} chars posted to the chat`);
      return { ok: true, sessionId, queuedAt: new Date().toISOString(), pending: 0, note: '已作为一条消息发出。' };
    } catch (err) {
      // The host refused the message: fall back to the queued path the hook delivers.
      diag(`send FAILED (${err instanceof Error ? err.message : String(err)}), queuing instead`);
      const queued = (await this.bridge.callTool('draft_canvas_queue', { session_id: sessionId, text })) as {
        queuedAt?: string;
        pending?: number;
      };
      return {
        ok: true,
        sessionId,
        queuedAt: queued.queuedAt ?? new Date().toISOString(),
        pending: queued.pending ?? 1,
        note: '已排队：你下一条消息会带上这些改动。',
      };
    }
  }

  stream(
    onFrame: (frame: StreamFrame) => void,
    onState: (state: 'connected' | 'reconnecting' | 'disconnected') => void,
  ): () => void {
    this.stopped = false;
    const tick = async (): Promise<void> => {
      if (this.stopped) return;
      try {
        const info = await this.readJson<HubInfo>(STATE_URI);
        if (info.activeSessionId !== this.lastActive) {
          this.lastActive = info.activeSessionId;
          onFrame({ type: 'sessions', activeSessionId: info.activeSessionId, sessions: info.sessions });
        }
        onState('connected');
        if (this.sessionId === null) return;
        const history = await this.readJson<HistoryBody>(`${HISTORY_PREFIX}${encodeURIComponent(this.sessionId)}`);
        this.diff(history, onFrame);
      } catch (err) {
        diag(`poll FAILED (${err instanceof Error ? err.message : String(err)})`);
        onState('reconnecting');
      }
    };
    this.timer = setInterval(() => void tick(), this.pollMs);
    void tick();
    return () => {
      this.stopped = true;
      if (this.timer !== undefined) clearInterval(this.timer);
      this.timer = undefined;
      onState('disconnected');
    };
  }

  /** Turns new or changed messages into the events core expects. */
  private diff(history: HistoryBody, onFrame: (frame: StreamFrame) => void): void {
    const sessionId = this.sessionId;
    if (sessionId === null) return;
    let reset = false;
    for (const message of history.messages) {
      const previous = this.known.get(message.id);
      if (previous === undefined) {
        this.known.set(message.id, { id: message.id, text: message.text });
        if (message.role === 'assistant' && message.complete) {
          const event: HostEvent = { type: 'assistant_done', sessionId, message };
          onFrame({ type: 'host', event });
          this.onHostEvent?.(event);
        } else if (message.role === 'user') {
          const event: HostEvent = { type: 'user_message', sessionId, message };
          onFrame({ type: 'host', event });
          this.onHostEvent?.(event);
        }
      } else if (previous.text !== message.text) {
        previous.text = message.text;
        reset = true;
      }
    }
    if (reset) onFrame({ type: 'host', event: { type: 'history_reset', sessionId } satisfies HostEvent });
  }

  private async readJson<T>(uri: string): Promise<T> {
    const text = await this.bridge.readResource(uri);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`the hub returned no JSON for ${uri}`);
    }
  }
}
