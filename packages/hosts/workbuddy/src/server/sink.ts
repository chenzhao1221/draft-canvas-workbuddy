import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { formatDraftFence, hashText, type Message } from '@draft-canvas/core';

/**
 * The draft sink: where the agent leaves the drafts the panel shows.
 *
 * Why this exists
 * ---------------
 * WorkBuddy does **not** write assistant replies into the session transcript. A 1.8 MB transcript
 * of a long chat contained 412 records — user messages, reasoning steps, tool calls, tool results,
 * file snapshots — and **zero** assistant messages (`doctor` shows this: `message ×2 role=user`).
 * The visible replies live in the desktop app's own store / the cloud conversation, neither of which
 * a plugin can read. So `getHistory` alone can never rebuild a draft version on this host.
 *
 * The fix is the one thing the agent can always do: write a file. The skill tells the model to copy
 * each `draft` block's body to
 *
 *     <state>/drafts/current/<id>.md
 *
 * The hub turns every change of such a file into one assistant message containing a `draft` fence, so
 * core numbers versions exactly as it would from a chat that did persist its replies. The fence text
 * is built with core's own `formatDraftFence`, so the escaping rule (section 10.4) is identical.
 */
export interface PublishedDraft {
  draftId: string;
  body: string;
  title?: string;
  /** ISO 8601, the moment the hub noticed the write. */
  publishedAt: string;
  /** `hashText(body)`: a republished identical body is not a new version. */
  hash: string;
  /** The chat that was active when the file changed. */
  sessionId?: string;
}

export const TITLE_DIRECTIVE = /^<!--\s*title:\s*(.+?)\s*-->\s*$/i;

interface HistoryLine {
  draftId: string;
  body: string;
  title?: string;
  publishedAt: string;
  hash: string;
  sessionId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Splits an optional `<!-- title: … -->` first line from the body. */
export function parseSinkFile(raw: string): { body: string; title?: string } {
  const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = text.split('\n');
  const first = lines[0] ?? '';
  const match = TITLE_DIRECTIVE.exec(first);
  if (match !== null) {
    const title = (match[1] ?? '').trim();
    const body = lines.slice(1).join('\n').replace(/^\n+/, '').replace(/\s+$/, '');
    return title === '' ? { body } : { body, title };
  }
  const heading = /^#\s+(.+)$/.exec(first);
  const body = text.replace(/\s+$/, '');
  return heading === null ? { body } : { body, title: (heading[1] ?? '').trim() };
}

export class DraftSink {
  /** Last hash seen per draft id, seeded from the history file. */
  private lastHash = new Map<string, string>();
  private loaded = false;

  constructor(
    /** Folder the agent writes into; `current` is its sub-folder. */
    private readonly dir: string,
    private readonly historyFile: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get currentDir(): string {
    return join(this.dir, 'current');
  }

  ensureDir(): void {
    mkdirSync(this.currentDir, { recursive: true });
  }

  /** Every publish so far, oldest first. */
  history(): PublishedDraft[] {
    this.ensureDir();
    let raw = '';
    try {
      raw = readFileSync(this.historyFile, 'utf8');
    } catch {
      return [];
    }
    const out: PublishedDraft[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(entry)) continue;
      if (typeof entry.draftId !== 'string' || typeof entry.body !== 'string' || typeof entry.publishedAt !== 'string') continue;
      out.push({
        draftId: entry.draftId,
        body: entry.body,
        ...(typeof entry.title === 'string' ? { title: entry.title } : {}),
        publishedAt: entry.publishedAt,
        hash: typeof entry.hash === 'string' ? entry.hash : hashText(entry.body),
        ...(typeof entry.sessionId === 'string' ? { sessionId: entry.sessionId } : {}),
      });
    }
    return out;
  }

  /**
   * Reads the sink folder and returns the drafts that changed since the last call, appending them to
   * the history file. Call it often: it is a few `stat`s when nothing changed.
   */
  scan(activeSessionId: string | null): PublishedDraft[] {
    this.ensureDir();
    if (!this.loaded) {
      for (const draft of this.history()) this.lastHash.set(draft.draftId, draft.hash);
      this.loaded = true;
    }
    let names: string[];
    try {
      names = readdirSync(this.currentDir);
    } catch {
      return [];
    }
    const fresh: PublishedDraft[] = [];
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const draftId = name.slice(0, -'.md'.length);
      if (draftId === '') continue;
      const path = join(this.currentDir, name);
      let raw: string;
      try {
        if (!statSync(path).isFile()) continue;
        raw = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      const { body, title } = parseSinkFile(raw);
      if (body.trim() === '') continue;
      const hash = hashText(body);
      if (this.lastHash.get(draftId) === hash) continue;
      this.lastHash.set(draftId, hash);
      const entry: HistoryLine = {
        draftId,
        body,
        ...(title !== undefined ? { title } : {}),
        publishedAt: new Date(this.now()).toISOString(),
        hash,
        ...(activeSessionId !== null ? { sessionId: activeSessionId } : {}),
      };
      appendFileSync(this.historyFile, `${JSON.stringify(entry)}\n`, 'utf8');
      fresh.push(entry);
    }
    return fresh;
  }

  /** One assistant message per published version, each holding a complete `draft` fence. */
  messagesFor(sessionId: string): Message[] {
    return this.history()
      .filter((draft) => draft.sessionId === undefined || draft.sessionId === sessionId)
      .map((draft) => ({
        id: `draft:${draft.draftId}:${draft.hash}`,
        sessionId,
        role: 'assistant' as const,
        text: formatDraftFence({
          id: draft.draftId,
          body: draft.body,
          lang: 'markdown',
          ...(draft.title !== undefined ? { title: draft.title } : {}),
        }),
        createdAt: draft.publishedAt,
        complete: true,
      }));
  }

  /** How many versions of one draft were published. */
  versionsOf(draftId: string): number {
    return this.history().filter((draft) => draft.draftId === draftId).length;
  }

  /** True when the sink has ever received anything (used by `status` / diagnostics). */
  get hasContent(): boolean {
    return existsSync(this.currentDir);
  }
}
