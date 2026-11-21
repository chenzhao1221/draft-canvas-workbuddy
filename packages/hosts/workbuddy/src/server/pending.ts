import { readFileSync, renameSync, unlinkSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PendingSummary } from '../protocol';
import { ensureDir } from './paths';

/**
 * Changelog messages waiting for the user's next turn.
 *
 * `injectNextTurn` cannot touch the composer: WorkBuddy exposes no API for that (see
 * `docs/hosts/workbuddy.md`, Q-3). Instead the hub writes the text here, and the `UserPromptSubmit`
 * hook prints it as `additionalContext` on the next turn — ADAPTER_INTERFACE section 8's
 * `'context-only'` path, `requiresUserSend: false`.
 *
 * The queue lives on disk, not in the hub's memory, so a hub restart (or a hub that is not running
 * at all) never loses an edit the user already sent. The hook reads the same files.
 */
export interface PendingItem {
  /** Stable id of this message; only used for logging. */
  id: string;
  text: string;
  queuedAt: string;
}

interface PendingFile {
  sessionId: string;
  items: PendingItem[];
}

/** A message older than this is dropped: it belongs to a turn the user has long moved past. */
export const MAX_AGE_MS = 30 * 60 * 1000;

export function pendingFileName(sessionId: string): string {
  return `${encodeURIComponent(sessionId)}.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class PendingQueue {
  constructor(
    private readonly dir: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private fileFor(sessionId: string): string {
    return join(this.dir, pendingFileName(sessionId));
  }

  private readFile(sessionId: string): PendingItem[] {
    let raw: string;
    try {
      raw = readFileSync(this.fileFor(sessionId), 'utf8');
    } catch {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.items)) return [];
    const cut = this.now() - MAX_AGE_MS;
    const items: PendingItem[] = [];
    for (const entry of parsed.items) {
      if (!isRecord(entry)) continue;
      if (typeof entry.text !== 'string' || entry.text.trim() === '') continue;
      if (typeof entry.queuedAt !== 'string') continue;
      const at = Date.parse(entry.queuedAt);
      if (Number.isNaN(at) || at < cut) continue;
      items.push({ id: typeof entry.id === 'string' ? entry.id : entry.queuedAt, text: entry.text, queuedAt: entry.queuedAt });
    }
    return items;
  }

  private writeFile(sessionId: string, items: PendingItem[]): void {
    ensureDir(this.dir);
    const target = this.fileFor(sessionId);
    if (items.length === 0) {
      try {
        unlinkSync(target);
      } catch {
        // already gone
      }
      return;
    }
    const payload: PendingFile = { sessionId, items };
    const temp = `${target}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    renameSync(temp, target);
  }

  read(sessionId: string): PendingItem[] {
    return this.readFile(sessionId);
  }

  /** Queues one message; a later message for the same draft supersedes the earlier one downstream. */
  queue(sessionId: string, text: string): { queuedAt: string; pending: number } {
    const queuedAt = new Date(this.now()).toISOString();
    const items = this.readFile(sessionId);
    items.push({ id: `${this.now()}-${items.length}`, text, queuedAt });
    this.writeFile(sessionId, items);
    return { queuedAt, pending: items.length };
  }

  /** Removes and returns everything waiting, in the order it was queued. */
  consume(sessionId: string): PendingItem[] {
    const items = this.readFile(sessionId);
    if (items.length > 0) this.writeFile(sessionId, []);
    return items;
  }

  /** Sessions with something waiting, for the panel's header and the diagnostics log. */
  summary(): PendingSummary[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: PendingSummary[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      let sessionId: string;
      try {
        sessionId = decodeURIComponent(name.slice(0, -'.json'.length));
      } catch {
        continue;
      }
      const items = this.readFile(sessionId);
      if (items.length === 0) continue;
      out.push({ sessionId, count: items.length, queuedAt: items[0]?.queuedAt ?? new Date(this.now()).toISOString() });
    }
    return out;
  }
}
