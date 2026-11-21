import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, openSync, readSync, closeSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { SessionSummary } from '../protocol';
import { ensureDir } from './paths';
import { parseTranscript } from './transcript';

/**
 * What the hub knows about sessions.
 *
 * Three sources, in decreasing order of trust:
 * 1. a hook payload (`session_id` + `transcript_path` + `cwd`) — exact, and the only way to learn the
 *    path of a session that is running right now;
 * 2. a scan of `<home>/projects/*\/<uuid>.jsonl` — lets the panel offer older chats before any hook
 *    has fired for them;
 * 3. the panel's own pick, which only affects `activeSessionId`.
 *
 * WorkBuddy gives a panel no way to learn which chat it belongs to (see `docs/hosts/workbuddy.md`,
 * Q-1), so `activeSessionId` follows the session that most recently produced a hook event, and the
 * user can override it from the panel's chat picker.
 */
export interface SessionRecord {
  sessionId: string;
  transcriptPath?: string;
  title?: string;
  cwd?: string;
  /** ISO 8601 of the last hook event or transcript write. */
  updatedAt?: string;
  source: 'hook' | 'scan' | 'user';
}

interface Persisted {
  activeSessionId: string | null;
  records: SessionRecord[];
  /** Last port that worked, so the panel keeps its origin (and its `localStorage`). */
  preferredPort?: number;
}

const MAX_SCANNED = 40;
const TITLE_MAX = 60;

export class SessionRegistry {
  private records = new Map<string, SessionRecord>();
  private active: string | null = null;
  private preferredPort: number | undefined;
  private scannedAt = 0;
  private readonly titleCache = new Map<string, string>();

  constructor(
    private readonly file: string,
    private readonly transcriptsRoot: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  load(): void {
    this.cleanupTemps();
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const data = parsed as Partial<Persisted>;
    if (typeof data.activeSessionId === 'string') this.active = data.activeSessionId;
    if (typeof data.preferredPort === 'number') this.preferredPort = data.preferredPort;
    if (Array.isArray(data.records)) {
      for (const record of data.records) {
        if (typeof record?.sessionId !== 'string') continue;
        this.records.set(record.sessionId, { ...record, source: record.source ?? 'scan' });
      }
    }
  }

  /**
   * Writes the registry atomically. Several processes share this file (the MCP server of every open
   * chat, the hub, `doctor`), so the rename can lose a race on Windows; that is fine — whoever won
   * wrote the same content — but the temporary file must not be left behind.
   */
  save(): void {
    ensureDir(dirname(this.file));
    const payload: Persisted = {
      activeSessionId: this.active,
      records: [...this.records.values()],
      ...(this.preferredPort !== undefined ? { preferredPort: this.preferredPort } : {}),
    };
    const temp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      renameSync(temp, this.file);
    } catch {
      try {
        unlinkSync(temp);
      } catch {
        // already gone
      }
    }
  }

  /** Removes temp files a killed process (or a lost rename) left next to the registry. */
  cleanupTemps(olderThanMs = 60_000): void {
    let names: string[];
    try {
      names = readdirSync(dirname(this.file));
    } catch {
      return;
    }
    const prefix = `${basename(this.file)}.`;
    const cutoff = this.now() - olderThanMs;
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
      const path = join(dirname(this.file), name);
      try {
        if (statSync(path).mtimeMs >= cutoff) continue;
        unlinkSync(path);
      } catch {
        // in use, or already gone
      }
    }
  }

  get activeSessionId(): string | null {
    return this.active;
  }

  setActive(sessionId: string | null): void {
    if (sessionId === this.active) return;
    this.active = sessionId;
    this.save();
  }

  get port(): number | undefined {
    return this.preferredPort;
  }

  setPort(port: number): void {
    if (port === this.preferredPort) return;
    this.preferredPort = port;
    this.save();
  }

  /** Adds or updates a record from a hook payload. */
  upsert(input: Omit<SessionRecord, 'source'> & { source?: SessionRecord['source'] }): SessionRecord {
    const existing = this.records.get(input.sessionId);
    const transcriptPath = input.transcriptPath ?? existing?.transcriptPath;
    const title = input.title ?? existing?.title;
    const cwd = input.cwd ?? existing?.cwd;
    const merged: SessionRecord = {
      sessionId: input.sessionId,
      ...(transcriptPath !== undefined ? { transcriptPath } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      updatedAt: input.updatedAt ?? new Date(this.now()).toISOString(),
      source: input.source ?? existing?.source ?? 'hook',
    };
    this.records.set(input.sessionId, merged);
    return merged;
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.records.get(sessionId);
  }

  /** The transcript of a session: the hook-reported path first, then a scan for `<id>.jsonl`. */
  resolveTranscript(sessionId: string): string | undefined {
    const known = this.records.get(sessionId)?.transcriptPath;
    if (known !== undefined && existsSync(known)) return known;
    this.scanIfStale();
    const found = this.records.get(sessionId)?.transcriptPath;
    return found !== undefined && existsSync(found) ? found : undefined;
  }

  setTitle(sessionId: string, title: string): void {
    const record = this.records.get(sessionId);
    if (record === undefined || record.title !== undefined) return;
    record.title = title;
    this.save();
  }

  list(): SessionSummary[] {
    this.scanIfStale();
    const out: SessionSummary[] = [];
    for (const record of this.records.values()) {
      out.push({
        sessionId: record.sessionId,
        ...(record.title !== undefined ? { title: record.title } : {}),
        ...(record.updatedAt !== undefined ? { updatedAt: record.updatedAt } : {}),
        transcript: record.transcriptPath !== undefined && existsSync(record.transcriptPath),
      });
    }
    return out.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }

  /**
   * A short title from the first user message, for the panel's chat picker. Served from a cache:
   * `listSessions` runs at every panel load and must not read transcript files.
   */
  titleFor(sessionId: string): string | undefined {
    const cached = this.titleCache.get(sessionId);
    if (cached !== undefined) return cached;
    const record = this.records.get(sessionId);
    if (record?.title !== undefined) return record.title;
    return undefined;
  }

  private scanIfStale(): void {
    if (this.now() - this.scannedAt < 5_000) return;
    this.scannedAt = this.now();
    this.scan();
  }

  /** Picks up transcripts written before any hook fired for them. */
  scan(): void {
    let projects: string[];
    try {
      projects = readdirSync(this.transcriptsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(this.transcriptsRoot, entry.name));
    } catch {
      return;
    }
    const found: { path: string; mtime: number; sessionId: string }[] = [];
    for (const dir of projects) {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        const path = join(dir, name);
        try {
          found.push({ path, mtime: statSync(path).mtimeMs, sessionId: basename(name, '.jsonl') });
        } catch {
          // vanished between readdir and stat
        }
      }
    }
    found.sort((a, b) => b.mtime - a.mtime);
    let changed = false;
    let titlesLeft = 6;
    for (const entry of found.slice(0, MAX_SCANNED)) {
      const existing = this.records.get(entry.sessionId);
      const updatedAt = new Date(entry.mtime).toISOString();
      let title = existing?.title ?? this.titleCache.get(entry.sessionId);
      if (title === undefined && titlesLeft > 0) {
        // Reading the first user line of a 2 MB transcript is the expensive part of a scan, so it is
        // done a few files at a time and remembered; a missing title is not worth blocking the panel.
        titlesLeft -= 1;
        title = readTitle(entry.path);
        if (title !== undefined) this.titleCache.set(entry.sessionId, title);
      }
      if (existing?.transcriptPath === entry.path && existing.updatedAt === updatedAt && existing.title !== undefined) continue;
      if (existing?.source === 'hook' && existing.transcriptPath !== undefined) continue;
      this.records.set(entry.sessionId, {
        sessionId: entry.sessionId,
        transcriptPath: entry.path,
        ...(title !== undefined ? { title } : {}),
        updatedAt,
        source: existing?.source === 'user' ? 'user' : 'scan',
      });
      changed = true;
    }
    if (changed) this.save();
  }
}

/** First user message of a transcript, first line, shortened. Never throws. */
function readTitle(path: string): string | undefined {
  let raw = '';
  try {
    const size = Math.min(statSync(path).size, 8 * 1024);
    const buffer = Buffer.alloc(size);
    const fd = openSync(path, 'r');
    try {
      const read = readSync(fd, buffer, 0, size, 0);
      raw = buffer.subarray(0, read).toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
  const lines = raw.split('\n');
  if (lines.length > 0) lines.pop(); // the last line may be cut mid-record
  const parsed = parseTranscript(lines.join('\n'), 'title');
  const first = parsed.messages.find((message) => message.role === 'user');
  if (first === undefined) return undefined;
  const line = first.text.split('\n').map((part) => part.trim()).find((part) => part !== '');
  if (line === undefined) return undefined;
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}
