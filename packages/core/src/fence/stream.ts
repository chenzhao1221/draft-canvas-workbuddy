import { normalizeEol } from '../text';
import { parseDraftFences } from './parse';

/** Read-only preview of a draft fence in a message that is still streaming. Never a version. */
export interface StreamPreview {
  messageId: string;
  draftId: string;
  title?: string;
  lang: string;
  body: string;
  /** true once the closing fence line has been received in full. */
  closed: boolean;
  /** 0-based index among the draft fences seen so far in the message. */
  fenceIndex: number;
}

interface Entry {
  /** Raw text received so far. */
  raw: string;
  /** Previews computed from the complete lines of `raw`. */
  previews: StreamPreview[];
}

/**
 * Accumulates `assistant_chunk` deltas per message and reports draft previews
 * (ADAPTER_INTERFACE section 6). Only complete lines are scanned, so a fence
 * marker that is still arriving never shows up half-written. The tracker never
 * commits anything: committing is `applyAssistantMessage`'s job at `assistant_done`.
 */
export class StreamTracker {
  private readonly entries = new Map<string, Entry>();

  /** Appends `delta` to the message buffer and returns the current previews. */
  push(messageId: string, delta: string): StreamPreview[] {
    let entry = this.entries.get(messageId);
    if (entry === undefined) {
      entry = { raw: '', previews: [] };
      this.entries.set(messageId, entry);
    }
    entry.raw += delta;
    // New previews can only appear or change once a line is complete.
    if (delta.includes('\n') || delta.includes('\r')) entry.previews = this.scan(messageId, entry.raw);
    return entry.previews;
  }

  /** Current previews of a message; empty if the message is unknown. */
  previews(messageId: string): StreamPreview[] {
    return this.entries.get(messageId)?.previews ?? [];
  }

  /** The text received so far for a message. */
  text(messageId: string): string {
    return this.entries.get(messageId)?.raw ?? '';
  }

  has(messageId: string): boolean {
    return this.entries.has(messageId);
  }

  /** Ids of messages currently streaming, oldest first. */
  messageIds(): string[] {
    return [...this.entries.keys()];
  }

  /** Forgets a message (on `assistant_done` or an abandoned stream). */
  end(messageId: string): void {
    this.entries.delete(messageId);
  }

  clear(): void {
    this.entries.clear();
  }

  private scan(messageId: string, raw: string): StreamPreview[] {
    const text = normalizeEol(raw);
    const cut = text.lastIndexOf('\n');
    if (cut < 0) return [];
    // Keep the trailing newline so that the last complete line is complete.
    const complete = text.slice(0, cut + 1);
    const lastById = new Map<string, StreamPreview>();
    for (const fence of parseDraftFences(complete)) {
      const preview: StreamPreview = {
        messageId,
        draftId: fence.id,
        lang: fence.lang,
        body: fence.body,
        closed: fence.closed,
        fenceIndex: fence.fenceIndex,
      };
      if (fence.title !== undefined) preview.title = fence.title;
      lastById.delete(fence.id); // last fence of an id wins, ordered by position
      lastById.set(fence.id, preview);
    }
    return [...lastById.values()];
  }
}
