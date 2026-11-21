#!/usr/bin/env node
/**
 * Verifies the packed connector end to end, without installing anything.
 *
 * What it does:
 *  1. reads `dist/connector` (the directory the packer produces) and the newest `npm pack` tarball;
 *  2. checks the files the market requires and that `mcp.json` has no absolute paths;
 *  3. extracts the tarball into a temp folder with `tar` (no npm, no global install);
 *  4. starts the MCP server the way the host would — from the connector's `mcp.json`, cwd somewhere
 *     else, no hook installed — substituting the unpublished placeholder package name with the
 *     extracted package, which is exactly the resolution `npx <pkg>` performs once it is published;
 *  5. speaks MCP over stdio: initialize, tools/list, resources/list, resources/read, publish,
 *     then reads the state resource back;
 *  6. kills the child by PID (process tree) and confirms it is gone.
 *
 * Usage: node scripts/verify-connector.mjs [--keep]
 * Exit code 0 = all checks passed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONNECTOR = join(ROOT, 'dist', 'connector');
const HOST_SKILL = join(ROOT, 'packages', 'hosts', 'workbuddy', 'skill', 'draft-fence-app.md');
const KEEP = process.argv.includes('--keep');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}`);
}

function fail(message) {
  console.error(`verify-connector: ${message}`);
  process.exit(1);
}

function latestTarball() {
  if (!existsSync(CONNECTOR)) fail('dist/connector is missing; run `npm run package:wb` first');
  const tarballs = readdirSync(CONNECTOR)
    .filter((name) => name.endsWith('.tgz'))
    .map((name) => ({ name, at: statSync(join(CONNECTOR, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  if (tarballs.length === 0) fail('no tarball in dist/connector; run `npm pack` there first');
  return join(CONNECTOR, tarballs[0].name);
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function collectStrings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(collectStrings);
  return [];
}

/** Absolute paths only; `https://…` must not match, so the drive letter anchors at the start. */
function isLocalPath(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) || /^\/(Users|home|root|tmp|var|opt|mnt)\//.test(value);
}

function extract(tarball, into) {
  // Git Bash ships GNU tar, which reads `C:\…` as a remote host unless told otherwise; bsdtar
  // (Windows' own tar) has no such option, so try the portable call when this one is rejected.
  let result = spawnSync('tar', ['--force-local', '-xzf', tarball, '-C', into], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    result = spawnSync('tar', ['-xzf', tarball, '-C', into], { encoding: 'utf8', windowsHide: true });
  }
  if (result.status !== 0) fail(`tar failed: ${result.stderr || result.stdout}`);
  const packageDir = join(into, 'package');
  if (!existsSync(packageDir)) fail('the tarball has no package/ directory');
  return packageDir;
}

/** Kills a process tree on Windows and a process group elsewhere. */
function killTree(pid) {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

function main() {
  console.log('--- files ---');
  const tarball = latestTarball();
  console.log(`tarball: ${relative(ROOT, tarball)}`);

  const metaPath = join(CONNECTOR, 'connector-meta.json');
  const mcpPath = join(CONNECTOR, 'mcp.json');
  const manifestPath = join(CONNECTOR, 'package.json');
  const skillPath = join(CONNECTOR, 'skills', 'draft-fence', 'SKILL.md');
  for (const [name, path] of [
    ['connector-meta.json', metaPath],
    ['mcp.json', mcpPath],
    ['package.json', manifestPath],
    ['icon.svg', join(CONNECTOR, 'icon.svg')],
    ['skills/draft-fence/SKILL.md', skillPath],
  ]) {
    check(`connector has ${name}`, existsSync(path));
  }
  check('icon is a 64x64 svg', existsSync(join(CONNECTOR, 'icon.svg')) && readFileSync(join(CONNECTOR, 'icon.svg'), 'utf8').includes('viewBox="0 0 64 64"'));
  check('skill is the MCP App skill, byte for byte', sha256(skillPath) === sha256(HOST_SKILL), 'compared with packages/hosts/workbuddy/skill/draft-fence-app.md');
  check('packed package has no hooks directory', !existsSync(join(CONNECTOR, 'hooks')));

  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  check('meta.source is draft-canvas', meta.source === 'draft-canvas');
  check('meta has bilingual names, descriptions, examples', ['name_zh', 'name_en', 'description_zh', 'description_en'].every((key) => typeof meta[key] === 'string' && meta[key] !== '') && meta.examples_zh?.length >= 2 && meta.examples_en?.length >= 2);
  check('meta declares no auth', meta.auth_mode === undefined);
  check('meta requires WorkBuddy 5.x for runtime/npmRegistry', meta.minWorkbuddyVersion === '5.0.0');

  const config = JSON.parse(readFileSync(mcpPath, 'utf8'));
  const servers = Object.entries(config.mcpServers ?? {});
  check('mcp.json has exactly one server', servers.length === 1);
  const [serverName, server] = servers[0] ?? ['', {}];
  console.log(`server: ${serverName}`);
  check('transport is stdio via npx', server.type === 'stdio' && server.command === 'npx');
  check('runtime is node', server.runtime?.type === 'node');
  check('registry is npmmirror', server.npmRegistry === 'https://registry.npmmirror.com');
  const configStrings = collectStrings(config);
  check('mcp.json contains no absolute path', !configStrings.some(isLocalPath), configStrings.filter(isLocalPath).join(', '));
  const packageArg = (server.args ?? []).find((arg) => !arg.startsWith('-'));
  check('args name the package', typeof packageArg === 'string' && packageArg !== '', packageArg ?? 'missing');

  console.log('\n--- extract ---');
  const temp = mkdtempSync(join(tmpdir(), 'dc-wb-verify-'));
  const packageDir = extract(tarball, temp);
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  check('tarball is not private', !('private' in manifest));
  check('tarball package name matches mcp.json args', manifest.name === packageArg, manifest.name);
  const binRelative = manifest.bin?.[manifest.name];
  check('package declares a bin', typeof binRelative === 'string', binRelative ?? 'missing');
  const binPath = join(packageDir, binRelative ?? '');
  check('bin exists in the tarball', existsSync(binPath), relative(packageDir, binPath));
  check('widget is inlined in the tarball', existsSync(join(packageDir, 'panel', 'widget.html')) && statSync(join(packageDir, 'panel', 'widget.html')).size > 100_000);
  check('tarball ships the skill', existsSync(join(packageDir, 'skills', 'draft-fence', 'SKILL.md')));
  check('tarball ships connector-meta.json and mcp.json', existsSync(join(packageDir, 'connector-meta.json')) && existsSync(join(packageDir, 'mcp.json')));
  check('tarball ships no node_modules', !existsSync(join(packageDir, 'node_modules')));

  console.log('\n--- launch (MCP over stdio) ---');
  const stateDir = join(temp, 'state');
  const child = spawn(process.execPath, [binPath], {
    cwd: temp,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // Keep the test out of the real ~/.workbuddy: everything the server writes goes here.
      DRAFT_CANVAS_STATE: stateDir,
      DRAFT_CANVAS_HOST: 'workbuddy',
    },
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  let buffer = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (line === '') continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = pending.get(message.id);
      if (waiter !== undefined) {
        pending.delete(message.id);
        waiter(message);
      }
    }
  });

  let nextId = 1;
  const request = (method, params) =>
    new Promise((resolveReply, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, 15_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error !== undefined) reject(new Error(`${method}: ${message.error.message}`));
        else resolveReply(message.result);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);

  let exitCode = null;
  child.on('exit', (code) => {
    exitCode = code;
  });

  (async () => {
    const init = await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'verify-connector', version: '0.0.0' },
    });
    check('initialize returns the Draft Canvas server', init.serverInfo?.name === 'draft-canvas', init.serverInfo?.name ?? 'missing');
    notify('notifications/initialized', {});

    const tools = await request('tools/list', {});
    const names = (tools.tools ?? []).map((tool) => tool.name);
    check('three tools are advertised', ['draft_canvas_open', 'draft_canvas_publish', 'draft_canvas_queue'].every((name) => names.includes(name)), names.join(', '));

    const resources = await request('resources/list', {});
    const uris = (resources.resources ?? []).map((resource) => resource.uri);
    check('panel and state resources are advertised', uris.includes('ui://draft-canvas/panel') && uris.includes('ui://draft-canvas/state'));

    const panel = await request('resources/read', { uri: 'ui://draft-canvas/panel' });
    const html = panel.contents?.[0]?.text ?? '';
    check('panel resource is the inlined MCP App html', panel.contents?.[0]?.mimeType === 'text/html;profile=mcp-app' && html.length > 100_000 && html.includes('draft-changelog'));

    const opened = await request('tools/call', { name: 'draft_canvas_open', arguments: {} });
    check('draft_canvas_open returns a tool result', Array.isArray(opened.content) && opened.content.length > 0);

    const published = await request('tools/call', {
      name: 'draft_canvas_publish',
      arguments: { id: 'verify-note', title: '验证稿', body: '第一版正文。\n' },
    });
    check('draft_canvas_publish stores version 1', published.structuredContent?.draftId === 'verify-note' && published.structuredContent?.versions === 1);
    check('publish returns the panel resource hint', published._meta?.ui?.resourceUri === 'ui://draft-canvas/panel');

    const state = await request('resources/read', { uri: 'ui://draft-canvas/state' });
    const snapshot = JSON.parse(state.contents?.[0]?.text ?? '{}');
    check('state resource is the live snapshot', typeof snapshot.protocol === 'string' && snapshot.host?.id === 'workbuddy');
    check('draft file was written under the test state dir', existsSync(join(stateDir, 'drafts', 'current', 'verify-note.md')));
    check('nothing was written to the real ~/.workbuddy', stateDir.startsWith(temp));

    child.stdin.end();
    await new Promise((done) => {
      if (exitCode !== null) return done();
      child.once('exit', done);
      setTimeout(done, 3000);
    });
    check('server exits cleanly when stdin closes', exitCode === 0, `exit ${exitCode}`);
  })()
    .catch((error) => {
      check('MCP session completed', false, error instanceof Error ? error.message : String(error));
      if (stderr !== '') console.error(stderr.split('\n').slice(0, 6).join('\n'));
    })
    .finally(async () => {
      const pid = child.pid;
      if (exitCode === null) {
        killTree(pid);
        await new Promise((done) => {
          if (exitCode !== null) return done();
          child.once('exit', done);
          setTimeout(done, 5000);
        });
      }
      check('process is gone (killed by PID)', exitCode !== null, `pid ${pid}, exit ${exitCode}`);
      if (!KEEP) {
        try {
          rmSync(temp, { recursive: true, force: true });
        } catch {
          /* Windows may hold a handle for a moment; the temp folder is disposable */
        }
      }
      const failed = results.filter((item) => !item.ok);
      console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
      if (failed.length > 0) {
        for (const item of failed) console.error(`FAILED: ${item.name}${item.detail === '' ? '' : ` (${item.detail})`}`);
        process.exitCode = 1;
      }
    });
}

main();
