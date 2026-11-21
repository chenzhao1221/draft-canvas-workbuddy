import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TranscriptTailer } from '../src/server/tailer';
import { appendTranscript, assistant, DRAFT_V1, DRAFT_V2, tempDir, user, writeTranscript } from './helpers';

function setup(lines: unknown[]) {
  const dir = tempDir();
  const path = join(dir, 'session.jsonl');
  writeTranscript(path, lines);
  const events: string[] = [];
  const clock = { now: 1_000 };
  const tailer = new TranscriptTailer(
    path,
    'sess',
    {
      userMessage: (message) => events.push(`user:${message.text}`),
      assistantChunk: (id, delta) => events.push(`chunk:${id}:${delta}`),
      assistantDone: (message) => events.push(`done:${message.id}:${message.text}`),
      reset: () => events.push('reset'),
    },
    () => clock.now,
  );
  tailer.loadAll();
  return { path, tailer, events, clock };
}

describe('TranscriptTailer', () => {
  it('announces nothing for messages that were already there', () => {
    const { tailer, events } = setup([user('写点东西', 'u1'), assistant(DRAFT_V1, 'a1')]);
    expect(tailer.messages).toHaveLength(2);
    expect(events).toEqual([]);
    expect(tailer.completeness).toBe('full');
  });

  it('announces a new user message and a new assistant message', () => {
    const { path, tailer, events } = setup([user('写点东西', 'u1')]);
    appendTranscript(path, assistant(DRAFT_V1, 'a1'));
    tailer.poll();
    expect(events).toEqual([`done:a1:${DRAFT_V1}`]);
    appendTranscript(path, user('再改一下', 'u2'));
    tailer.poll();
    expect(events.at(-1)).toBe('user:再改一下');
  });

  it('previews a growing message as a chunk and settles it into one done', () => {
    const { path, tailer, events, clock } = setup([user('写', 'u1')]);
    appendTranscript(path, assistant('前半', 'a1'));
    tailer.poll();
    expect(events).toEqual(['done:a1:前半']);

    appendTranscript(path, assistant('前半后半', 'a1'));
    tailer.poll();
    expect(events.at(-1)).toBe('chunk:a1:后半');

    // Not quiet yet: nothing more happens.
    tailer.poll();
    expect(events.filter((event) => event.startsWith('done')).length).toBe(1);

    clock.now += 1_000;
    tailer.poll();
    expect(events.at(-1)).toBe('done:a1:前半后半');
  });

  it('re-reads everything when the file shrinks', () => {
    const { path, tailer, events } = setup([user('一', 'u1'), assistant(DRAFT_V1, 'a1'), assistant(DRAFT_V2, 'a2')]);
    // A shorter file can only mean a rewrite: start over rather than read from the middle.
    writeTranscript(path, [user('重来', 'u9')]);
    tailer.poll();
    expect(events).toContain('reset');
    expect(tailer.messages.map((message) => message.id)).toEqual(['u9']);
  });

  it('waits for the end of a line before using it', () => {
    const { path, tailer } = setup([user('一', 'u1')]);
    const full = `${JSON.stringify(assistant(DRAFT_V1, 'a1'))}\n`;
    appendFileSync(path, full.slice(0, 30), 'utf8');
    tailer.poll();
    expect(tailer.messages).toHaveLength(1);
    appendFileSync(path, full.slice(30), 'utf8');
    tailer.poll();
    expect(tailer.messages).toHaveLength(2);
  });
});
