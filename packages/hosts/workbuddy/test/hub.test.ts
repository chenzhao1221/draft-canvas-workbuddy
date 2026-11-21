import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rebuild } from '@draft-canvas/core';
import { Hub } from '../src/server/hub';
import type { HostPaths } from '../src/server/paths';
import { SessionRegistry } from '../src/server/sessions';
import { createDemo } from '../src/server/simulate';
import { assistant, DRAFT_V1, tempDir, user, writeTranscript } from './helpers';

function pathsIn(dir: string): HostPaths {
  const home = join(dir, 'home');
  mkdirSync(join(home, 'projects'), { recursive: true });
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

const open: Hub[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()?.stop();
});

async function startHub(paths: HostPaths, demo?: ReturnType<typeof createDemo>): Promise<{ hub: Hub; base: string }> {
  const hub = new Hub({
    paths,
    panelDir: '',
    pollIntervalMs: 100,
    ...(demo !== undefined ? { demo: demo.agent } : {}),
  });
  open.push(hub);
  const port = await hub.start(0);
  return { hub, base: `http://127.0.0.1:${port}` };
}

function call(base: string, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers: { 'x-draft-canvas-request': '1', ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...init.headers },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

async function waitFor<T>(check: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() - started > timeoutMs) throw new Error('timed out');
    await new Promise((done) => setTimeout(done, 100));
  }
}

describe('Hub', () => {
  it('serves health and info without any host running', async () => {
    const { base } = await startHub(pathsIn(tempDir()));
    expect(await (await fetch(`${base}/api/health`)).json()).toMatchObject({ ok: true });
    const info = (await (await call(base, '/api/info')).json()) as Record<string, unknown>;
    expect(info.protocol).toBe('1');
    expect(info.liveUpdates).toBe(false); // hooks are not installed in this temp home
  });

  it('refuses a write without the request header', async () => {
    const { base } = await startHub(pathsIn(tempDir()));
    const response = await fetch(`${base}/api/sessions/s1/inject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x' }),
    });
    expect(response.status).toBe(403);
  });

  it('learns a session from a hook and reads its transcript', async () => {
    const dir = tempDir();
    const paths = pathsIn(dir);
    const transcript = join(paths.transcriptsRoot, 'ws', 'sess-9.jsonl');
    mkdirSync(join(paths.transcriptsRoot, 'ws'), { recursive: true });
    writeTranscript(transcript, [user('写一份草稿', 'u1'), assistant(`好\n\n${DRAFT_V1}`, 'a1')]);
    const { base } = await startHub(paths);

    const hook = await call(base, '/api/hook', {
      method: 'POST',
      body: { session_id: 'sess-9', transcript_path: transcript, hook_event_name: 'UserPromptSubmit', prompt: '写一份草稿' },
    });
    expect(hook.status).toBe(200);

    const info = (await (await call(base, '/api/info')).json()) as { activeSessionId: string; sessions: { sessionId: string }[] };
    expect(info.activeSessionId).toBe('sess-9');
    expect(info.sessions.map((session) => session.sessionId)).toContain('sess-9');

    const history = (await (await call(base, '/api/sessions/sess-9/history')).json()) as { messages: unknown[]; completeness: string };
    expect(history.completeness).toBe('full');
    expect(rebuild(history.messages as never).store.versions.get('note')).toHaveLength(1);
  });

  it('queues an injected message and reports it as pending', async () => {
    const { base } = await startHub(pathsIn(tempDir()));
    const result = (await (await call(base, '/api/sessions/sess-1/inject', { method: 'POST', body: { text: '```draft-changelog id="note" from="1" to="2"\n*** Begin Patch\n*** End Patch\n```' } })).json()) as { ok: boolean; pending: number; note: string };
    expect(result.ok).toBe(true);
    expect(result.pending).toBe(1);
    expect(result.note).toMatch(/next message/);
    const info = (await (await call(base, '/api/info')).json()) as { pending: { sessionId: string; count: number }[] };
    expect(info.pending).toEqual([expect.objectContaining({ sessionId: 'sess-1', count: 1 })]);
    const diagnostics = await (await call(base, '/api/diagnostics')).text();
    expect(diagnostics).toContain('pending: sess-1=1');
  });

  it('pushes a hello frame on the event stream', async () => {
    const { base } = await startHub(pathsIn(tempDir()));
    const controller = new AbortController();
    const response = await fetch(`${base}/api/events`, { signal: controller.signal });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body?.getReader();
    const { value } = (await reader?.read()) ?? { value: undefined };
    controller.abort();
    const text = value === undefined ? '' : Buffer.from(value).toString('utf8');
    expect(text).toContain('retry: 2000');
    const frames = text.split('\n\n').filter((frame) => frame.startsWith('data: '));
    const hello = JSON.parse((frames[0] ?? '').replace('data: ', '')) as { type: string; info: { protocol: string } };
    expect(hello.type).toBe('hello');
    expect(hello.info.protocol).toBe('1');
  });

  it('runs the demo host end to end: draft, edit, new version', async () => {
    const dir = tempDir();
    const paths = pathsIn(dir);
    const demo = createDemo({ dir: join(paths.stateDir, 'demo'), draftsDir: join(paths.stateDir, 'drafts') });
    demo.seed();
    const registry = new SessionRegistry(paths.sessionsFile, paths.transcriptsRoot);
    registry.load();
    registry.upsert({ sessionId: demo.sessionId, transcriptPath: demo.transcriptPath, title: '演示' });
    registry.setActive(demo.sessionId);
    registry.save();

    const { base } = await startHub(paths, demo);
    const first = (await (await call(base, `/api/sessions/${demo.sessionId}/history`)).json()) as { messages: { id: string }[] };
    expect(rebuild(first.messages as never).store.versions.get('trip-note')).toHaveLength(1);

    await call(base, `/api/sessions/${demo.sessionId}/inject`, {
      method: 'POST',
      body: { text: '```draft-changelog id="trip-note" from="1" to="2"\n*** Begin Patch\n<<<<<<< SEARCH\n我们明天一早出发，去海边住两晚。\n=======\n我们周六一早出发，去海边住两晚。\n>>>>>>> REPLACE\n*** End Patch\n```' },
    });
    await call(base, '/api/hook', {
      method: 'POST',
      body: { session_id: demo.sessionId, transcript_path: demo.transcriptPath, hook_event_name: 'UserPromptSubmit', prompt: '按我的改动更新' },
    });

    const versions = await waitFor(async () => {
      const body = (await (await call(base, `/api/sessions/${demo.sessionId}/history`)).json()) as { messages: never[] };
      const found = rebuild(body.messages).store.versions.get('trip-note') ?? [];
      return found.length >= 2 ? found : undefined;
    });
    expect(versions[1]?.body).toContain('我们周六一早出发');
  });
});
