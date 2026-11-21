import type { HistoryCompleteness, Message, MessageRole } from '@draft-canvas/core';

/**
 * Transcript → `Message[]` (ADAPTER_INTERFACE sections 9 and 13).
 *
 * WorkBuddy / CodeBuddy Code keep one JSONL file per session (`transcript_path` in every hook
 * payload). The writer is a host detail that is **not** documented, so this parser is deliberately
 * tolerant: it accepts the record shapes the host is known to write and ignores anything it cannot
 * map to a chat message. `scripts/dc-wb doctor` prints what it actually saw, so the mapping can be
 * checked against a real file without reading drafts by hand.
 *
 * Deliberate deviations from section 9.1, both recorded in `docs/hosts/workbuddy.md`:
 * - host-internal records (`type: "system"`, summaries, snapshots) are not returned: core ignores
 *   system and tool messages anyway, and the panel re-reads the whole history every few seconds, so
 *   shipping multi-kilobyte system prompts would only slow it down;
 * - `<system-reminder>…</system-reminder>` blocks that the host splices into user messages are
 *   removed, because they are host context, not something the user typed.
 */

export interface ParsedTranscript {
  messages: Message[];
  completeness: HistoryCompleteness;
  /** Lines in the file. */
  lines: number;
  /** Lines that became a message. */
  usable: number;
  /** Lines skipped: unparsable JSON, unknown shape, no text, or a host-internal record. */
  skipped: number;
  /** True when a compaction marker was seen: older messages may be gone. */
  windowed: boolean;
  /** Record types seen, for `doctor`. Values only, never text. */
  shapes: string[];
}

export interface ParseOptions {
  /** Timestamp to use for a record that has none. */
  fallbackTime?: (id: string) => string;
}

const TEXT_BLOCK_TYPES = new Set(['text', 'input_text', 'output_text', 'markdown']);
const NON_TEXT_BLOCK_TYPES = new Set([
  'tool_use',
  'tool_result',
  'thinking',
  'redacted_thinking',
  'image',
  'document',
  'server_tool_use',
  'web_search_tool_result',
  'search_result',
]);
const SKIP_RECORD_TYPES = new Set([
  'system',
  'summary',
  'compact_boundary',
  'file-history-snapshot',
  'queue-operation',
  'result',
  'function_call',
  'function_call_output',
  'tool',
  'tool_result',
]);
const ROLE_OF_TYPE: Record<string, MessageRole> = {
  user: 'user',
  assistant: 'assistant',
  system: 'system',
  tool: 'tool',
};

const SYSTEM_REMINDER = /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>\s*/gi;
const LOCAL_COMMAND = /<local-command-(?:stdout|stderr)>[\s\S]*?<\/local-command-(?:stdout|stderr)>\s*/gi;
const TASK_NOTIFICATION = /<task-notification\b[^>]*>[\s\S]*?<\/task-notification>\s*/gi;
const USER_QUERY = /^\s*<user_query\b[^>]*>([\s\S]*?)<\/user_query>\s*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Removes host-injected blocks from text the user "typed". */
export function stripInjected(text: string): string {
  return text.replace(SYSTEM_REMINDER, '').replace(LOCAL_COMMAND, '').replace(TASK_NOTIFICATION, '');
}

/**
 * WorkBuddy wraps the message the user typed in `<user_query>…</user_query>`. The wrapper is host
 * markup, so the panel and the changelog parser should see what the user actually wrote.
 */
export function unwrapUserQuery(text: string): string {
  const match = USER_QUERY.exec(text);
  return match === null ? text : (match[1] ?? '');
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** Pulls the visible text out of a `content` field (string or block array). */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (!isRecord(block)) continue;
    const type = typeof block.type === 'string' ? block.type : '';
    if (NON_TEXT_BLOCK_TYPES.has(type)) continue;
    if (typeof block.text === 'string') {
      parts.push(block.text);
      continue;
    }
    if (TEXT_BLOCK_TYPES.has(type) && typeof block.content === 'string') parts.push(block.content);
  }
  return parts.join('\n');
}

function textOfRecord(entry: Record<string, unknown>): string {
  for (const holder of [entry, entry.message, entry.payload]) {
    if (!isRecord(holder)) continue;
    const fromContent = textOfContent(holder.content);
    if (fromContent.trim() !== '') return fromContent;
    for (const key of ['text', 'delta']) {
      const value = holder[key];
      if (typeof value === 'string' && value.trim() !== '') return value;
    }
  }
  return '';
}

function roleOfRecord(entry: Record<string, unknown>): MessageRole | undefined {
  for (const holder of [entry, entry.message, entry.payload]) {
    if (!isRecord(holder)) continue;
    const role = holder.role;
    if (typeof role === 'string') {
      const known = ROLE_OF_TYPE[role.toLowerCase()];
      if (known !== undefined) return known;
    }
    const type = holder.type;
    if (typeof type === 'string') {
      const known = ROLE_OF_TYPE[type.toLowerCase()];
      if (known !== undefined) return known;
    }
  }
  return undefined;
}

function recordType(entry: Record<string, unknown>): string {
  for (const holder of [entry, entry.message, entry.payload]) {
    if (!isRecord(holder)) continue;
    const type = holder.type;
    if (typeof type === 'string' && type !== '') return type;
  }
  return '';
}

function timestampOfRecord(entry: Record<string, unknown>): string | undefined {
  for (const holder of [entry, entry.message, entry.payload]) {
    if (!isRecord(holder)) continue;
    for (const key of ['timestamp', 'createdAt', 'created_at', 'ts', 'time']) {
      const value = holder[key];
      if (typeof value === 'string' && value !== '') {
        const parsed = Date.parse(value);
        if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
        return value;
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        const ms = value < 1e12 ? value * 1000 : value;
        return new Date(ms).toISOString();
      }
    }
  }
  return undefined;
}

function idOfRecord(entry: Record<string, unknown>): string | undefined {
  for (const holder of [entry, entry.message, entry.payload]) {
    if (!isRecord(holder)) continue;
    for (const key of ['uuid', 'id', 'messageId', 'message_id']) {
      const value = holder[key];
      if (typeof value === 'string' && value !== '') return value;
    }
  }
  return undefined;
}

/**
 * `false` only when the record says the assistant message is still being written. The default is
 * `true`: reporting a finished message as incomplete would hide it from the rebuild forever, while
 * the opposite only risks committing a fence that is not closed yet (which core refuses anyway).
 */
function completeOfRecord(entry: Record<string, unknown>): boolean {
  for (const holder of [entry, entry.message, entry.payload]) {
    if (!isRecord(holder)) continue;
    if (holder.complete === false) return false;
    if (holder.partial === true) return false;
    const type = holder.type;
    if (type === 'assistant_delta' || type === 'assistant-delta' || type === 'stream_delta') return false;
  }
  return true;
}

function isMetaRecord(entry: Record<string, unknown>): boolean {
  for (const holder of [entry, entry.message]) {
    if (!isRecord(holder)) continue;
    if (holder.isMeta === true || holder.isSidechain === true || holder.isCompactSummary === true) return true;
    if (holder.isApiErrorMessage === true) return true;
  }
  return false;
}

/** Maps one JSONL record, or `undefined` when it is not a chat message. */
export function mapRecord(
  entry: unknown,
  index: number,
  sessionId: string,
  options: ParseOptions = {},
): Message | undefined {
  if (!isRecord(entry)) return undefined;
  if (isMetaRecord(entry)) return undefined;
  const type = recordType(entry);
  if (SKIP_RECORD_TYPES.has(type.toLowerCase())) return undefined;
  const role = roleOfRecord(entry);
  if (role === undefined) return undefined;
  let text = normalizeNewlines(textOfRecord(entry));
  if (role === 'user') text = unwrapUserQuery(stripInjected(text));
  text = text.replace(/\s+$/, '');
  if (text.trim() === '') return undefined;
  const id = idOfRecord(entry) ?? `${sessionId}:${index}`;
  const createdAt = timestampOfRecord(entry) ?? options.fallbackTime?.(id) ?? new Date().toISOString();
  return { id, sessionId, role, text, createdAt, complete: completeOfRecord(entry) };
}

/** Parses a whole transcript file. Unparsable lines are counted, never thrown on. */export function parseTranscript(raw: string, sessionId: string, options: ParseOptions = {}): ParsedTranscript {
  const lines = normalizeNewlines(raw).split('\n');
  const messages: Message[] = [];
  const byId = new Map<string, number>();
  const shapes = new Set<string>();
  let skipped = 0;
  let windowed = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() === '') {
      skipped += 1;
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    if (isRecord(entry)) {
      const type = recordType(entry) || 'unknown';
      if (shapes.size < 12) shapes.add(type);
      if (entry.isCompactSummary === true || type === 'compact_boundary') windowed = true;
    }
    const message = mapRecord(entry, index, sessionId, options);
    if (message === undefined) {
      skipped += 1;
      continue;
    }
    const seen = byId.get(message.id);
    if (seen !== undefined) {
      // The same id written twice (a rewrite or an append): the later text wins, order stays.
      messages[seen] = message;
      continue;
    }
    byId.set(message.id, messages.length);
    messages.push(message);
  }

  return {
    messages,
    // A file that starts with a compaction marker no longer holds the beginning of the chat.
    completeness: windowed ? 'window' : 'full',
    lines: lines.length,
    usable: messages.length,
    skipped,
    windowed,
    shapes: [...shapes],
  };
}


/** One level of shape detail: `key:type(len)` plus the keys of a nested object. No values. */
function describeValue(value: unknown): string {
  if (typeof value === 'string') return `string(${value.length})`;
  if (Array.isArray(value)) {
    const first = value[0];
    const inner = isRecord(first) ? Object.keys(first).slice(0, 6).join('/') : typeof first;
    return `array(${value.length})[${inner}]`;
  }
  if (isRecord(value)) return `object{${Object.keys(value).slice(0, 10).join(',')}}`;
  return typeof value;
}

export interface RecordShape {
  /** `type` of the record, or `?` when it has none. */
  type: string;
  count: number;
  /** Top-level keys of the first record of this shape. */
  keys: string[];
  role?: string;
  /** Block `type` values inside `content`, e.g. `text`, `tool_use`. */
  blockTypes: string[];
  /** Length of the text this parser would extract. Never the text itself. */
  textLength: number;
  /** Whether one such record became a message. */
  mapped: boolean;
  /** `key:type(length)` of every top-level field of the first record. Never values. */
  detail: string[];
}

/**
 * Summarises the record shapes of a transcript **without any text**, so `doctor` can show what the
 * host actually writes and why a record was or was not mapped. Values never leave the machine.
 */
export function inspectRecords(raw: string, sessionId = 'inspect', limit = 8): RecordShape[] {
  const shapes = new Map<string, RecordShape>();
  const lines = normalizeNewlines(raw).split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() === '') continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry)) continue;
    const type = recordType(entry) || '?';
    const mapped = mapRecord(entry, index, sessionId) !== undefined;
    const existing = shapes.get(type);
    if (existing !== undefined) {
      existing.count += 1;
      continue;
    }
    if (shapes.size >= limit) continue;
    const blocks: string[] = [];
    for (const holder of [entry, entry.message, entry.payload]) {
      if (!isRecord(holder) || !Array.isArray(holder.content)) continue;
      for (const block of holder.content) {
        if (isRecord(block) && typeof block.type === 'string') blocks.push(block.type);
        else if (typeof block === 'string') blocks.push('(string)');
      }
      break;
    }
    const role = roleOfRecord(entry);
    shapes.set(type, {
      type,
      count: 1,
      keys: Object.keys(entry).slice(0, 12),
      ...(role !== undefined ? { role } : {}),
      blockTypes: [...new Set(blocks)],
      textLength: normalizeNewlines(textOfRecord(entry)).length,
      mapped,
      detail: Object.entries(entry).map(([key, value]) => `${key}:${describeValue(value)}`),
    });
  }
  return [...shapes.values()];
}
