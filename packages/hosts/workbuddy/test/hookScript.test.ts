import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PendingQueue } from '../src/server/pending';
import { tempDir } from './helpers';

const HOOK = fileURLToPath(new URL('../hooks/draft-canvas-hook.mjs', import.meta.url));

function run(payload: unknown, stateDir: string): { stdout: string; status: number | null } {
  const result = spawnSync(process.execPath, [HOOK], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, DRAFT_CANVAS_STATE: stateDir },
  });
  return { stdout: result.stdout ?? '', status: result.status };
}

const CHANGELOG = '```draft-changelog id="note" from="1" to="2"\n*** Begin Patch\n<<<<<<< SEARCH\n甲\n=======\n乙\n>>>>>>> REPLACE\n*** End Patch\n```';

describe('the hook script', () => {
  it('prints queued changes as additionalContext and consumes them', () => {
    const stateDir = tempDir();
    mkdirSync(join(stateDir, 'pending'), { recursive: true });
    const queue = new PendingQueue(join(stateDir, 'pending'));
    queue.queue('sess-1', CHANGELOG);

    const { stdout, status } = run({ session_id: 'sess-1', hook_event_name: 'UserPromptSubmit', prompt: '按修改更新' }, stateDir);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('draft-changelog id="note"');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('draft-rewrite');
    expect(queue.read('sess-1')).toEqual([]);
  });

  it('prints nothing when nothing is queued', () => {
    const stateDir = tempDir();
    const { stdout, status } = run({ session_id: 'sess-1', hook_event_name: 'UserPromptSubmit', prompt: '你好' }, stateDir);
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('never delivers another chat’s queue', () => {
    const stateDir = tempDir();
    mkdirSync(join(stateDir, 'pending'), { recursive: true });
    const queue = new PendingQueue(join(stateDir, 'pending'));
    queue.queue('sess-1', CHANGELOG);
    const { stdout } = run({ session_id: 'sess-2', hook_event_name: 'UserPromptSubmit', prompt: '你好' }, stateDir);
    expect(stdout.trim()).toBe('');
    expect(queue.read('sess-1')).toHaveLength(1);
  });

  it('stays quiet for Stop and survives bad input', () => {
    const stateDir = tempDir();
    expect(run({ session_id: 'sess-1', hook_event_name: 'Stop' }, stateDir)).toMatchObject({ stdout: '', status: 0 });
    expect(run('{not json', stateDir)).toMatchObject({ stdout: '', status: 0 });
    expect(run({ hook_event_name: 'Stop' }, stateDir)).toMatchObject({ stdout: '', status: 0 });
  });

  it('reports the event to a running hub', () => {
    const stateDir = tempDir();
    // No hub is listening on this port: the hook must swallow the failure.
    writeFileSync(join(stateDir, 'hub.json'), JSON.stringify({ port: 1, pid: 0 }), 'utf8');
    expect(run({ session_id: 'sess-1', hook_event_name: 'Stop' }, stateDir).status).toBe(0);
    expect(existsSync(join(stateDir, 'pending'))).toBe(false);
    expect(readFileSync(join(stateDir, 'hub.json'), 'utf8')).toContain('"port":1');
  });
});
