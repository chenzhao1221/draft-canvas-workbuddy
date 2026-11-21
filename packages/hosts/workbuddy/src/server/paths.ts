import { homedir } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Which host installation the hub watches. */
export type HostKind = 'workbuddy' | 'codebuddy';

export interface HostPaths {
  kind: HostKind;
  /** `~/.workbuddy` or `~/.codebuddy`. */
  home: string;
  /** `settings.json` the Draft Canvas hooks are merged into. */
  settingsPath: string;
  /** `<home>/draft-canvas`: everything this project writes. */
  stateDir: string;
  pendingDir: string;
  sessionsFile: string;
  /** Port and token of the running hub; the hook script reads it. */
  hubFile: string;
  /** `<home>/projects`: one folder per workspace, one JSONL per session. */
  transcriptsRoot: string;
}

function expandHome(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return join(homedir(), input.slice(2));
  return resolve(input);
}

/**
 * Resolves the paths both the hub and the hook script use. The hook (`hooks/draft-canvas-hook.mjs`)
 * re-implements the same three rules in plain JavaScript; keep the two in step:
 *
 * 1. `DRAFT_CANVAS_HOME` wins (points at the state folder itself, not at `~`),
 * 2. `DRAFT_CANVAS_HOST` picks `workbuddy` or `codebuddy`,
 * 3. otherwise the first of `~/.workbuddy`, `~/.codebuddy` that exists, `~/.workbuddy` if neither does.
 */
export function resolvePaths(options: { host?: HostKind | 'auto'; stateHome?: string } = {}): HostPaths {
  const explicitHome = options.stateHome ?? process.env.DRAFT_CANVAS_STATE;
  const envHost = process.env.DRAFT_CANVAS_HOST;
  const wanted = options.host ?? (envHost === 'codebuddy' || envHost === 'workbuddy' ? envHost : 'auto');

  const candidates: HostKind[] = wanted === 'auto' ? ['workbuddy', 'codebuddy'] : [wanted];
  let kind: HostKind = candidates[0] ?? 'workbuddy';
  let home = join(homedir(), `.${kind}`);
  if (wanted === 'auto') {
    const found = candidates.find((name) => existsSync(join(homedir(), `.${name}`)));
    kind = found ?? 'workbuddy';
    home = join(homedir(), `.${kind}`);
  }

  const stateDir = explicitHome !== undefined ? expandHome(explicitHome) : join(home, 'draft-canvas');
  return {
    kind,
    home,
    settingsPath: join(home, 'settings.json'),
    stateDir,
    pendingDir: join(stateDir, 'pending'),
    sessionsFile: join(stateDir, 'sessions.json'),
    hubFile: join(stateDir, 'hub.json'),
    transcriptsRoot: join(home, 'projects'),
  };
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

/** Both state folders, created on first use. */
export function ensureState(paths: HostPaths): void {
  ensureDir(paths.stateDir);
  ensureDir(paths.pendingDir);
}
