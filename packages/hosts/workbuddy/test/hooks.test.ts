import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOOK_EVENTS, hooksInstalled, installHooks, uninstallHooks } from '../src/server/hooks';
import { tempDir } from './helpers';

function settingsFile(content: unknown): string {
  const dir = tempDir();
  const path = join(dir, 'settings.json');
  writeFileSync(path, `${JSON.stringify(content, null, 2)}\n`, 'utf8');
  return path;
}

const SCRIPT = 'C:/tools/dist/workbuddy/hooks/draft-canvas-hook.mjs';

describe('hook installation', () => {
  it('adds the four events and changes nothing twice', () => {
    const path = settingsFile({ theme: 'dark' });
    const first = installHooks(path, SCRIPT);
    expect(first.changed).toBe(true);
    expect(first.events.sort()).toEqual([...HOOK_EVENTS].sort());
    expect(hooksInstalled(path)).toBe(true);

    const second = installHooks(path, SCRIPT);
    expect(second.changed).toBe(false);

    const settings = JSON.parse(readFileSync(path, 'utf8'));
    expect(settings.theme).toBe('dark');
    const userPromptHooks = settings.hooks.UserPromptSubmit;
    expect(userPromptHooks).toHaveLength(1);
    expect(userPromptHooks[0].hooks[0].command).toBe(`node "${SCRIPT}"`);
    expect(userPromptHooks[0].hooks[0].timeout).toBe(5);
  });

  it('keeps hooks that were already there', () => {
    const path = settingsFile({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'python3 /other/check.py', timeout: 10 }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }],
      },
    });
    installHooks(path, SCRIPT);
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    expect(settings.hooks.UserPromptSubmit).toHaveLength(2);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe('echo hi');
  });

  it('writes a backup before the first change', () => {
    const path = settingsFile({ theme: 'light' });
    const result = installHooks(path, SCRIPT);
    expect(result.backup).toBeDefined();
    const backup = JSON.parse(readFileSync(result.backup ?? '', 'utf8'));
    expect(backup.theme).toBe('light');
  });

  it('tolerates a settings file with a BOM and no trailing newline', () => {
    const path = settingsFile({});
    writeFileSync(path, `\uFEFF${JSON.stringify({ theme: 'dark' })}`, 'utf8');
    const result = installHooks(path, SCRIPT);
    expect(result.changed).toBe(true);
    const text = readFileSync(path, 'utf8');
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
    expect(JSON.parse(text).hooks).toBeDefined();
  });

  it('removes only its own hooks, and only the events it emptied', () => {
    const path = settingsFile({});
    installHooks(path, SCRIPT);
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    settings.hooks.UserPromptSubmit.push({ hooks: [{ type: 'command', command: 'echo kept' }] });
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');

    const result = uninstallHooks(path);
    expect(result.changed).toBe(true);
    expect(hooksInstalled(path)).toBe(false);
    const after = JSON.parse(readFileSync(path, 'utf8'));
    expect(after.hooks.UserPromptSubmit).toEqual([{ hooks: [{ type: 'command', command: 'echo kept' }] }]);
    expect(after.hooks.Stop).toBeUndefined();
  });

  it('reports hooks as missing when the file cannot be parsed', () => {
    const path = settingsFile({});
    writeFileSync(path, '{not json', 'utf8');
    expect(hooksInstalled(path)).toBe(false);
  });
});
