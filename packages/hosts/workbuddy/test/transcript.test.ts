import { describe, expect, it } from 'vitest';
import { rebuild } from '@draft-canvas/core';
import { mapRecord, parseTranscript, stripInjected } from '../src/server/transcript';
import { assistant, DRAFT_V1, DRAFT_V2, user } from './helpers';

const SESSION = 'sess-1';

describe('parseTranscript', () => {
  it('maps the CodeBuddy record shape', () => {
    const raw = [user('帮我写点东西', 'u1'), assistant(`好：\n\n${DRAFT_V1}`, 'a1')]
      .map((line) => JSON.stringify(line))
      .join('\n');
    const parsed = parseTranscript(raw, SESSION);
    expect(parsed.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(parsed.messages[0]?.text).toBe('帮我写点东西');
    expect(parsed.messages[1]?.id).toBe('a1');
    expect(parsed.messages[1]?.createdAt).toBe('2026-11-19T06:00:00.000Z');
    expect(parsed.messages.every((m) => m.complete)).toBe(true);
    expect(parsed.completeness).toBe('full');
  });

  it('lets core commit versions from the mapped messages', () => {
    const raw = [user('写', 'u1'), assistant(DRAFT_V1, 'a1'), user('改成第二版', 'u2'), assistant(DRAFT_V2, 'a2')]
      .map((line) => JSON.stringify(line))
      .join('\n');
    const parsed = parseTranscript(raw, SESSION);
    const rebuilt = rebuild(parsed.messages);
    expect(rebuilt.store.order).toEqual(['note']);
    expect(rebuilt.store.versions.get('note')?.map((v) => v.body)).toEqual(['第一版', '第二版']);
    expect(rebuilt.unclosed).toEqual([]);
  });

  it('skips tool results, meta records and host-internal records', () => {
    const lines = [
      { type: 'system', uuid: 's1', message: { role: 'system', content: 'a very long system prompt' } },
      { type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } },
      assistant('真正的话', 'a1'),
      { type: 'assistant', uuid: 'a2', isMeta: true, message: { role: 'assistant', content: [{ type: 'text', text: '内部' }] } },
      { type: 'summary', uuid: 'sum', summary: '…' },
      { type: 'file-history-snapshot', uuid: 'f1' },
    ];
    const parsed = parseTranscript(lines.map((line) => JSON.stringify(line)).join('\n'), SESSION);
    expect(parsed.messages.map((m) => m.text)).toEqual(['真正的话']);
    expect(parsed.skipped).toBeGreaterThanOrEqual(5);
  });

  it('reads a Codex-style response_item record', () => {
    const line = {
      type: 'response_item',
      timestamp: '2026-11-19T07:00:00.000Z',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: DRAFT_V1 }] },
    };
    const parsed = parseTranscript(JSON.stringify(line), SESSION);
    expect(parsed.messages[0]?.role).toBe('assistant');
    expect(parsed.messages[0]?.text).toBe(DRAFT_V1);
  });

  it('reads a flat {role, content} record', () => {
    const parsed = parseTranscript(JSON.stringify({ role: 'user', content: '扁平格式', uuid: 'f1' }), SESSION);
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]?.text).toBe('扁平格式');
  });

  it('counts an unparsable line instead of throwing', () => {
    const raw = ['{not json', JSON.stringify(user('好', 'u1'))].join('\n');
    const parsed = parseTranscript(raw, SESSION);
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.skipped).toBe(1);
  });

  it('keeps the last text of a repeated id in first position', () => {
    const raw = [assistant('前半', 'a1'), user('继续', 'u2'), assistant('前半 + 后半', 'a1')]
      .map((line) => JSON.stringify(line))
      .join('\n');
    const parsed = parseTranscript(raw, SESSION);
    expect(parsed.messages.map((m) => m.id)).toEqual(['a1', 'u2']);
    expect(parsed.messages[0]?.text).toBe('前半 + 后半');
  });

  it('derives a stable id from the position when the record has none', () => {
    const parsed = parseTranscript(JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' } }), 'abc');
    expect(parsed.messages[0]?.id).toBe('abc:0');
    const again = parseTranscript(JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' } }), 'abc');
    expect(again.messages[0]?.id).toBe('abc:0');
  });

  it('strips host-injected reminders from user text but keeps fences', () => {
    const text = '<system-reminder>host context</system-reminder>真实的话\n\n```draft-rewrite id="note" rev="1" start_line="1" end_line="1" start_offset="0" end_offset="1"\n第\n```\n改得口语点';
    const parsed = parseTranscript(JSON.stringify(user(text, 'u1')), SESSION);
    const mapped = parsed.messages[0]?.text ?? '';
    expect(mapped.startsWith('真实的话')).toBe(true);
    expect(mapped).toContain('```draft-rewrite');
    expect(mapped).toContain('改得口语点');
    expect(stripInjected('a<system-reminder>\nb\n</system-reminder>c')).toBe('ac');
  });

  it('respects an explicit "still writing" marker', () => {
    const record = assistant('写到一半', 'a1', { complete: false });
    expect(mapRecord(record, 0, SESSION)?.complete).toBe(false);
    const streamed = { type: 'assistant_delta', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } };
    expect(mapRecord(streamed, 1, SESSION)?.complete).toBe(false);
  });

  it('reports a window when a compaction marker is present', () => {
    const raw = [
      JSON.stringify({ type: 'compact_boundary', uuid: 'c1' }),
      JSON.stringify(assistant('压缩之后', 'a1')),
    ].join('\n');
    expect(parseTranscript(raw, SESSION).completeness).toBe('window');
  });

  it('accepts epoch timestamps and normalizes them', () => {
    const record = { type: 'user', uuid: 'u1', timestamp: 1763000000000, message: { role: 'user', content: 'x' } };
    expect(mapRecord(record, 0, SESSION)?.createdAt).toBe(new Date(1763000000000).toISOString());
  });

  it('normalizes CRLF', () => {
    const parsed = parseTranscript('{"type":"user","uuid":"u1","message":{"role":"user","content":"a\\r\\nb"}}', SESSION);
    expect(parsed.messages[0]?.text).toBe('a\nb');
  });
});
