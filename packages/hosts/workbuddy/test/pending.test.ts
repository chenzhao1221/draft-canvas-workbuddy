import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_AGE_MS, PendingQueue, pendingFileName } from '../src/server/pending';
import { tempDir } from './helpers';

describe('PendingQueue', () => {
  it('queues, reports and consumes in order', () => {
    const dir = tempDir();
    const queue = new PendingQueue(join(dir, 'pending'));
    expect(queue.queue('s1', 'first').pending).toBe(1);
    expect(queue.queue('s1', 'second').pending).toBe(2);
    expect(queue.read('s1').map((item) => item.text)).toEqual(['first', 'second']);
    const summary = queue.summary();
    expect(summary).toHaveLength(1);
    expect(summary[0]?.count).toBe(2);
    expect(queue.consume('s1').map((item) => item.text)).toEqual(['first', 'second']);
    expect(queue.read('s1')).toEqual([]);
    expect(queue.summary()).toEqual([]);
    // The file is gone once it is empty, so an uninstalled hub leaves nothing behind.
    expect(existsSync(join(dir, 'pending', pendingFileName('s1')))).toBe(false);
  });

  it('keys sessions separately, even with special characters in the id', () => {
    const dir = tempDir();
    const queue = new PendingQueue(join(dir, 'pending'));
    queue.queue('a/b:c', 'one');
    queue.queue('a', 'two');
    expect(queue.read('a/b:c').map((item) => item.text)).toEqual(['one']);
    expect(queue.read('a').map((item) => item.text)).toEqual(['two']);
  });

  it('drops a message older than 30 minutes', () => {
    const dir = tempDir();
    const clock = { now: 1_000_000 };
    const queue = new PendingQueue(join(dir, 'pending'), () => clock.now);
    queue.queue('s1', 'stale');
    clock.now += MAX_AGE_MS + 1;
    expect(queue.read('s1')).toEqual([]);
  });

  it('ignores a corrupt file instead of throwing', () => {
    const dir = tempDir();
    const pendingDir = join(dir, 'pending');
    mkdirSync(pendingDir, { recursive: true });
    const queue = new PendingQueue(pendingDir);
    writeFileSync(join(pendingDir, pendingFileName('s1')), '{oops', 'utf8');
    expect(queue.read('s1')).toEqual([]);
    queue.queue('s1', 'recovered');
    expect(JSON.parse(readFileSync(join(pendingDir, pendingFileName('s1')), 'utf8')).items).toHaveLength(1);
  });
});
