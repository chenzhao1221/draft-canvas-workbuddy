import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { HostEvent, Message } from '@draft-canvas/core';
import {
  ADAPTER_VERSION,
  HOST_DISPLAY_NAME,
  HOST_ID,
  HUB_PROTOCOL_VERSION,
  isRecord,
  pickString,
  type HistoryBody,
  type HookBody,
  type HubInfo,
  type InjectBody,
  type SessionSummary,
  type StreamFrame,
} from '../protocol';
import { ensureState, type HostPaths } from './paths';
import { PendingQueue } from './pending';
import { SessionRegistry } from './sessions';
import { TranscriptTailer } from './tailer';
import { hooksInstalled } from './hooks';
import { DraftSink } from './sink';
import { parseTranscript } from './transcript';

/** Answers a user turn the way the host would; only present in `simulate` mode. */
export interface DemoAgent {
  handleTurn(input: { sessionId: string; prompt: string; injected: string | null }): void;
}

export interface HubOptions {
  paths: HostPaths;
  /** Folder with `index.html` and the bundled panel; empty string disables static serving. */
  panelDir: string;
  hostVersion?: string;
  demo?: DemoAgent;
  log?: (line: string) => void;
  pollIntervalMs?: number;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_TAILERS = 8;
const MAX_LOG_LINES = 300;

/**
 * The local hub: one loopback HTTP server that
 *
 * - serves the panel page,
 * - answers history and session reads from the transcripts WorkBuddy writes,
 * - pushes host events over Server-Sent Events,
 * - receives WorkBuddy hook payloads (session discovery, "the agent finished", the turn's prompt),
 * - queues changelog messages for the next turn (`injectNextTurn`).
 *
 * It is the WorkBuddy equivalent of Crew's Gateway plus its push channel, narrowed to what this
 * panel needs (`docs/hosts/workbuddy.md`).
 */
export class Hub {
  readonly registry: SessionRegistry;
  readonly pending: PendingQueue;
  readonly sink: DraftSink;
  private readonly tailers = new Map<string, TranscriptTailer>();
  private readonly streams = new Set<ServerResponse>();
  private readonly logLines: string[] = [];
  private readonly server: Server;
  private readonly paths: HostPaths;
  private readonly panelDir: string;
  private readonly demo: DemoAgent | undefined;
  private readonly hostVersion: string | undefined;
  private readonly pollIntervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private port = 0;
  private startedAt = new Date();
  private closed = false;

  constructor(private readonly options: HubOptions) {
    this.paths = options.paths;
    this.panelDir = options.panelDir;
    this.demo = options.demo;
    this.hostVersion = options.hostVersion;
    this.pollIntervalMs = options.pollIntervalMs ?? 1200;
    ensureState(this.paths);
    this.registry = new SessionRegistry(this.paths.sessionsFile, this.paths.transcriptsRoot);
    this.registry.load();
    this.pending = new PendingQueue(this.paths.pendingDir);
    this.sink = new DraftSink(join(this.paths.stateDir, 'drafts'), join(this.paths.stateDir, 'drafts', 'history.jsonl'));
    this.server = createServer((req, res) => {
      void this.route(req, res);
    });
  }

  // ------------------------------------------------------------------ lifecycle

  /** Binds the first free port among `preferred` and the next nine. */
  async start(preferred?: number): Promise<number> {
    const base = preferred ?? this.registry.port ?? Number(process.env.DRAFT_CANVAS_PORT ?? 47831);
    const tries: number[] = [];
    if (Number.isFinite(base) && base > 0) for (let i = 0; i < 10; i += 1) tries.push(base + i);
    tries.push(0);
    let lastError: unknown;
    for (const port of tries) {
      try {
        this.port = await listen(this.server, port);
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (lastError !== undefined) throw lastError;
    this.startedAt = new Date();
    this.registry.setPort(this.port);
    writeFileSync(
      this.paths.hubFile,
      `${JSON.stringify({ port: this.port, pid: process.pid, startedAt: this.startedAt.toISOString(), demo: this.demo !== undefined }, null, 2)}\n`,
      'utf8',
    );
    this.sink.ensureDir();
    // Existing files are not new versions: seed the known hashes before the timer starts.
    this.sink.scan(this.registry.activeSessionId);
    this.timer = setInterval(() => this.pollAll(), this.pollIntervalMs);
    this.timer.unref?.();
    this.log(`listening on http://127.0.0.1:${this.port}`);
    return this.port;
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    for (const stream of this.streams) stream.end();
    this.streams.clear();
    await new Promise<void>((done) => this.server.close(() => done()));
    try {
      unlinkSync(this.paths.hubFile);
    } catch {
      // already gone
    }
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/`;
  }

  // ------------------------------------------------------------------ snapshot

  info(): HubInfo {
    return {
      protocol: HUB_PROTOCOL_VERSION,
      hubVersion: ADAPTER_VERSION,
      host: {
        id: HOST_ID,
        displayName: HOST_DISPLAY_NAME,
        home: this.paths.home,
        settingsPath: this.paths.settingsPath,
        hooksInstalled: this.hooksReady(),
      },
      sessions: this.sessions(),
      activeSessionId: this.registry.activeSessionId,
      liveUpdates: this.hooksReady(),
      pending: this.pending.summary(),
      ...(this.demo !== undefined ? { demo: true } : {}),
    };
  }

  /** `simulate` mode needs no hooks: the demo agent plays the host. */
  private hooksReady(): boolean {
    if (this.demo !== undefined) return true;
    return hooksInstalled(this.paths.settingsPath);
  }

  /**
   * Session list for the panel. Deliberately free of file reads: the panel asks for it on every load
   * and after every hook, so titles come from what the scan has already cached.
   */
  private sessions(): SessionSummary[] {
    return this.registry.list();
  }

  history(sessionId: string): HistoryBody {
    const path = this.registry.resolveTranscript(sessionId);
    if (path === undefined) {
      const publishedOnly = this.sink.messagesFor(sessionId);
      this.log(`history ${short(sessionId)}: no transcript (known from ${this.registry.get(sessionId)?.source ?? 'nothing'})`);
      return {
        messages: publishedOnly,
        completeness: publishedOnly.length > 0 ? 'full' : 'window',
        source: publishedOnly.length > 0 ? 'transcript' : 'none',
        note: 'No transcript for this chat yet. Published drafts are shown; chat text needs one hook event first.',
      };
    }
    const published = this.sink.messagesFor(sessionId);
    const tailer = this.ensureTailer(sessionId, path);
    if (tailer !== undefined && tailer.messages.length > 0) {
      this.log(`history ${short(sessionId)}: ${tailer.messages.length} messages + ${published.length} published`);
      return {
        messages: mergeByTime(tailer.messages, published),
        completeness: tailer.completeness,
        source: 'transcript',
      };
    }
    try {
      const parsed = parseTranscript(readFileSync(path, 'utf8'), sessionId);
      this.log(`history ${short(sessionId)}: ${parsed.usable}/${parsed.lines} lines, ${parsed.messages.length} messages`);
      return {
        messages: mergeByTime(parsed.messages, published),
        completeness: parsed.completeness,
        source: 'transcript',
      };
    } catch (err) {
      this.log(`history ${short(sessionId)}: FAILED ${message(err)}`);
      return {
        messages: [],
        completeness: 'window',
        source: 'none',
        note: `Could not read the transcript: ${message(err)}`,
      };
    }
  }

  inject(sessionId: string, text: string): InjectBody {
    const { queuedAt, pending } = this.pending.queue(sessionId, text);
    this.log(`inject ${short(sessionId)}: queued ${text.length} chars (${pending} waiting)`);
    this.broadcastToStreams({ type: 'sessions', activeSessionId: this.registry.activeSessionId, sessions: this.sessions() });
    return {
      ok: true,
      sessionId,
      queuedAt,
      pending,
      note: 'Queued: your next message in this chat carries it.',
    };
  }

  attach(sessionId: string): void {
    this.registry.setActive(sessionId);
    this.log(`attach: ${short(sessionId)}`);
    this.broadcastSessions();
    const path = this.registry.resolveTranscript(sessionId);
    if (path !== undefined) this.ensureTailer(sessionId, path)?.poll();
  }

  diagnostics(extra: string[] = []): string {
    const lines: string[] = [];
    lines.push(`Draft Canvas for WorkBuddy ${ADAPTER_VERSION} (interface 1) on ${this.paths.kind}`);
    lines.push(`hub http://127.0.0.1:${this.port} up ${Math.round((Date.now() - this.startedAt.getTime()) / 1000)}s${this.demo !== undefined ? ' (demo)' : ''}`);
    lines.push(`settings ${this.paths.settingsPath} hooks=${this.hooksReady() ? 'installed' : 'missing'}`);
    lines.push(`active ${this.registry.activeSessionId ?? '-'}`);
    lines.push('sessions:');
    for (const summary of this.sessions().slice(0, 12)) {
      const record = this.registry.get(summary.sessionId);
      const tailer = this.tailers.get(summary.sessionId);
      lines.push(
        `  ${short(summary.sessionId)}  msgs=${tailer?.messages.length ?? '-'}  src=${record?.source ?? '-'}  ${
          record?.transcriptPath === undefined ? 'no transcript' : 'transcript ok'
        }  ${summary.title ?? ''}`,
      );
    }
    const waiting = this.pending.summary();
    lines.push(`pending: ${waiting.length === 0 ? 'none' : waiting.map((p) => `${short(p.sessionId)}=${p.count}`).join(' ')}`);
    lines.push(...extra);
    lines.push('log:');
    lines.push(...this.logLines.slice(-120));
    return lines.join('\n');
  }

  log(line: string): void {
    const stamped = `${new Date().toISOString().slice(11, 23)} ${line}`;
    this.logLines.push(stamped);
    if (this.logLines.length > MAX_LOG_LINES) this.logLines.splice(0, this.logLines.length - MAX_LOG_LINES);
    this.options.log?.(line);
  }

  // ------------------------------------------------------------------ hooks

  /** Called by the hook script for every event; returns synchronously, the hook does not wait long. */
  handleHook(body: HookBody): { ok: true; injected?: boolean } {
    const sessionId = body.session_id;
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new HttpError(400, 'BAD_REQUEST', 'hook payload has no session_id');
    }
    const event = body.hook_event_name ?? 'unknown';
    const record = this.registry.upsert({
      sessionId,
      ...(typeof body.transcript_path === 'string' ? { transcriptPath: body.transcript_path } : {}),
      ...(typeof body.cwd === 'string' ? { cwd: body.cwd } : {}),
    });
    this.log(`hook ${event} ${short(sessionId)}${body.injected === true ? ' (injected)' : ''}`);
    // The chat that just spoke is the chat the user is looking at.
    this.registry.setActive(sessionId);
    this.registry.save();
    if (event === 'SessionEnd') {
      this.broadcastSessions();
      return { ok: true };
    }
    const path = this.registry.resolveTranscript(sessionId) ?? record.transcriptPath;
    if (path !== undefined) {
      const tailer = this.ensureTailer(sessionId, path);
      // The reply may land a moment after `Stop`, so read now and twice more.
      this.rePollSoon(sessionId, [0, 300, 1200, 2600]);
      tailer?.poll();
    }
    this.broadcastSessions();
    if (event === 'UserPromptSubmit' && this.demo !== undefined) {
      // No hook runs in demo mode, so the hub plays the hook's part: consume the queue, then let the
      // demo agent answer as the host would.
      const injectedItems = this.pending.consume(sessionId);
      const injected = injectedItems.length === 0 ? null : injectedItems.map((item) => item.text).join('\n\n');
      this.demo.handleTurn({
        sessionId,
        prompt: typeof body.prompt === 'string' ? body.prompt : '',
        injected,
      });
      // The demo publishes its draft a moment later; pick it up without waiting for the timer.
      for (const delay of [450, 900, 1800]) {
        const timer = setTimeout(() => {
          if (!this.closed) this.pollSink();
        }, delay);
        timer.unref?.();
      }
      return { ok: true, ...(injected !== null ? { injected: true } : {}) };
    }
    return { ok: true };
  }

  private rePollSoon(sessionId: string, delays: number[]): void {
    for (const delay of delays) {
      const timer = setTimeout(() => {
        if (this.closed) return;
        this.tailers.get(sessionId)?.poll();
      }, delay);
      timer.unref?.();
    }
  }

  // ------------------------------------------------------------------ tailers

  private ensureTailer(sessionId: string, transcriptPath: string): TranscriptTailer | undefined {
    const existing = this.tailers.get(sessionId);
    if (existing !== undefined) return existing;
    const tailer = new TranscriptTailer(transcriptPath, sessionId, {
      userMessage: (message: Message) => this.broadcast({ type: 'user_message', sessionId, message }),
      assistantChunk: (messageId: string, delta: string) => this.broadcast({ type: 'assistant_chunk', sessionId, messageId, delta }),
      assistantDone: (message: Message) => this.broadcast({ type: 'assistant_done', sessionId, message }),
      reset: () => this.broadcast({ type: 'history_reset', sessionId }),
    });
    tailer.loadAll();
    this.tailers.set(sessionId, tailer);
    if (this.tailers.size > MAX_TAILERS) {
      const oldest = this.tailers.keys().next();
      if (!oldest.done) this.tailers.delete(oldest.value);
    }
    this.log(`tailer ${short(sessionId)}: ${tailer.messages.length} messages`);
    return tailer;
  }

  private pollAll(): void {
    for (const tailer of this.tailers.values()) tailer.poll();
    this.pollSink();
  }

  /**
   * Turns a new draft publish into an `assistant_done` event. This is the panel's only source of new
   * versions on WorkBuddy: the transcript carries no assistant messages (`docs/hosts/workbuddy.md`, Q-2).
   */
  private pollSink(): void {
    const sessionId = this.registry.activeSessionId;
    const fresh = this.sink.scan(sessionId);
    if (fresh.length === 0) return;
    this.log(`sink: ${fresh.map((draft) => draft.draftId).join(', ')}`);
    if (sessionId === null) return;
    const messages = this.sink.messagesFor(sessionId);
    for (const draft of fresh) {
      const message = messages.find((candidate) => candidate.id === `draft:${draft.draftId}:${draft.hash}`);
      if (message !== undefined) this.broadcast({ type: 'assistant_done', sessionId, message });
    }
    this.broadcastSessions();
  }

  // ------------------------------------------------------------------ transport

  private broadcast(event: HostEvent): void {
    this.broadcastToStreams({ type: 'host', event });
  }

  private broadcastSessions(): void {
    this.broadcastToStreams({ type: 'sessions', activeSessionId: this.registry.activeSessionId, sessions: this.sessions() });
  }

  private broadcastToStreams(frame: StreamFrame): void {
    if (this.streams.size === 0) return;
    const payload = `data: ${JSON.stringify(frame)}\n\n`;
    for (const stream of [...this.streams]) {
      try {
        stream.write(payload);
      } catch {
        this.streams.delete(stream);
      }
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`);
    const pathname = decodeURIComponent(url.pathname);
    try {
      if (pathname.startsWith('/api/')) {
        if (!this.originAllowed(req)) throw new HttpError(403, 'ORIGIN_REJECTED', 'Origin not allowed');
        if (req.method !== 'GET' && req.headers['x-draft-canvas-request'] !== '1') {
          throw new HttpError(403, 'MISSING_HEADER', 'Send x-draft-canvas-request: 1');
        }
        await this.api(req, res, pathname, url);
        return;
      }
      this.staticFile(res, pathname);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const code = err instanceof HttpError ? err.code : 'INTERNAL_ERROR';
      if (status >= 500) this.log(`route ${pathname}: ${message(err)}`);
      sendJson(res, status, { error: { code, message: message(err) } });
    }
  }

  /**
   * No CORS headers are ever sent, so a page on another origin cannot read a reply; the check below
   * only adds a clean refusal for the write routes.
   */
  private originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || origin === '') return true;
    if (origin === 'null') return false;
    return origin === `http://127.0.0.1:${this.port}` || origin === `http://localhost:${this.port}` || origin === `http://[::1]:${this.port}`;
  }

  private async api(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<void> {
    const method = req.method ?? 'GET';
    if (pathname === '/api/health') {
      sendJson(res, 200, { ok: true, port: this.port });
      return;
    }
    if (pathname === '/api/info' && method === 'GET') {
      sendJson(res, 200, this.info());
      return;
    }
    if (pathname === '/api/sessions' && method === 'GET') {
      sendJson(res, 200, { sessions: this.sessions(), activeSessionId: this.registry.activeSessionId });
      return;
    }
    if (pathname === '/api/diagnostics' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(this.diagnostics());
      return;
    }
    if (pathname === '/api/events' && method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(`retry: 2000\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'hello', info: this.info() } satisfies StreamFrame)}\n\n`);
      this.streams.add(res);
      const keepAlive = setInterval(() => {
        if (this.closed) return;
        try {
          res.write(': ping\n\n');
        } catch {
          clearInterval(keepAlive);
        }
      }, 20_000);
      keepAlive.unref?.();
      req.on('close', () => {
        clearInterval(keepAlive);
        this.streams.delete(res);
      });
      this.log(`sse: client connected (${this.streams.size})`);
      return;
    }
    if (pathname === '/api/hook' && method === 'POST') {
      const body = await readJson(req);
      if (!isRecord(body)) throw new HttpError(400, 'BAD_REQUEST', 'hook body must be a JSON object');
      const reply = this.handleHook(body as HookBody);
      sendJson(res, 200, reply);
      return;
    }

    const sessionMatch = /^\/api\/sessions\/([^/]+)\/(history|inject|attach)$/.exec(pathname);
    if (sessionMatch !== null) {
      const sessionId = sessionMatch[1] ?? '';
      const action = sessionMatch[2];
      if (action === 'history' && method === 'GET') {
        sendJson(res, 200, this.history(sessionId));
        return;
      }
      if (action === 'attach' && method === 'POST') {
        await readJson(req).catch(() => ({}));
        this.attach(sessionId);
        sendJson(res, 200, { ok: true, activeSessionId: this.registry.activeSessionId });
        return;
      }
      if (action === 'inject' && method === 'POST') {
        const body = await readJson(req);
        const text = isRecord(body) ? pickString(body, ['text']) : undefined;
        if (text === undefined) throw new HttpError(400, 'BAD_REQUEST', 'inject needs a text field');
        sendJson(res, 200, this.inject(sessionId, text));
        return;
      }
    }
    throw new HttpError(404, 'NOT_FOUND', `no route for ${method} ${pathname}`);
  }

  private staticFile(res: ServerResponse, pathname: string): void {
    if (this.panelDir === '') throw new HttpError(404, 'NOT_FOUND', 'the panel is not served by this process');
    const root = resolve(this.panelDir);
    const relative = normalize(pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));
    const target = resolve(join(root, relative));
    if (target !== root && !target.startsWith(root + sep)) throw new HttpError(403, 'FORBIDDEN', 'outside the panel folder');
    let body: Buffer;
    try {
      if (!statSync(target).isFile()) throw new Error('not a file');
      body = readFileSync(target);
    } catch {
      throw new HttpError(404, 'NOT_FOUND', `not found: ${pathname}`);
    }
    res.writeHead(200, {
      'content-type': contentType(target),
      'cache-control': 'no-store',
      'content-length': body.length,
    });
    res.end(body);
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    text: string,
  ) {
    super(text);
  }
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'request body is too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'BAD_REQUEST', 'body is not valid JSON');
  }
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((done, fail) => {
    const onError = (err: Error): void => {
      server.off('listening', onListening);
      fail(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      const address = server.address();
      done(typeof address === 'object' && address !== null ? address.port : port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

/** Transcript order plus published drafts, oldest first. Ties keep the transcript first. */
function mergeByTime(transcript: Message[], published: Message[]): Message[] {
  if (published.length === 0) return transcript;
  const seen = new Set(transcript.map((message) => message.id));
  const merged = [...transcript, ...published.filter((message) => !seen.has(message.id))];
  return merged.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function short(sessionId: string): string {
  return sessionId.length <= 8 ? sessionId : sessionId.slice(0, 8);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
