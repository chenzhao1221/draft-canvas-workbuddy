import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureDir } from './paths';

/**
 * Registers the Draft Canvas hook in `settings.json` (ADAPTER_INTERFACE section 8, WorkBuddy host).
 *
 * Four events, all pointing at the same script:
 *
 * | event | why |
 * |---|---|
 * | `UserPromptSubmit` | deliver queued edits into the turn, and learn `session_id` + `transcript_path` |
 * | `Stop` | the agent finished a reply: the hub re-reads the transcript at once instead of waiting for its timer |
 * | `SessionStart` | learn a new session before the user's first message |
 * | `SessionEnd` | the chat closed: the panel marks its session as idle |
 *
 * The merge is additive and idempotent, keeps every other hook, writes a backup next to the file on
 * the first change, and never runs a command that is not already there.
 */
export const HOOK_SCRIPT_NAME = 'draft-canvas-hook.mjs';

export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

interface HookCommand {
  type?: string;
  command?: string;
  timeout?: number;
}
interface HookMatcher {
  matcher?: string;
  hooks?: HookCommand[];
}

type Settings = Record<string, unknown> & { hooks?: Record<string, HookMatcher[]> };

export interface HookInstallResult {
  settingsPath: string;
  changed: boolean;
  /** Path of the backup written before the first change, if any. */
  backup?: string;
  /** Events that now carry the Draft Canvas hook. */
  events: string[];
}

/** `node "C:/…/draft-canvas-hook.mjs"`: Git Bash on Windows accepts forward slashes and quoted spaces. */
export function hookCommand(scriptPath: string): string {
  return `node "${scriptPath.replace(/\\/g, '/')}"`;
}

export function isDraftCanvasCommand(command: unknown): boolean {
  return typeof command === 'string' && command.includes(HOOK_SCRIPT_NAME);
}

function readSettings(settingsPath: string): Settings {
  if (!existsSync(settingsPath)) return {};
  let raw = readFileSync(settingsPath, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // PowerShell and Notepad add a BOM
  if (raw.trim() === '') return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${settingsPath} does not contain a JSON object`);
  }
  return parsed as Settings;
}

function writeSettings(settingsPath: string, settings: Settings): void {
  ensureDir(dirname(settingsPath));
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function eventsWithHook(settings: Settings): string[] {
  const hooks = settings.hooks;
  if (hooks === undefined) return [];
  const out: string[] = [];
  for (const [event, matchers] of Object.entries(hooks)) {
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      if (Array.isArray(matcher?.hooks) && matcher.hooks.some((hook) => isDraftCanvasCommand(hook?.command))) {
        out.push(event);
        break;
      }
    }
  }
  return out;
}

/** True when every event the panel relies on is registered. */
export function hooksInstalled(settingsPath: string): boolean {
  try {
    const found = new Set(eventsWithHook(readSettings(settingsPath)));
    return HOOK_EVENTS.every((event) => found.has(event));
  } catch {
    return false;
  }
}

export function installHooks(settingsPath: string, scriptPath: string): HookInstallResult {
  const settings = readSettings(settingsPath);
  const before = new Set(eventsWithHook(settings));
  let changed = false;
  const hooks = settings.hooks ?? {};
  for (const event of HOOK_EVENTS) {
    if (before.has(event)) continue;
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    existing.push({ hooks: [{ type: 'command', command: hookCommand(scriptPath), timeout: 5 }] });
    hooks[event] = existing;
    changed = true;
  }
  let backup: string | undefined;
  if (changed) {
    if (existsSync(settingsPath)) {
      backup = join(dirname(settingsPath), `${HOOK_SCRIPT_NAME}.settings-backup.json`);
      if (!existsSync(backup)) copyFileSync(settingsPath, backup);
    }
    settings.hooks = hooks;
    writeSettings(settingsPath, settings);
  }
  return {
    settingsPath,
    changed,
    ...(backup !== undefined ? { backup } : {}),
    events: eventsWithHook(readSettings(settingsPath)),
  };
}

export function uninstallHooks(settingsPath: string): HookInstallResult {
  const settings = readSettings(settingsPath);
  const hooks = settings.hooks;
  let changed = false;
  if (hooks !== undefined) {
    for (const [event, matchers] of Object.entries(hooks)) {
      if (!Array.isArray(matchers)) continue;
      const kept: HookMatcher[] = [];
      for (const matcher of matchers) {
        const entries = Array.isArray(matcher?.hooks) ? matcher.hooks.filter((hook) => !isDraftCanvasCommand(hook?.command)) : [];
        if (entries.length === 0) continue;
        kept.push({ ...matcher, hooks: entries });
      }
      if (kept.length === matchers.length) continue;
      changed = true;
      if (kept.length === 0) delete hooks[event];
      else hooks[event] = kept;
    }
    if (changed) {
      if (Object.keys(hooks).length === 0) delete settings.hooks;
      writeSettings(settingsPath, settings);
    }
  }
  return { settingsPath, changed, events: eventsWithHook(settings) };
}
