import { closeSync, openSync, readSync, statSync } from 'node:fs';
import type { Message } from '@draft-canvas/core';
import { mapRecord, parseTranscript } from './transcript';

/**
 * Follows one transcript file and turns the tail into host events.
 *
 * WorkBuddy has no streaming API for a panel, so this reads the JSONL the host writes. Two things
 * make that usable:
 *
 * - `Stop` / `UserPromptSubmit` hook payloads call `pollSoon()`, so a finished reply is picked up
 *   within a few hundred milliseconds instead of on the next timer tick;
 * - a message that keeps growing is announced as `assistant_chunk` (read-only preview) and settled
 *   into `assistant_done` once it stops growing — core never commits a version from a chunk.
 */
export interface TailerHandlers {
  userMessage(message: Message): void;
  assistantChunk(messageId: string, delta: string): void;
  assistantDone(message: Message): void;
  /** The file was replaced or truncated: everything must be re-read. */
  reset(): void;
}

/** A growing assistant message becomes final after this long without new text. */
const SETTLE_MS = 900;

export class TranscriptTailer {
  private offset = 0;
  private pending = Buffer.alloc(0);
  private lineIndex = 0;
  private order: Message[] = [];
  private byId = new Map<string, Message>();
  private announced = new Set<string>();
  private growing: { id: string; at: number } | null = null;
  private gone = false;
  private windowed = false;

  constructor(
    readonly transcriptPath: string,
    private readonly sessionId: string,
    private readonly handlers: TailerHandlers,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get messages(): Message[] {
    return this.order;
  }

  /** `window` once a compaction marker was seen: older versions may be missing. */
  get completeness(): 'full' | 'window' {
    return this.windowed ? 'window' : 'full';
  }

  get lastReadError(): string | undefined {
    return this.gone ? 'transcript not readable' : undefined;
  }

  /** Reads the whole file and marks every complete message as already announced. */
  loadAll(): void {
    let raw = '';
    try {
      raw = readFileFully(this.transcriptPath);
      this.gone = false;
    } catch {
      this.gone = true;
    }
    const parsed = parseTranscript(raw, this.sessionId);
    this.windowed = parsed.completeness === 'window';
    this.order = parsed.messages;
    this.byId = new Map(parsed.messages.map((m) => [m.id, m]));
    this.announced = new Set(parsed.messages.filter((m) => m.complete).map((m) => m.id));
    this.lineIndex = parsed.lines;
    this.offset = Buffer.byteLength(raw, 'utf8');
    this.pending = Buffer.alloc(0);
    this.growing = null;
  }

  /** Reads bytes appended since the last poll and emits one event per new or changed message. */
  poll(): void {
    let size: number;
    try {
      size = statSync(this.transcriptPath).size;
    } catch {
      if (!this.gone) {
        this.gone = true;
        this.handlers.reset();
      }
      return;
    }
    if (size < this.offset) {
      // Truncated or replaced (compaction, session rewrite): start over.
      this.handlers.reset();
      this.loadAll();
      return;
    }
    if (size > this.offset) {
      const added = Buffer.alloc(size - this.offset);
      let fd: number | undefined;
      try {
        fd = openSync(this.transcriptPath, 'r');
        readSync(fd, added, 0, added.length, this.offset);
      } catch {
        this.gone = true;
        return;
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
      this.gone = false;
      this.offset = size;
      const chunk = Buffer.concat([this.pending, added]);
      const end = chunk.lastIndexOf(0x0a);
      if (end === -1) {
        this.pending = chunk;
      } else {
        this.pending = chunk.subarray(end + 1);
        const text = chunk.subarray(0, end + 1).toString('utf8');
        for (const line of text.split('\n')) {
          if (line.trim() === '') continue;
          let entry: unknown;
          try {
            entry = JSON.parse(line);
          } catch {
            this.lineIndex += 1;
            continue;
          }
          const message = mapRecord(entry, this.lineIndex, this.sessionId);
          this.lineIndex += 1;
          if (message !== undefined) this.accept(message);
        }
      }
    }
    this.settleIfQuiet();
  }

  private accept(message: Message): void {
    const known = this.byId.get(message.id);
    if (known === undefined) {
      this.byId.set(message.id, message);
      this.order.push(message);
      if (message.role === 'assistant') {
        if (message.complete) {
          this.announced.add(message.id);
          this.handlers.assistantDone(message);
        } else {
          this.growing = { id: message.id, at: this.now() };
        }
      } else if (message.role === 'user') {
        this.handlers.userMessage(message);
      }
      return;
    }
    if (known.text === message.text) {
      known.complete = message.complete;
      return;
    }
    const previous = known.text;
    known.text = message.text;
    known.complete = message.complete;
    if (message.role !== 'assistant') return;
    if (message.text.startsWith(previous)) {
      // Pure append: preview the new text, then settle into `assistant_done` when it stops growing.
      this.handlers.assistantChunk(message.id, message.text.slice(previous.length));
      this.growing = { id: message.id, at: this.now() };
      return;
    }
    // Rewritten in place (an edit, an undo): announce it again so core rebuilds from the new text.
    this.announced.add(message.id);
    this.growing = null;
    this.handlers.assistantDone(message);
  }

  private settleIfQuiet(): void {
    const growing = this.growing;
    if (growing === null) return;
    if (this.now() - growing.at < SETTLE_MS) return;
    const message = this.byId.get(growing.id);
    this.growing = null;
    if (message === undefined) return;
    // A message that grew after it was already announced is announced again with the fuller text;
    // core keeps the message id, sees different text and rebuilds. The flag only stops a message
    // that was never growing from being announced here.
    this.announced.add(message.id);
    this.handlers.assistantDone({ ...message, complete: true });
  }
}

function readFileFully(path: string): string {
  const size = statSync(path).size;
  const buffer = Buffer.alloc(size);
  const fd = openSync(path, 'r');
  try {
    let read = 0;
    while (read < size) {
      const n = readSync(fd, buffer, read, size - read, read);
      if (n <= 0) break;
      read += n;
    }
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}
