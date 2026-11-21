import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handleRpc, HISTORY_PREFIX, STATE_URI, UI_MIME, UI_URI } from '../src/mcp/server';
import { DraftService } from '../src/mcp/service';
import type { HostPaths } from '../src/server/paths';
import { tempDir, user } from './helpers';

function pathsIn(dir: string): HostPaths {
  const home = join(dir, 'home');
  mkdirSync(join(home, 'projects', 'ws'), { recursive: true });
  const stateDir = join(dir, 'state');
  return {
    kind: 'workbuddy',
    home,
    settingsPath: join(home, 'settings.json'),
    stateDir,
    pendingDir: join(stateDir, 'pending'),
    sessionsFile: join(stateDir, 'sessions.json'),
    hubFile: join(stateDir, 'hub.json'),
    transcriptsRoot: join(home, 'projects'),
  };
}

const PANEL = '<!doctype html><title>panel</title>';

function setup() {
  const paths = pathsIn(tempDir());
  const transcript = join(paths.transcriptsRoot, 'ws', 'sess-1.jsonl');
  // An early UTC timestamp: a published draft is stamped "now", and history is merged by time.
  writeFileSync(
    transcript,
    `${JSON.stringify({ ...user('写一份草稿', 'u1'), timestamp: '2026-11-18T00:00:00.000Z' })}\n`,
    'utf8',
  );
  // A published draft, as the skill has the agent write it.
  const drafts = join(paths.stateDir, 'drafts', 'current');
  mkdirSync(drafts, { recursive: true });
  writeFileSync(join(drafts, 'note.md'), '<!-- title: 游记 -->\n# 游记\n\n第一版\n', 'utf8');
  const service = new DraftService(paths);
  service.registry.upsert({ sessionId: 'sess-1', transcriptPath: transcript, title: '测试会话' });
  service.registry.setActive('sess-1');
  service.start();
  const context = { service, panelHtml: () => PANEL };
  const call = (method: string, params?: unknown): Record<string, unknown> =>
    handleRpc({ jsonrpc: '2.0', id: 1, method, params }, context) ?? {};
  return { service, call, paths };
}

describe('the MCP App server', () => {
  it('answers initialize with tools and resources', () => {
    const { call } = setup();
    const reply = call('initialize', { protocolVersion: '2025-06-18' }) as { result: Record<string, unknown> };
    expect(reply.result.protocolVersion).toBe('2025-06-18');
    expect(reply.result.capabilities).toMatchObject({ tools: {}, resources: {} });
    expect(reply.result.serverInfo).toMatchObject({ name: 'draft-canvas' });
  });

  it('advertises the panel tool with its UI resource', () => {
    const { call } = setup();
    const reply = call('tools/list') as { result: { tools: { name: string; _meta?: { ui?: { resourceUri?: string } } }[] } };
    const open = reply.result.tools.find((tool) => tool.name === 'draft_canvas_open');
    expect(open?._meta?.ui?.resourceUri).toBe(UI_URI);
    expect(reply.result.tools.map((tool) => tool.name)).toContain('draft_canvas_queue');
  });

  it('returns the panel from tools/call, with a snapshot the widget can start from', () => {
    const { call } = setup();
    const reply = call('tools/call', { name: 'draft_canvas_open', arguments: {} }) as {
      result: { _meta: { ui: { resourceUri: string } }; structuredContent: { protocol: string; sessions: unknown[] } };
    };
    expect(reply.result._meta.ui.resourceUri).toBe(UI_URI);
    expect(reply.result.structuredContent.protocol).toBe('1');
    expect(reply.result.structuredContent.sessions.length).toBeGreaterThan(0);
  });

  it('serves the panel HTML as an MCP App resource', () => {
    const { call } = setup();
    const reply = call('resources/read', { uri: UI_URI }) as {
      result: { contents: { mimeType: string; text: string; _meta: { ui: { csp: unknown } } }[] };
    };
    const content = reply.result.contents[0];
    expect(content?.mimeType).toBe(UI_MIME);
    expect(content?.text).toBe(PANEL);
    expect(content?._meta.ui.csp).toBeDefined();
  });

  it('serves state and per-session history, including published drafts', () => {
    const { call } = setup();
    const state = call('resources/read', { uri: STATE_URI }) as { result: { contents: { text: string }[] } };
    const parsedState = JSON.parse(state.result.contents[0]?.text ?? '{}') as { activeSessionId: string; liveUpdates: boolean };
    expect(parsedState.activeSessionId).toBe('sess-1');
    // An MCP App has no push channel, and the panel says so instead of waiting for pushes.
    expect(parsedState.liveUpdates).toBe(false);

    const history = call('resources/read', { uri: `${HISTORY_PREFIX}${encodeURIComponent('sess-1')}` }) as {
      result: { contents: { text: string }[] };
    };
    const parsedHistory = JSON.parse(history.result.contents[0]?.text ?? '{}') as { messages: { role: string; text: string }[] };
    expect(parsedHistory.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(parsedHistory.messages[1]?.text).toContain('```draft id="note"');
    expect(parsedHistory.messages[1]?.text).toContain('第一版');
  });

  it('queues a fallback delivery', () => {
    const { call, service } = setup();
    const reply = call('tools/call', {
      name: 'draft_canvas_queue',
      arguments: { session_id: 'sess-1', text: '```draft-changelog id="note" from="1" to="2"\n…\n```' },
    }) as { result: { structuredContent: { pending: number } } };
    expect(reply.result.structuredContent.pending).toBe(1);
    expect(service.pending.read('sess-1')).toHaveLength(1);
  });

  it('rejects unknown tools, resources and methods', () => {
    const { call } = setup();
    expect(call('tools/call', { name: 'nope', arguments: {} })).toMatchObject({ error: { code: -32602 } });
    expect(call('resources/read', { uri: 'ui://other/thing' })).toMatchObject({ error: { code: -32602 } });
    expect(call('nope/nope')).toMatchObject({ error: { code: -32601 } });
  });

  it('stays silent on notifications', () => {
    const { service } = setup();
    const reply = handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, { service, panelHtml: () => '' });
    expect(reply).toBeUndefined();
  });
});

describe('publishing through the tool', () => {
  it('writes the draft and reports a new version', () => {
    const { call } = setup();
    const reply = call('tools/call', {
      name: 'draft_canvas_publish',
      arguments: { id: 'note', title: '新标题', body: '# 游记\n\n第二版\n' },
    }) as {
      result: { structuredContent: { versions: number; draftId: string; sessionId: string }; _meta: { ui: { resourceUri: string } } };
    };
    expect(reply.result.structuredContent.draftId).toBe('note');
    // one version seeded in setup(), plus this one
    expect(reply.result.structuredContent.versions).toBe(2);
    expect(reply.result._meta.ui.resourceUri).toBe(UI_URI);

    const history = call('resources/read', { uri: `${HISTORY_PREFIX}${encodeURIComponent('sess-1')}` }) as {
      result: { contents: { text: string }[] };
    };
    const parsed = JSON.parse(history.result.contents[0]?.text ?? '{}') as { messages: { role: string; text: string }[] };
    const last = parsed.messages.at(-1);
    expect(last?.role).toBe('assistant');
    expect(last?.text).toContain('第二版');
    expect(last?.text).toContain('title="新标题"');
  });

  it('rejects a publish without a body', () => {
    const { call } = setup();
    expect(call('tools/call', { name: 'draft_canvas_publish', arguments: { id: 'note', body: '  ' } })).toMatchObject({
      error: { code: -32602 },
    });
  });
});
