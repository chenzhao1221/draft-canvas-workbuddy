import { describe, expect, it, vi } from 'vitest';
import { HISTORY_PREFIX, McpTransport, STATE_URI } from '../src/mcpTransport';
import type { HistoryBody, HubInfo, StreamFrame } from '../src/protocol';

const INFO: HubInfo = {
  protocol: '1',
  hubVersion: '0.1.0',
  host: { id: 'workbuddy', displayName: 'WorkBuddy', home: 'h', settingsPath: 's', hooksInstalled: true },
  sessions: [{ sessionId: 'sess-1', title: '游记' }],
  activeSessionId: 'sess-1',
  liveUpdates: false,
  pending: [],
};

function message(id: string, role: 'user' | 'assistant', text: string) {
  return { id, sessionId: 'sess-1', role, text, createdAt: '2026-11-19T00:00:00.000Z', complete: true } as const;
}

describe('McpTransport', () => {
  it('maps the adapter routes onto resource reads', async () => {
    const resources = new Map<string, unknown>([
      [STATE_URI, INFO],
      [`${HISTORY_PREFIX}sess-1`, { messages: [message('u1', 'user', '写')], completeness: 'full', source: 'transcript' }],
    ]);
    const read = vi.fn(async (uri: string) => JSON.stringify(resources.get(uri)));
    const transport = new McpTransport({ readResource: read, sendUserMessage: vi.fn(), callTool: vi.fn() });

    await expect(transport.get('/api/info')).resolves.toMatchObject({ protocol: '1' });
    const history = (await transport.get('/api/sessions/sess-1/history')) as HistoryBody;
    expect(history.messages).toHaveLength(1);
    expect(read).toHaveBeenCalledWith(`${HISTORY_PREFIX}sess-1`);
  });

  it('posts a real message through the bridge', async () => {
    const sent: string[] = [];
    const transport = new McpTransport({
      readResource: async () => '{}',
      sendUserMessage: async (text) => {
        sent.push(text);
      },
      callTool: vi.fn(),
    });
    const result = (await transport.post('/api/sessions/sess-1/inject', { text: '```draft-changelog id="note" from="1" to="2"\n…\n```' })) as {
      ok: boolean;
      note: string;
    };
    expect(sent).toHaveLength(1);
    expect(result.ok).toBe(true);
    expect(result.note).toContain('发出');
  });

  it('falls back to the queue when the host refuses the message', async () => {
    const callTool = vi.fn(async () => ({ queuedAt: '2026-11-19T00:00:00.000Z', pending: 1 }));
    const transport = new McpTransport({
      readResource: async () => '{}',
      sendUserMessage: async () => {
        throw new Error('refused');
      },
      callTool,
    });
    const result = (await transport.post('/api/sessions/sess-1/inject', { text: 'x' })) as { pending: number; note: string };
    expect(callTool).toHaveBeenCalledWith('draft_canvas_queue', { session_id: 'sess-1', text: 'x' });
    expect(result.pending).toBe(1);
    expect(result.note).toContain('排队');
  });

  it('turns polled differences into host events', async () => {
    let history: HistoryBody = { messages: [], completeness: 'full', source: 'transcript' };
    const transport = new McpTransport(
      {
        readResource: async (uri) => JSON.stringify(uri === STATE_URI ? INFO : history),
        sendUserMessage: vi.fn(),
        callTool: vi.fn(),
      },
      20,
    );
    const frames: StreamFrame[] = [];
    const states: string[] = [];
    const stop = transport.stream(
      (frame) => frames.push(frame),
      (state) => states.push(state),
    );

    await transport.get('/api/sessions/sess-1/history');
    history = { messages: [message('u1', 'user', '写一份草稿')], completeness: 'full', source: 'transcript' };
    await new Promise((done) => setTimeout(done, 60));
    history = {
      messages: [message('u1', 'user', '写一份草稿'), message('a1', 'assistant', '```draft id="note"\n第一版\n```')],
      completeness: 'full',
      source: 'transcript',
    };
    await new Promise((done) => setTimeout(done, 60));
    stop();

    const types = frames.filter((frame) => frame.type === 'host').map((frame) => (frame as { event: { type: string } }).event.type);
    expect(types).toContain('user_message');
    expect(types).toContain('assistant_done');
    expect(states).toContain('connected');
    expect(states.at(-1)).toBe('disconnected');
  });
});
