import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTER_VERSION } from '../protocol';
import { resolvePaths } from '../server/paths';
import { DraftService } from './service';

/**
 * Draft Canvas as an MCP App.
 *
 * The WorkBuddy desktop renders MCP Apps widgets inside the conversation: a tool result carrying
 * `_meta.ui.resourceUri` makes the host fetch that `ui://` resource, mount the HTML in a sandboxed
 * iframe and let it talk back over the `ui/*` protocol (`@modelcontextprotocol/ext-apps`). That is
 * how Ardot draws its design canvas, and what this file serves for the draft panel.
 *
 * Two things it buys over the local-page version:
 * - the panel lives in the client, not in a browser tab, and can go fullscreen;
 * - the widget can call `ui/message`, which posts a real user message into the chat and wakes the
 *   agent — so "发给 AI" becomes one click instead of "say something and I'll attach it".
 *
 * It cannot push: MCP has no server → client channel here, so the widget polls `ui://draft-canvas/state`.
 */
export const UI_URI = 'ui://draft-canvas/panel';
export const STATE_URI = 'ui://draft-canvas/state';
export const HISTORY_PREFIX = 'ui://draft-canvas/history/';
export const UI_MIME = 'text/html;profile=mcp-app';

export interface RpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
}

export interface RpcContext {
  service: DraftService;
  /** Returns the widget HTML; read once and cached. */
  panelHtml(): string;
}

interface ToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

const OPEN_TOOL = 'draft_canvas_open';
const PUBLISH_TOOL = 'draft_canvas_publish';
const QUEUE_TOOL = 'draft_canvas_queue';

function tools(): ToolDefinition[] {
  return [
    {
      name: OPEN_TOOL,
      title: '打开草稿面板',
      description:
        'Open the Draft Canvas panel: the user edits the draft there, and their changes come back as one message. Call this when the user wants to refine a piece of writing, mentions Draft Canvas, or when you have just written a draft.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      _meta: { ui: { resourceUri: UI_URI } },
    },
    {
      name: PUBLISH_TOOL,
      title: '把稿子放进草稿面板',
      description:
        'Publish a draft to the Draft Canvas panel that is open in this conversation, then stop writing prose versions of it in the chat. Call this every time you write or revise a draft: pass the full body (never a fragment or a diff) and reuse the same id. The panel shows it, the user edits it there, and their changes come back as one message.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Short slug for this draft. Reuse it for every revision; a new id starts a new draft.' },
          body: { type: 'string', description: 'The full draft text, Markdown, without the code fence.' },
          title: { type: 'string', description: 'Optional short title shown in the panel.' },
        },
        required: ['id', 'body'],
        additionalProperties: false,
      },
      _meta: { ui: { resourceUri: UI_URI } },
    },
    {
      name: QUEUE_TOOL,
      title: '排队一段改动',
      // Only used when the widget cannot post a message itself.
      description:
        'Fallback for the panel: queue a changelog so the user’s next message carries it. The panel calls this only if it cannot send a message directly.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'The chat id the panel is attached to.' },
          text: { type: 'string', description: 'The draft-changelog / draft-rewrite fences to deliver.' },
        },
        required: ['session_id', 'text'],
        additionalProperties: false,
      },
    },
  ];
}

function decodeSession(uri: string): string | undefined {
  if (!uri.startsWith(HISTORY_PREFIX)) return undefined;
  const tail = uri.slice(HISTORY_PREFIX.length);
  if (tail === '') return undefined;
  try {
    return decodeURIComponent(tail);
  } catch {
    return tail;
  }
}

/** Handles one JSON-RPC message. Exported so the protocol can be tested without spawning a process. */
export function handleRpc(request: RpcRequest, context: RpcContext): Record<string, unknown> | undefined {
  const id = request.id ?? null;
  const method = request.method ?? '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  if (id === null && method.startsWith('notifications/')) return undefined;

  const reply = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string): Record<string, unknown> => ({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
        serverInfo: { name: 'draft-canvas', title: 'Draft Canvas', version: ADAPTER_VERSION },
        instructions:
          'Draft Canvas 面板。调用 draft_canvas_open 打开面板；用户在面板里改稿，改动会以一条消息回到对话。',
      });

    case 'ping':
      return reply({});

    case 'tools/list':
      return reply({ tools: tools() });

    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (name === OPEN_TOOL) {
        const snapshot = context.service.snapshot();
        return reply({
          content: [{ type: 'text', text: 'Draft Canvas 面板已打开。用户在面板里改稿，改动会作为一条消息发回来。' }],
          structuredContent: snapshot,
          _meta: { ui: { resourceUri: UI_URI } },
        });
      }
      if (name === PUBLISH_TOOL) {
        const draftId = typeof args.id === 'string' ? args.id.trim() : '';
        const body = typeof args.body === 'string' ? args.body : '';
        if (draftId === '' || body.trim() === '') return fail(-32602, 'id and body are required');
        const published = context.service.publish({
          draftId,
          body,
          ...(typeof args.title === 'string' && args.title !== '' ? { title: args.title } : {}),
        });
        return reply({
          content: [
            {
              type: 'text',
              text: `已放进草稿面板：${published.draftId} 第 ${published.versions} 版。用户会在面板里直接改，改动随下一条消息回来。`,
            },
          ],
          structuredContent: { ...published, snapshot: context.service.snapshot() },
          _meta: { ui: { resourceUri: UI_URI } },
        });
      }
      if (name === QUEUE_TOOL) {
        const sessionId = typeof args.session_id === 'string' ? args.session_id : '';
        const text = typeof args.text === 'string' ? args.text : '';
        if (sessionId === '' || text === '') return fail(-32602, 'session_id and text are required');
        const queued = context.service.queue(sessionId, text);
        return reply({
          content: [{ type: 'text', text: `已排队，等你下一条消息带上（共 ${queued.pending} 条待发）。` }],
          structuredContent: queued,
        });
      }
      return fail(-32602, `unknown tool: ${name}`);
    }

    case 'resources/list':
      return reply({
        resources: [
          { uri: UI_URI, name: 'Draft Canvas panel', mimeType: UI_MIME },
          { uri: STATE_URI, name: 'Draft Canvas state', mimeType: 'application/json' },
        ],
      });

    case 'resources/templates/list':
      return reply({ resourceTemplates: [] });

    case 'resources/read': {
      const uri = typeof params.uri === 'string' ? params.uri : '';
      if (uri === UI_URI) {
        return reply({
          contents: [
            {
              uri,
              mimeType: UI_MIME,
              text: context.panelHtml(),
              _meta: { ui: { prefersBorder: false, csp: { resourceDomains: [], connectDomains: [] } } },
            },
          ],
        });
      }
      if (uri === STATE_URI) {
        return reply({
          contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(context.service.snapshot()) }],
        });
      }
      const sessionId = decodeSession(uri);
      if (sessionId !== undefined) {
        return reply({
          contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(context.service.history(sessionId)) }],
        });
      }
      return fail(-32602, `unknown resource: ${uri}`);
    }

    default:
      if (id === null) return undefined;
      return fail(-32601, `method not found: ${method}`);
  }
}

/** `dist/workbuddy/mcp/server.mjs` → `dist/workbuddy`. */
function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function loadPanelHtml(): () => string {
  const explicit = process.env.DRAFT_CANVAS_PANEL;
  const candidates = [explicit, join(packageRoot(), 'panel', 'widget.html'), join(packageRoot(), 'panel', 'index.html')].filter(
    (candidate): candidate is string => candidate !== undefined && candidate !== '',
  );
  let cached: string | undefined;
  return () => {
    if (cached !== undefined) return cached;
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      cached = readFileSync(candidate, 'utf8');
      return cached;
    }
    cached = `<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;padding:16px">Draft Canvas: 面板文件缺失。重新运行 <code>npm run package:wb</code>，再重启 WorkBuddy。</body>`;
    return cached;
  };
}

export function main(): void {
  const service = new DraftService(resolvePaths({}));
  service.start();
  const context: RpcContext = { service, panelHtml: loadPanelHtml() };
  let buffer = '';
  const write = (message: Record<string, unknown>): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (line === '') continue;
      let request: RpcRequest;
      try {
        request = JSON.parse(line) as RpcRequest;
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        continue;
      }
      try {
        const reply = handleRpc(request, context);
        if (reply !== undefined) write(reply);
      } catch (err) {
        write({
          jsonrpc: '2.0',
          id: request.id ?? null,
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

if (process.argv[1] !== undefined && /server\.mjs$|server\.ts$/.test(process.argv[1])) main();
