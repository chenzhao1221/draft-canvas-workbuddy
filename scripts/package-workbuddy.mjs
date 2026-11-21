#!/usr/bin/env node
/**
 * Builds the WorkBuddy host into `dist/workbuddy/`, ready to run:
 *
 *   dist/workbuddy/
 *     bin/draft-canvas-wb.mjs     the hub and its commands (one file, no dependencies)
 *     panel/index.html            the page the user opens
 *     panel/panel.js              the panel bundle (React, CodeMirror, core, ui)
 *     hooks/draft-canvas-hook.mjs the hook the settings file points at
 *     skill/draft-fence.md        the skill installed into ~/.workbuddy/skills
 *     package.json                name, version, bin
 *
 * Unlike the Crew build there is nothing to keep external: the panel runs in a plain browser, so
 * React and CodeMirror are bundled, and the hub uses only Node built-ins.
 */
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = join(ROOT, 'packages', 'hosts', 'workbuddy');
const OUT = join(ROOT, 'dist', 'workbuddy');
const VERSION = JSON.parse(readFileSync(join(HOST, 'package.json'), 'utf8')).version;

/** The connector (what a user installs from the WorkBuddy connector market) is built next to the host. */
const CONNECTOR_TEMPLATE = join(ROOT, 'connector');
const CONNECTOR_OUT = join(ROOT, 'dist', 'connector');
/**
 * Placeholder on purpose: publishing waits for the owner's decision on the npm name. Everything that
 * refers to the package (package.json `name`/`bin`, mcp.json `args`) is derived from this one
 * constant, so the rename is a one-line change plus a rebuild.
 */
const PACKAGE_NAME = 'draft-canvas-workbuddy-tbd';

function fail(message) {
  console.error(`package-workbuddy: ${message}`);
  process.exit(1);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function bytesLabel(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

/** Every string inside a JSON value, so path checks see values and not JSON punctuation. */
function collectStrings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(collectStrings);
  return [];
}

/** Absolute Windows/Unix paths. `https://…` is not one: the drive-letter form anchors at the start. */
function isLocalPath(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) || /^\/(Users|home|root|tmp|var|opt|mnt)\//.test(value);
}

/**
 * Builds the market connector: the directory a submission takes as-is.
 *
 *   dist/connector/
 *     connector-meta.json      market metadata (source, names, descriptions, examples)
 *     mcp.json                 stdio server launched with npx; no absolute paths anywhere
 *     icon.svg                 64x64 icon
 *     skills/draft-fence/SKILL.md  the MCP App skill, copied unchanged from the host
 *     mcp/server.mjs           the MCP server
 *     panel/widget.html        the inlined panel the server hands to the host
 *     bin/draft-canvas.mjs     the executable npx runs (imports the server's main)
 *     package.json             publishable manifest, no `private`
 */
function buildConnector() {
  rmSync(CONNECTOR_OUT, { recursive: true, force: true });
  for (const dir of ['bin', 'mcp', 'panel', join('skills', 'draft-fence')]) {
    mkdirSync(join(CONNECTOR_OUT, dir), { recursive: true });
  }

  cpSync(join(OUT, 'mcp', 'server.mjs'), join(CONNECTOR_OUT, 'mcp', 'server.mjs'));
  cpSync(join(OUT, 'panel', 'widget.html'), join(CONNECTOR_OUT, 'panel', 'widget.html'));
  // Same file the host installs into ~/.workbuddy/skills. Not rewritten: one skill, one source.
  cpSync(join(HOST, 'skill', 'draft-fence-app.md'), join(CONNECTOR_OUT, 'skills', 'draft-fence', 'SKILL.md'));
  for (const name of ['connector-meta.json', 'mcp.json', 'icon.svg', 'README.md']) {
    cpSync(join(CONNECTOR_TEMPLATE, name), join(CONNECTOR_OUT, name));
  }
  cpSync(join(ROOT, 'LICENSE'), join(CONNECTOR_OUT, 'LICENSE'));
  cpSync(join(ROOT, 'NOTICE'), join(CONNECTOR_OUT, 'NOTICE'));

  // `node mcp/server.mjs` runs on its own (see its argv guard); npx runs the bin, which calls main()
  // explicitly so the package keeps working no matter what path the launcher hands to Node.
  writeFileSync(
    join(CONNECTOR_OUT, 'bin', 'draft-canvas.mjs'),
    "#!/usr/bin/env node\nimport { main } from '../mcp/server.mjs';\n\nmain();\n",
    'utf8',
  );

  writeFileSync(
    join(CONNECTOR_OUT, 'package.json'),
    `${JSON.stringify(
      {
        name: PACKAGE_NAME,
        version: VERSION,
        description: 'Draft Canvas connector for WorkBuddy: an editable draft panel inside the conversation.',
        license: 'Apache-2.0',
        type: 'module',
        bin: { [PACKAGE_NAME]: './bin/draft-canvas.mjs' },
        files: [
          'bin',
          'mcp',
          'panel',
          'skills',
          'connector-meta.json',
          'mcp.json',
          'icon.svg',
          'README.md',
          'NOTICE',
          'LICENSE',
        ],
        engines: { node: '>=20' },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

/** Structural checks for the connector; a wrong field here only shows up at submission time otherwise. */
function checkConnector() {
  const problems = [];
  const meta = JSON.parse(readFileSync(join(CONNECTOR_OUT, 'connector-meta.json'), 'utf8'));
  for (const key of ['name', 'name_zh', 'name_en', 'description', 'description_zh', 'description_en', 'source', 'version']) {
    if (typeof meta[key] !== 'string' || meta[key] === '') problems.push(`connector-meta.json: missing ${key}`);
  }
  for (const key of ['examples_zh', 'examples_en']) {
    if (!Array.isArray(meta[key]) || meta[key].length < 2) problems.push(`connector-meta.json: ${key} needs 2+ examples`);
  }
  if (meta.type !== undefined && meta.type !== 'mcp') problems.push('connector-meta.json: type must be mcp');
  if (meta.source !== 'draft-canvas') problems.push('connector-meta.json: source must be draft-canvas');
  if (meta.auth_mode !== undefined) problems.push('connector-meta.json: auth_mode must be omitted (no auth)');

  const mcp = JSON.parse(readFileSync(join(CONNECTOR_OUT, 'mcp.json'), 'utf8'));
  const servers = Object.entries(mcp.mcpServers ?? {});
  if (servers.length !== 1) problems.push('mcp.json: exactly one server is allowed');
  for (const [name, server] of servers) {
    const localPaths = collectStrings(server).filter(isLocalPath);
    for (const value of localPaths) problems.push(`mcp.json: ${name} contains a local path: ${value}`);
    if (server.type !== 'stdio') problems.push(`mcp.json: ${name}.type must be stdio`);
    if (server.command !== 'npx') problems.push(`mcp.json: ${name}.command should be npx`);
    if (!Array.isArray(server.args) || !server.args.includes(PACKAGE_NAME)) {
      problems.push(`mcp.json: ${name}.args must launch ${PACKAGE_NAME}`);
    }
    if (server.runtime?.type !== 'node') problems.push(`mcp.json: ${name}.runtime.type must be node`);
    if (server.npmRegistry !== 'https://registry.npmmirror.com') problems.push(`mcp.json: ${name}.npmRegistry must be npmmirror`);
  }

  const manifest = JSON.parse(readFileSync(join(CONNECTOR_OUT, 'package.json'), 'utf8'));
  if ('private' in manifest) problems.push('package.json: private must be removed');
  if (manifest.name !== PACKAGE_NAME) problems.push('package.json: name must match mcp.json args');
  if (manifest.bin?.[PACKAGE_NAME] !== './bin/draft-canvas.mjs') problems.push('package.json: bin is not wired to the wrapper');

  const skill = join(CONNECTOR_OUT, 'skills', 'draft-fence', 'SKILL.md');
  if (!existsSync(skill)) problems.push('missing skills/draft-fence/SKILL.md');
  else {
    const text = readFileSync(skill, 'utf8');
    if (!text.startsWith('---\n') || !/^name:\s*draft-fence$/m.test(text) || !/^description:\s*\S/m.test(text)) {
      problems.push('skills/draft-fence/SKILL.md: front matter needs name and description');
    }
  }
  for (const file of ['icon.svg', 'bin/draft-canvas.mjs', 'mcp/server.mjs', 'panel/widget.html']) {
    if (!existsSync(join(CONNECTOR_OUT, ...file.split('/')))) problems.push(`missing ${file}`);
  }
  return problems;
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, 'bin'), { recursive: true });
  mkdirSync(join(OUT, 'panel'), { recursive: true });
  mkdirSync(join(OUT, 'hooks'), { recursive: true });
  mkdirSync(join(OUT, 'mcp'), { recursive: true });
  mkdirSync(join(OUT, 'skill'), { recursive: true });

  const alias = {
    '@draft-canvas/core': join(ROOT, 'packages', 'core', 'src', 'index.ts'),
    '@draft-canvas/ui': join(ROOT, 'packages', 'ui', 'src', 'index.ts'),
  };

  // 1. the hub + CLI
  await build({
    entryPoints: [join(HOST, 'src', 'server', 'main.ts')],
    outfile: join(OUT, 'bin', 'draft-canvas-wb.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    jsx: 'automatic',
    legalComments: 'none',
    minify: false,
    sourcemap: false,
    banner: { js: '#!/usr/bin/env node' },
    alias,
    logLevel: 'warning',
  });

  // 2. the panel page
  await build({
    entryPoints: [join(HOST, 'src', 'panel.tsx')],
    outfile: join(OUT, 'panel', 'panel.js'),
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    jsx: 'automatic',
    legalComments: 'none',
    minify: true,
    sourcemap: false,
    alias,
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
    metafile: true,
  });

  // 2b. the MCP App server (what WorkBuddy runs when the user opens the panel in-client)
  await build({
    entryPoints: [join(HOST, 'src', 'mcp', 'server.ts')],
    outfile: join(OUT, 'mcp', 'server.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    legalComments: 'none',
    minify: false,
    sourcemap: false,
    alias,
    logLevel: 'warning',
  });

  // 2c. the widget: one HTML file with the whole panel inlined, because the host injects the resource
  // text into a sandboxed iframe where relative script URLs do not resolve.
  const widget = await build({
    entryPoints: [join(HOST, 'src', 'mcpPanel.tsx')],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    jsx: 'automatic',
    legalComments: 'none',
    minify: true,
    sourcemap: false,
    alias,
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
  });
  const widgetCode = widget.outputFiles[0]?.text ?? '';
  if (widgetCode === '') fail('the widget bundle is empty');
  const widgetHtml = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Draft Canvas</title>
    <style>
      :root { color-scheme: light dark; }
      /* No height:100% anywhere: the host measures this document (max-content) to size the card, so
         a percentage height would report the current iframe height and the card could never shrink. */
      html, body { margin: 0; }
      body { background: light-dark(#faf8f5, #17161a); font-family: system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif; }
      #root { display: block; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script>${widgetCode}</script>
  </body>
</html>
`;
  writeFileSync(join(OUT, 'panel', 'widget.html'), widgetHtml, 'utf8');

  // 3. static files
  cpSync(join(HOST, 'panel', 'index.html'), join(OUT, 'panel', 'index.html'));
  cpSync(join(HOST, 'hooks', 'draft-canvas-hook.mjs'), join(OUT, 'hooks', 'draft-canvas-hook.mjs'));
  cpSync(join(HOST, 'skill', 'draft-fence.md'), join(OUT, 'skill', 'draft-fence.md'));
  cpSync(join(HOST, 'skill', 'draft-fence-app.md'), join(OUT, 'skill', 'draft-fence-app.md'));
  writeFileSync(
    join(OUT, 'package.json'),
    `${JSON.stringify(
      {
        name: 'draft-canvas-workbuddy',
        version: VERSION,
        private: true,
        type: 'module',
        description: 'Draft Canvas for WorkBuddy: local hub, browser panel, UserPromptSubmit hook.',
        bin: { 'draft-canvas-wb': './bin/draft-canvas-wb.mjs' },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  // 4. checks that would otherwise fail silently in the user's hands
  const problems = [];
  const bin = join(OUT, 'bin', 'draft-canvas-wb.mjs');
  const panel = join(OUT, 'panel', 'panel.js');
  const hook = join(OUT, 'hooks', 'draft-canvas-hook.mjs');
  for (const file of [bin, panel, hook, join(OUT, 'panel', 'index.html'), join(OUT, 'skill', 'draft-fence.md')]) {
    if (!existsSync(file)) problems.push(`missing ${relative(OUT, file)}`);
  }
  if (existsSync(bin)) {
    const text = readFileSync(bin, 'utf8');
    if (!text.startsWith('#!/usr/bin/env node')) problems.push('bin has no shebang');
    if (text.includes('@draft-canvas/core')) problems.push('bin still imports @draft-canvas/core at runtime');
  }
  if (existsSync(panel)) {
    const text = readFileSync(panel, 'utf8');
    for (const needle of ['draft-changelog', 'draft-rewrite']) {
      if (!text.includes(needle)) problems.push(`panel bundle does not mention ${needle}; did the ui package build?`);
    }
    if (text.includes('@kirocrew/app-sdk')) problems.push('panel bundle still references the Kiro Crew SDK');
  }
  if (existsSync(hook) && !readFileSync(hook, 'utf8').includes('additionalContext')) {
    problems.push('hook does not print additionalContext');
  }
  const mcpServer = join(OUT, 'mcp', 'server.mjs');
  const widgetHtmlPath = join(OUT, 'panel', 'widget.html');
  if (!existsSync(mcpServer)) problems.push('missing mcp/server.mjs');
  if (!existsSync(widgetHtmlPath)) problems.push('missing panel/widget.html');
  if (existsSync(mcpServer) && !readFileSync(mcpServer, 'utf8').includes('ui://draft-canvas/panel')) {
    problems.push('mcp server does not advertise the panel resource');
  }
  if (existsSync(widgetHtmlPath) && readFileSync(widgetHtmlPath, 'utf8').length < 100_000) {
    problems.push('widget.html looks too small; is the panel bundle inlined?');
  }

  // 5. the market connector, built from the host output so both always ship the same panel and server
  buildConnector();
  problems.push(...checkConnector());

  const files = walk(OUT).map((file) => ({ path: relative(OUT, file).split(sep).join('/'), bytes: statSync(file).size }));
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  console.log(`packaged: ${relative(ROOT, OUT)}  (${bytesLabel(total)}, ${files.length} files)`);
  for (const file of files.sort((a, b) => b.bytes - a.bytes)) console.log(`  ${file.path}  ${bytesLabel(file.bytes)}`);

  const connectorFiles = walk(CONNECTOR_OUT).map((file) => ({
    path: relative(CONNECTOR_OUT, file).split(sep).join('/'),
    bytes: statSync(file).size,
  }));
  const connectorTotal = connectorFiles.reduce((sum, file) => sum + file.bytes, 0);
  console.log('');
  console.log(`connector: ${relative(ROOT, CONNECTOR_OUT)}  (${bytesLabel(connectorTotal)}, ${connectorFiles.length} files)`);
  for (const file of connectorFiles.sort((a, b) => a.path.localeCompare(b.path))) {
    console.log(`  ${file.path}  ${bytesLabel(file.bytes)}`);
  }
  console.log('');
  console.log('next:');
  console.log(`  node ${relative(ROOT, join(OUT, 'bin', 'draft-canvas-wb.mjs'))} install`);
  console.log(`  node ${relative(ROOT, join(OUT, 'bin', 'draft-canvas-wb.mjs'))} start`);
  console.log(`  cd ${relative(ROOT, CONNECTOR_OUT)} && npm pack   # tarball for the submission`);

  if (problems.length > 0) {
    for (const problem of problems) console.error(`package-workbuddy: ${problem}`);
    process.exit(1);
  }
}

await main();
