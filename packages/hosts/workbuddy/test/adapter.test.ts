import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostEvent } from '@draft-canvas/core';
import { WorkBuddyAdapter, type Transport } from '../src/adapter';
import type { HistoryBody, HubInfo, StreamFrame } from '../src/protocol';

const INFO: HubInfo = {
  protocol: '1',
  hubVersion: '0.1.0',
  host: { id: 'workbuddy', displayName: 'WorkBuddy', home: 'C:/Users/x/.workbuddy', settingsPath: 'C:/Users/x/.workbuddy/settings.json', hooksInstalled: true },
  sessions: [
    { sessionId: 'sess-1', title: '出行草稿', transcript: true },
    { sessionId: 'sess-2', transcript: true },
  ],
  activeSessionId: 'sess-1',
  liveUpdates: true,
  pending: [],
};

const HISTORY: HistoryBody = {
  source: 'transcript',
  completeness: 'full',
  messages: [
    { id: 'u1', sessionId: 'sess-1', role: 'user', text: '写一份草稿', createdAt: '2026-11-19T06:00:00.000Z', complete: true },
    { id: 'a1', sessionId: 'sess-1', role: 'assistant', text: '```draft id="note"\n第一版\n```', createdAt: '2026-11-19T06:00:01.000Z', complete: true },
    // A record the hub should never send, but if it does the adapter drops it instead of crashing.
    { id: 'bad', sessionId: 'sess-1', role: 'gremlin', text: '', createdAt: '', complete: true } as never,
  ],
};

class FakeTransport implements Transport {
  readonly calls: string[] = [];
  info: HubInfo = INFO;
  history: HistoryBody = HISTORY;
  injectResult: unknown = { ok: true, sessionId: 'sess-1', queuedAt: '2026-11-19T06:00:02.000Z', pending: 1, note: 'Queued: your next message carries it.' };
  private frame: ((frame: StreamFrame) => void) | null = null;
  private state: ((state: 'connected' | 'reconnecting' | 'disconnected') => void) | null = null;
  unsubscribed = false;

  async get(path: string): Promise<unknown> {
    this.calls.push(`GET ${path}`);
    if (path === '/api/info') return this.info;
    if (path === '/api/sessions') return { sessions: this.info.sessions, activeSessionId: this.info.activeSessionId };
    return this.history;
  }

  async post(path: string, body?: unknown): Promise<unknown> {
    this.calls.push(`POST ${path} ${JSON.stringify(body ?? {})}`);
    return this.injectResult;
  }

  stream(onFrame: (frame: StreamFrame) => void, onState: (state: 'connected' | 'reconnecting' | 'disconnected') => void): () => void {
    this.frame = onFrame;
    this.state = onState;
    onState('connected');
    return () => {
      this.unsubscribed = true;
    };
  }

  push(frame: StreamFrame): void {
    this.frame?.(frame);
  }

  setState(state: 'connected' | 'reconnecting' | 'disconnected'): void {
    this.state?.(state);
  }
}

function collect(adapter: WorkBuddyAdapter): HostEvent[] {
  const events: HostEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  return events;
}

describe('WorkBuddyAdapter', () => {
  let transport: FakeTransport;
  let adapter: WorkBuddyAdapter;
  let events: HostEvent[];

  beforeEach(async () => {
    transport = new FakeTransport();
    adapter = new WorkBuddyAdapter({ transport });
    await adapter.connect();
    events = collect(adapter);
  });

  it('identifies itself as interface 1', () => {
    expect(adapter.info.interfaceVersion).toBe('1');
    expect(adapter.info.id).toBe('workbuddy');
  });

  it('reports only the capabilities WorkBuddy actually has', () => {
    expect(adapter.capabilities).toMatchObject({
      canReadFullHistory: true,
      canStreamTokens: false,
      canSendNow: false,
      canAppendToComposer: false,
      canRewritePersistedUserMessage: false,
      canAutoOpenPanel: false,
      hasHostStorage: true,
    });
  });

  it('follows the hub’s active session, with its title', async () => {
    await expect(adapter.getActiveSession()).resolves.toEqual({ sessionId: 'sess-1', title: '出行草稿' });
    await expect(adapter.listSessions()).resolves.toEqual([
      { sessionId: 'sess-1', title: '出行草稿' },
      { sessionId: 'sess-2' },
    ]);
  });

  it('reads history and drops records that are not messages', async () => {
    const history = await adapter.getHistory('sess-1');
    expect(history.completeness).toBe('full');
    expect(history.messages.map((message) => message.id)).toEqual(['u1', 'a1']);
    // After a history read, the adapter stays on that chat even if another one becomes active.
    transport.push({ type: 'sessions', activeSessionId: 'sess-2', sessions: INFO.sessions });
    await expect(adapter.getActiveSession()).resolves.toEqual({ sessionId: 'sess-1', title: '出行草稿' });
  });

  it('queues changes as context-only, without asking the user to send them', async () => {
    const result = await adapter.injectNextTurn('sess-1', '```draft-changelog id="note" from="1" to="2"\n…\n```');
    expect(result).toEqual({
      ok: true,
      fidelity: 'context-only',
      requiresUserSend: false,
      detail: 'Queued: your next message carries it.',
    });
    expect(transport.calls).toContain('POST /api/sessions/sess-1/inject {"text":"```draft-changelog id=\\"note\\" from=\\"1\\" to=\\"2\\"\\n…\\n```"}');
  });

  it('refuses sendNow with unsupported, because the host has no such route', async () => {
    await expect(adapter.sendNow('sess-1', 'hi')).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('forwards events of the attached chat and drops the rest', async () => {
    await adapter.getHistory('sess-1');
    events.length = 0;
    transport.push({ type: 'host', event: { type: 'user_message', sessionId: 'sess-2', message: { id: 'x' } } });
    transport.push({ type: 'host', event: { type: 'assistant_chunk', sessionId: 'sess-1', messageId: 'a2', delta: '一' } });
    transport.push({ type: 'host', event: { type: 'assistant_done', sessionId: 'sess-1', message: { id: 'a2' } } });
    expect(events.map((event) => event.type)).toEqual(['assistant_chunk', 'assistant_done']);
  });

  it('announces a session change only while nothing is attached', () => {
    events.length = 0;
    transport.push({ type: 'sessions', activeSessionId: 'sess-2', sessions: INFO.sessions });
    expect(events).toEqual([{ type: 'session_changed', session: { sessionId: 'sess-2' } }]);
  });

  it('rebuilds after the stream came back', async () => {
    await adapter.getHistory('sess-1');
    events.length = 0;
    transport.setState('reconnecting');
    transport.setState('connected');
    expect(events).toEqual([
      { type: 'connection', state: 'reconnecting' },
      { type: 'connection', state: 'connected' },
      { type: 'history_reset', sessionId: 'sess-1' },
    ]);
  });

  it('rejects a hub with a different protocol', async () => {
    const other = new FakeTransport();
    other.info = { ...INFO, protocol: '2' };
    const fresh = new WorkBuddyAdapter({ transport: other });
    await expect(fresh.connect()).rejects.toThrow(/protocol 2/);
  });

  it('rejects everything after dispose and drops the stream', async () => {
    await adapter.dispose();
    expect(transport.unsubscribed).toBe(true);
    await expect(adapter.getActiveSession()).rejects.toMatchObject({ code: 'not_connected' });
    await expect(adapter.getHistory('sess-1')).rejects.toMatchObject({ code: 'not_connected' });
  });

  it('turns a transport failure into a readable host error', async () => {
    const failing = new FakeTransport();
    const broken = new WorkBuddyAdapter({
      transport: {
        ...failing,
        get: vi.fn(async () => {
          throw new Error('hub unreachable (Failed to fetch)');
        }),
      } as unknown as Transport,
    });
    await expect(broken.connect()).rejects.toMatchObject({ code: 'host_error', message: expect.stringContaining('Failed to fetch') });
  });
});
