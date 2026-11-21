import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTER_VERSION } from '../protocol';
import { Hub } from './hub';
import { HOOK_SCRIPT_NAME, hooksInstalled, installHooks, uninstallHooks } from './hooks';
import { ensureDir, resolvePaths, type HostKind, type HostPaths } from './paths';
import { PendingQueue } from './pending';
import { SessionRegistry } from './sessions';
import { createDemo } from './simulate';
import { inspectRecords, parseTranscript } from './transcript';

/**
 * `draft-canvas-wb` — the WorkBuddy host's command line.
 *
 *   start      serve the panel and watch the transcripts
 *   simulate   same, with a fake host writing drafts (no WorkBuddy needed)
 *   install    register the UserPromptSubmit/Stop hooks and install the skill
 *   uninstall  remove them again
 *   status     what the hub would see right now
 *   doctor     check a real transcript can be read, and show what the parser saw
 */

interface Args {
  command: string;
  port?: number;
  host?: HostKind | 'auto';
  state?: string;
  open: boolean;
  demo: boolean;
  /** `doctor --probe <text>`: which record paths contain this text (no content is printed). */
  probe?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: argv[0] ?? 'start', open: false, demo: false };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    switch (arg) {
      case '--port':
        args.port = Number(argv[++i]);
        break;
      case '--host': {
        const value = argv[++i];
        args.host = value === 'workbuddy' || value === 'codebuddy' ? value : 'auto';
        break;
      }
      case '--state':
        args.state = argv[++i];
        break;
      case '--open':
        args.open = true;
        break;
      case '--demo':
        args.demo = true;
        break;
      case '--probe':
        args.probe = argv[++i];
        break;
      case '-h':
      case '--help':
        args.command = 'help';
        break;
      default:
        break;
    }
  }
  return args;
}

/** `<dist>/bin/draft-canvas-wb.mjs` → `<dist>/workbuddy`. */
function packageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..');
}

function pathsFor(args: Args): HostPaths {
  return resolvePaths({
    ...(args.host !== undefined ? { host: args.host } : {}),
    ...(args.state !== undefined ? { stateHome: args.state } : {}),
  });
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const child =
    platform === 'win32'
      ? spawn(process.env.COMSPEC ?? 'cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' })
      : platform === 'darwin'
        ? spawn('open', [url], { detached: true, stdio: 'ignore' })
        : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
  child.on('error', () => undefined);
  child.unref();
}

async function serve(args: Args, demo: boolean): Promise<void> {
  const paths = pathsFor(args);
  ensureDir(paths.stateDir);
  const root = packageRoot();
  const panelDir = process.env.DRAFT_CANVAS_PANEL_DIR ?? join(root, 'panel');
  const demoAgent = demo
    ? createDemo({ dir: join(paths.stateDir, 'demo'), draftsDir: join(paths.stateDir, 'drafts'), log: () => undefined })
    : undefined;
  if (demoAgent !== undefined) {
    demoAgent.seed();
    const registry = new SessionRegistry(paths.sessionsFile, paths.transcriptsRoot);
    registry.load();
    registry.upsert({
      sessionId: demoAgent.sessionId,
      transcriptPath: demoAgent.transcriptPath,
      title: '模拟会话：出行草稿',
      source: 'user',
    });
    registry.setActive(demoAgent.sessionId);
    registry.save();
  }
  const hub = new Hub({
    paths,
    panelDir: existsSync(panelDir) ? panelDir : '',
    ...(demoAgent !== undefined ? { demo: demoAgent.agent } : {}),
    log: (line) => console.log(`  ${line}`),
  });
  const port = await hub.start(args.port);
  console.log('');
  console.log(`Draft Canvas ${ADAPTER_VERSION} for WorkBuddy${demo ? ' (simulate)' : ''}`);
  console.log(`  panel   ${hub.url}`);
  console.log(`  host    ${paths.home}${existsSync(paths.home) ? '' : '  (not found — use --host codebuddy?)'}`);
  console.log(`  hooks   ${hooksInstalled(paths.settingsPath) ? 'installed' : `not installed — run: draft-canvas-wb install`}`);
  console.log(`  data    ${paths.stateDir}`);
  console.log(`  drafts  ${join(paths.stateDir, 'drafts', 'current')}`);
  console.log('');
  console.log('Leave this window open while you use the panel. Ctrl+C stops the hub.');
  if (args.open) openBrowser(hub.url);
  await new Promise<void>((done) => {
    const finish = (): void => {
      void hub.stop().then(() => done());
    };
    process.on('SIGINT', finish);
    process.on('SIGTERM', finish);
  });
  console.log(`hub on ${hub.url} stopped`);
}

function install(args: Args): void {
  const paths = pathsFor(args);
  const root = packageRoot();
  const hookPath = join(root, 'hooks', HOOK_SCRIPT_NAME);
  if (!existsSync(hookPath)) {
    console.error(`install: ${hookPath} is missing. Run this command from the packaged folder (dist/workbuddy).`);
    process.exitCode = 1;
    return;
  }
  const result = installHooks(paths.settingsPath, hookPath);
  console.log(`settings ${result.settingsPath}`);
  console.log(`hooks    ${result.events.join(', ') || '(none)'}`);
  console.log(`command  ${hookPath}`);
  if (result.changed) {
    console.log(result.backup === undefined ? 'updated.' : `updated. Backup of the previous file: ${result.backup}`);
    console.log('Restart WorkBuddy (or open a new chat) so the new hooks are picked up.');
  } else {
    console.log('already installed, nothing changed.');
  }
  writeSkill(paths, 'draft-fence.md', { draftsDir: join(paths.stateDir, 'drafts', 'current') });
}

/**
 * Installs one skill variant. The hub version tells the agent to write the draft file itself; the MCP
 * version tells it to call `draft_canvas_publish`, and the server writes the file. Two different
 * instructions, so two files.
 */
function writeSkill(paths: HostPaths, fileName: string, vars: { draftsDir?: string }): void {
  const source = join(packageRoot(), 'skill', fileName);
  const target = join(paths.home, 'skills', 'draft-fence', 'SKILL.md');
  if (!existsSync(source)) {
    console.error(`skill: ${source} is missing`);
    return;
  }
  ensureDir(dirname(target));
  const body = readFileSync(source, 'utf8');
  const front =
    '---\nname: draft-fence\ndescription: 写会反复修改的稿子时，用 draft 块或 Draft Canvas 面板存稿。用户要写稿、改稿，或提到 Draft Canvas 时使用。\n---\n\n';
  const withoutFront = body.replace(/^---\n[\s\S]*?\n---\n+/, '');
  const filled = vars.draftsDir === undefined ? withoutFront : withoutFront.replaceAll('{{DRAFTS_DIR}}', vars.draftsDir);
  writeFileSync(target, `${front}${filled}`, 'utf8');
  console.log(`skill    ${target}`);
  if (vars.draftsDir !== undefined) console.log(`drafts   ${vars.draftsDir}  (the skill tells the agent to write drafts here)`);
}

function uninstall(args: Args): void {
  const paths = pathsFor(args);
  const result = uninstallHooks(paths.settingsPath);
  console.log(`settings ${result.settingsPath}`);
  console.log(result.changed ? 'hooks removed.' : 'no Draft Canvas hook found.');
  console.log(`skill    left in place: ${join(paths.home, 'skills', 'draft-fence', 'SKILL.md')}`);
}

/**
 * Registers the MCP App server in `<home>/mcp.json`. That is how the panel gets *inside* WorkBuddy:
 * the desktop renders `_meta.ui.resourceUri` widgets in the conversation, and the widget can post a
 * real user message. No local hub, no browser tab.
 */
function mcpInstall(args: Args): void {
  const paths = pathsFor(args);
  const serverPath = join(packageRoot(), 'mcp', 'server.mjs');
  if (!existsSync(serverPath)) {
    console.error(`mcp-install: ${serverPath} is missing. Run this from the packaged folder (dist/workbuddy).`);
    process.exitCode = 1;
    return;
  }
  const configPath = join(paths.home, 'mcp.json');
  const backup = join(paths.home, 'mcp.json.draft-canvas.bak.json');
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    let raw = readFileSync(configPath, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    if (raw.trim() !== '') {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) config = parsed as Record<string, unknown>;
      } catch {
        console.error(`mcp-install: ${configPath} is not valid JSON; fix it first (nothing was changed).`);
        process.exitCode = 1;
        return;
      }
    }
    if (!existsSync(backup)) copyFileSync(configPath, backup);
  }
  const servers = typeof config.mcpServers === 'object' && config.mcpServers !== null ? (config.mcpServers as Record<string, unknown>) : {};
  servers['draft-canvas'] = { command: process.execPath, args: [serverPath] };
  config.mcpServers = servers;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}
`, 'utf8');
  console.log(`mcp.json   ${configPath}`);
  console.log(`server     ${serverPath}`);
  console.log(`backup     ${existsSync(backup) ? backup : '(no previous file)'}`);
  writeSkill(paths, 'draft-fence-app.md', {});
  console.log('');
  console.log('Next:');
  console.log('  1. restart WorkBuddy so it picks up the new MCP server;');
  console.log('  2. open the connector/plugin page and Trust "draft-canvas" (self-added MCP servers start untrusted);');
  console.log('  3. in a chat, ask for a draft and say "打开草稿面板" — the panel renders inside the conversation.');
}

function mcpUninstall(args: Args): void {
  const paths = pathsFor(args);
  const configPath = join(paths.home, 'mcp.json');
  if (!existsSync(configPath)) {
    console.log('mcp-uninstall: no mcp.json');
    return;
  }
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8').replace(/^﻿/, '')) as Record<string, unknown>;
  } catch {
    console.error('mcp-uninstall: mcp.json is not valid JSON; nothing was changed.');
    process.exitCode = 1;
    return;
  }
  const servers = config.mcpServers;
  if (typeof servers !== 'object' || servers === null || !('draft-canvas' in servers)) {
    console.log('mcp-uninstall: draft-canvas is not registered');
    return;
  }
  delete (servers as Record<string, unknown>)['draft-canvas'];
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}
`, 'utf8');
  console.log(`removed from ${configPath}. Restart WorkBuddy.`);
}

function status(args: Args): void {
  const paths = pathsFor(args);
  const registry = new SessionRegistry(paths.sessionsFile, paths.transcriptsRoot);
  registry.load();
  registry.scan();
  const pending = new PendingQueue(paths.pendingDir);
  console.log(`Draft Canvas ${ADAPTER_VERSION} for WorkBuddy`);
  console.log(`host      ${paths.kind}  (${paths.home})`);
  console.log(`settings  ${paths.settingsPath}`);
  console.log(`hooks     ${hooksInstalled(paths.settingsPath) ? 'installed' : 'not installed'}`);
  console.log(`data      ${paths.stateDir}`);
  console.log(`active    ${registry.activeSessionId ?? '-'}`);
  console.log('sessions:');
  for (const session of registry.list().slice(0, 12)) {
    console.log(`  ${session.sessionId.slice(0, 8)}  ${session.transcript ? 'transcript' : 'no transcript '}  ${session.title ?? ''}`);
  }
  const waiting = pending.summary();
  console.log(`pending   ${waiting.length === 0 ? 'none' : waiting.map((p) => `${p.sessionId.slice(0, 8)}=${p.count}`).join(' ')}`);
}

function doctor(args: Args): void {
  const paths = pathsFor(args);
  console.log('Draft Canvas doctor');
  console.log(`  state      ${paths.stateDir}`);
  console.log(`  settings   ${paths.settingsPath} ${existsSync(paths.settingsPath) ? '' : '(missing)'}`);
  console.log(`  hooks      ${hooksInstalled(paths.settingsPath) ? 'installed' : 'not installed'}`);
  console.log(`  skill      ${join(paths.home, 'skills', 'draft-fence', 'SKILL.md')}`);
  console.log(`  drafts     ${join(paths.stateDir, 'drafts', 'current')}`);
  const registry = new SessionRegistry(paths.sessionsFile, paths.transcriptsRoot);
  registry.load();
  registry.scan();
  const sessions = registry.list();
  console.log(`  transcripts ${paths.transcriptsRoot} → ${sessions.length} session(s)`);
  const withFile = sessions.find((session) => session.transcript === true);
  if (withFile === undefined) {
    console.log('  no readable transcript found. Start a chat in WorkBuddy, then run this again.');
    return;
  }
  const path = registry.resolveTranscript(withFile.sessionId);
  if (path === undefined) return;
  console.log(`  sample     ${path} (${Math.round(statSync(path).size / 1024)} KiB)`);
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split('\n').slice(0, 20).filter((line) => line.trim() !== '');
  const keys = new Set<string>();
  for (const line of lines) {
    try {
      const entry: unknown = JSON.parse(line);
      if (typeof entry === 'object' && entry !== null) {
        for (const key of Object.keys(entry)) keys.add(key);
      }
    } catch {
      // unparsable line, the parser skips it too
    }
  }
  console.log(`  top keys   ${[...keys].join(', ') || '(none)'}`);
  const parsed = parseTranscript(raw, withFile.sessionId);
  console.log(`  parsed     ${parsed.usable}/${parsed.lines} lines, ${parsed.messages.length} messages, ${parsed.skipped} skipped`);
  console.log(`  shapes     ${parsed.shapes.join(', ') || '(none)'}`);
  console.log(`  roles      ${summarize(parsed.messages.map((message) => message.role))}`);
  console.log(`  complete   ${parsed.completeness}`);
  const drafts = parsed.messages.filter((message) => message.role === 'assistant' && message.text.includes('```draft')).length;
  console.log(`  draft msgs ${drafts}`);
  if (args.probe !== undefined && args.probe !== '') {
    console.log(`  probe      "${args.probe}" — where the text lives (paths only, no content):`);
    for (const line of probeTranscript(raw, args.probe)) console.log(`    ${line}`);
  }
  console.log('  record shapes (types and lengths only, never values):');
  for (const shape of inspectRecords(raw, withFile.sessionId)) {
    console.log(
      `    ${shape.type} ×${shape.count}  role=${shape.role ?? '-'}  blocks=${shape.blockTypes.join('|') || '-'}  textLen=${shape.textLength}  ${
        shape.mapped ? 'mapped' : 'SKIPPED'
      }`,
    );
    console.log(`      ${shape.detail.join('  ')}`);
  }
}

/**
 * Reports which JSON paths of a transcript contain `needle`, per record type. Used to find where the
 * host keeps the assistant's text; it prints paths and counts only, never the text around them.
 */
function probeTranscript(raw: string, needle: string): string[] {
  const counts = new Map<string, number>();
  for (const line of raw.split('\n')) {
    if (line.trim() === '' || !line.includes(needle)) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== 'object' || entry === null) continue;
    const type = typeof (entry as { type?: unknown }).type === 'string' ? String((entry as { type?: unknown }).type) : '?';
    for (const path of pathsContaining(entry, needle)) counts.set(`${type} ${path}`, (counts.get(`${type} ${path}`) ?? 0) + 1);
  }
  if (counts.size === 0) return ['not found anywhere in this file'];
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([key, n]) => `${key} ×${n}`);
}

function pathsContaining(value: unknown, needle: string, path = '', depth = 0): string[] {
  if (depth > 6) return [];
  if (typeof value === 'string') return value.includes(needle) ? [path || '(root)'] : [];
  if (Array.isArray(value)) {
    const out: string[] = [];
    value.forEach((item, index) => {
      out.push(...pathsContaining(item, needle, `${path}[${index}]`, depth + 1));
    });
    return out.slice(0, 3);
  }
  if (typeof value === 'object' && value !== null) {
    const out: string[] = [];
    for (const [key, inner] of Object.entries(value)) {
      out.push(...pathsContaining(inner, needle, path === '' ? key : `${path}.${key}`, depth + 1));
      if (out.length >= 3) break;
    }
    return out.slice(0, 3);
  }
  return [];
}

function summarize(values: string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].map(([role, n]) => `${role}=${n}`).join(' ') || '(none)';
}

function usage(): void {
  console.log(`draft-canvas-wb ${ADAPTER_VERSION}

  start       [--port N] [--open] [--host workbuddy|codebuddy] [--state DIR]
  simulate    [--port N] [--open]          fake host, writes drafts by itself
  install     register the hooks and install the skill
  uninstall   remove the hooks
  mcp-install register the MCP App server (panel inside the client)
  mcp-uninstall  remove it
  status      what the hub would see now
  doctor      check that a real transcript can be read

The panel lives at http://127.0.0.1:<port>/ while \`start\` runs.`);
}

const args = parseArgs(process.argv.slice(2));
switch (args.command) {
  case 'start':
    await serve(args, false);
    break;
  case 'simulate':
    await serve(args, true);
    break;
  case 'install':
    install(args);
    break;
  case 'mcp-install':
    mcpInstall(args);
    break;
  case 'mcp-uninstall':
    mcpUninstall(args);
    break;
  case 'uninstall':
    uninstall(args);
    break;
  case 'status':
    status(args);
    break;
  case 'doctor':
    doctor(args);
    break;
  case 'help':
    usage();
    break;
  default:
    console.error(`unknown command: ${args.command}`);
    usage();
    process.exitCode = 1;
}
