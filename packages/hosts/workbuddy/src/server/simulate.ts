import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir } from './paths';
import type { DemoAgent } from './hub';

/**
 * `simulate` mode: a fake host that behaves like the real one where it matters.
 *
 * It does exactly what a real WorkBuddy chat plus a well-behaved agent does:
 * 1. the user's message lands in the session transcript (`type: "message"`, `role: "user"`);
 * 2. the agent publishes the draft body to `<state>/drafts/current/<id>.md`.
 *
 * It deliberately writes **no** assistant message to the transcript: the real host does not either
 * (see `sink.ts`), so a simulator that did would hide the bug this project actually has to solve.
 */
export interface DemoOptions {
  /** Folder for the fake transcript, usually `<state>/demo`. */
  dir: string;
  /** Draft sink folder, usually `<state>/drafts`. */
  draftsDir: string;
  sessionId?: string;
  log?: (line: string) => void;
}

export interface Demo {
  agent: DemoAgent;
  sessionId: string;
  transcriptPath: string;
  /** Writes the opening draft, so the panel has something to show. */
  seed(): void;
}

const DRAFT_ID = 'trip-note';
const OPENING = [
  '<!-- title: 出发前 -->',
  '# 出发前',
  '',
  '我们明天一早出发，去海边住两晚。',
  '',
  '行李清单：换洗衣服、防晒、充电宝。',
  '',
  '回程那天下雨也没关系，正好在家睡一天。',
].join('\n');

let counter = 0;

function userRecord(text: string, sessionId: string): string {
  counter += 1;
  return `${JSON.stringify({
    type: 'user',
    uuid: `${sessionId}-${counter}`,
    sessionId,
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: text },
  })}\n`;
}

/** Applies the SEARCH/REPLACE blocks of every `draft-changelog` fence in `text`. */
export function applyChangelogs(body: string, text: string): string {
  let next = body;
  const fenceRe = /```+draft-changelog[^\n]*\n([\s\S]*?)\n```+/g;
  for (const match of text.matchAll(fenceRe)) {
    const patch = match[1] ?? '';
    const blockRe = /<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g;
    for (const block of patch.matchAll(blockRe)) {
      const search = block[1] ?? '';
      const replace = block[2] ?? '';
      if (search !== '' && next.includes(search)) next = next.replace(search, replace);
    }
  }
  return next;
}

/** Applies each `draft-rewrite` fence: the selection gets the instruction, visibly. */
export function applyRewrites(body: string, text: string): string {
  let next = body;
  const fenceRe = /```+draft-rewrite[^\n]*\n([\s\S]*?)\n```+\n+([^\n]+)/g;
  for (const match of text.matchAll(fenceRe)) {
    const selection = match[1] ?? '';
    const instruction = (match[2] ?? '').trim();
    if (selection === '' || !next.includes(selection)) continue;
    next = next.replace(selection, `${selection}（按要求改写：${instruction}）`);
  }
  return next;
}

export function createDemo(options: DemoOptions): Demo {
  ensureDir(options.dir);
  const sinkDir = join(options.draftsDir, 'current');
  mkdirSync(sinkDir, { recursive: true });
  const sessionId = options.sessionId ?? `demo-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  const transcriptPath = join(options.dir, `${sessionId}.jsonl`);
  const sinkFile = join(sinkDir, `${DRAFT_ID}.md`);
  let body = stripTitle(OPENING);

  const publish = (next: string): void => {
    writeFileSync(sinkFile, next, 'utf8');
  };

  const seed = (): void => {
    body = stripTitle(OPENING);
    writeFileSync(transcriptPath, '', 'utf8');
    writeFileSync(sinkFile, '', 'utf8');
    appendFileSync(transcriptPath, userRecord('用 draft 块写一份周末去海边的出行草稿。', sessionId), 'utf8');
    publish(OPENING);
    options.log?.(`demo transcript: ${transcriptPath}`);
    options.log?.(`demo drafts: ${sinkFile}`);
  };

  const agent: DemoAgent = {
    handleTurn({ prompt, injected }) {
      appendFileSync(transcriptPath, userRecord(prompt, sessionId), 'utf8');
      let next = body;
      if (injected !== null) next = applyRewrites(applyChangelogs(next, injected), injected);
      body = next;
      // A moment later, as a model would: publish the new version of the draft.
      setTimeout(() => publish(`<!-- title: 出发前 -->\n${next}`), 400);
    },
  };

  return { agent, sessionId, transcriptPath, seed };
}

function stripTitle(text: string): string {
  return text.replace(/^<!--\s*title:[^>]*-->\n/, '');
}
