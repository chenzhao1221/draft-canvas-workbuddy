import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HistoryCompleteness, Message } from '@draft-canvas/core';
import type { HistoryBody, HubInfo, SessionSummary } from '../protocol';
import { ADAPTER_VERSION, HOST_DISPLAY_NAME, HOST_ID, HUB_PROTOCOL_VERSION } from '../protocol';
import { ensureState, type HostPaths } from '../server/paths';
import { PendingQueue } from '../server/pending';
import { SessionRegistry } from '../server/sessions';
import { DraftSink } from '../server/sink';
import { parseTranscript } from '../server/transcript';

/**
 * Everything the panel needs, without any transport.
 *
 * The MCP App version and the local-hub version ask the same questions ("which chats are there",
 * "what is in this one", "queue this text"), so the answers live here and both transports are thin.
 * There is no push here: an MCP App cannot receive one, so the widget polls instead.
 */
export class DraftService {
  readonly registry: SessionRegistry;
  readonly sink: DraftSink;
  readonly pending: PendingQueue;
  private readonly cache = new Map<string, { at: number; size: number; messages: Message[]; completeness: HistoryCompleteness }>();

  constructor(private readonly paths: HostPaths) {
    ensureState(paths);
    this.registry = new SessionRegistry(paths.sessionsFile, paths.transcriptsRoot);
    this.registry.load();
    this.sink = new DraftSink(join(paths.stateDir, 'drafts'), join(paths.stateDir, 'drafts', 'history.jsonl'));
    this.pending = new PendingQueue(paths.pendingDir);
  }

  start(): void {
    this.sink.ensureDir();
    // Existing files are not new versions: seed the hashes so the first poll does not announce them.
    this.sink.scan(this.registry.activeSessionId);
  }

  get home(): string {
    return this.paths.home;
  }

  /**
   * The chat this panel belongs to.
   *
   * The MCP server runs inside the conversation the widget was opened in, but the host passes no
   * session id to an MCP server, so: the transcript with the newest write wins (that is the chat
   * being written right now), then the last hook event, then nothing.
   */
  activeSessionId(): string | null {
    const newest = this.registry.list()[0];
    const hooked = this.registry.activeSessionId;
    if (newest !== undefined) {
      const age = newest.updatedAt === undefined ? Number.POSITIVE_INFINITY : Date.now() - Date.parse(newest.updatedAt);
      if (age < 15 * 60 * 1000) return newest.sessionId;
    }
    return hooked ?? newest?.sessionId ?? null;
  }

  /**
   * Publishes one draft version and returns what the widget should show. The agent calls this
   * instead of writing a fenced block, so the panel *is* the draft in the conversation.
   */
  publish(input: { draftId: string; body: string; title?: string }): {
    sessionId: string | null;
    draftId: string;
    versions: number;
    publishedAt: string;
  } {
    this.sink.ensureDir();
    const header = input.title === undefined || input.title === '' ? '' : `<!-- title: ${input.title} -->
`;
    writeFileSync(join(this.sink.currentDir, `${input.draftId}.md`), `${header}${input.body}`, 'utf8');
    const sessionId = this.activeSessionId();
    this.sink.scan(sessionId);
    if (sessionId !== null) this.registry.setActive(sessionId);
    return {
      sessionId,
      draftId: input.draftId,
      versions: this.sink.versionsOf(input.draftId),
      publishedAt: new Date().toISOString(),
    };
  }

  snapshot(): HubInfo {
    return {
      protocol: HUB_PROTOCOL_VERSION,
      hubVersion: ADAPTER_VERSION,
      host: {
        id: HOST_ID,
        displayName: HOST_DISPLAY_NAME,
        home: this.paths.home,
        settingsPath: this.paths.settingsPath,
        hooksInstalled: true,
      },
      sessions: this.sessions(),
      activeSessionId: this.activeSessionId(),
      // An MCP App has no push channel: the panel says so and polls instead of waiting.
      liveUpdates: false,
      pending: this.pending.summary(),
    };
  }

  sessions(): SessionSummary[] {
    return this.registry.list();
  }

  history(sessionId: string): HistoryBody {
    const published = this.sink.messagesFor(sessionId);
    const path = this.registry.resolveTranscript(sessionId);
    if (path === undefined) {
      return {
        messages: published,
        completeness: published.length > 0 ? 'full' : 'window',
        source: published.length > 0 ? 'transcript' : 'none',
        note: 'No transcript for this chat yet. Published drafts are shown.',
      };
    }
    let cached: Message[];
    let completeness: HistoryCompleteness;
    try {
      const stat = statSync(path);
      const hit = this.cache.get(sessionId);
      if (hit !== undefined && hit.at === stat.mtimeMs && hit.size === stat.size) {
        cached = hit.messages;
        completeness = hit.completeness;
      } else {
        const parsed = parseTranscript(readFileSync(path, 'utf8'), sessionId);
        cached = parsed.messages;
        completeness = parsed.completeness;
        this.cache.set(sessionId, { at: stat.mtimeMs, size: stat.size, messages: cached, completeness });
      }
    } catch (err) {
      return {
        messages: published,
        completeness: 'window',
        source: published.length > 0 ? 'transcript' : 'none',
        note: `Could not read the transcript: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return { messages: mergeByTime(cached, published), completeness, source: 'transcript' };
  }

  attach(sessionId: string): void {
    this.registry.setActive(sessionId);
  }

  /** Fallback delivery: the changelog waits for the user's next message (the hook prints it). */
  queue(sessionId: string, text: string): { queuedAt: string; pending: number } {
    return this.pending.queue(sessionId, text);
  }
}

function mergeByTime(transcript: Message[], published: Message[]): Message[] {
  if (published.length === 0) return transcript;
  const seen = new Set(transcript.map((message) => message.id));
  const merged = [...transcript, ...published.filter((message) => !seen.has(message.id))];
  return merged.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
