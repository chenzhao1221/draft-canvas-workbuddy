import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A throwaway folder per test. */
export function tempDir(prefix = 'dc-wb-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function writeTranscript(path: string, lines: unknown[]): void {
  writeFileSync(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(''), 'utf8');
}

export function appendTranscript(path: string, line: unknown): void {
  appendFileSync(path, `${JSON.stringify(line)}\n`, 'utf8');
}

/** The record shape CodeBuddy Code / WorkBuddy is expected to write. */
export function assistant(text: string, id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'assistant',
    uuid: id,
    timestamp: '2026-11-19T06:00:00.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' },
    ...extra,
  };
}

export function user(text: string, id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'user',
    uuid: id,
    timestamp: '2026-11-19T06:00:01.000Z',
    message: { role: 'user', content: text },
    ...extra,
  };
}

export const DRAFT_V1 = '```draft id="note"\n第一版\n```';
export const DRAFT_V2 = '```draft id="note"\n第二版\n```';
