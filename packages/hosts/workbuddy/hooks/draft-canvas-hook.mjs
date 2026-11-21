#!/usr/bin/env node
/**
 * Draft Canvas hook for WorkBuddy / CodeBuddy Code.
 *
 * Registered for `SessionStart`, `UserPromptSubmit`, `Stop` and `SessionEnd`. It does two things and
 * never blocks a turn:
 *
 * 1. `UserPromptSubmit`: if the panel queued a changelog message, print it as `additionalContext`
 *    and mark it consumed. This is what "发给 AI" does on WorkBuddy — the text reaches the model for
 *    that turn but stays out of the stored user message (`fidelity: 'context-only'`).
 * 2. every event: tell the local hub that something happened, so the open panel refreshes at once
 *    instead of waiting for its 5-second timer.
 *
 * Everything is best-effort: no hub, no queue, bad JSON — it exits 0 without a word. A hook that
 * fails must never cost the user their message.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';

const TIMEOUT_MS = 700;

/** Same three rules as `paths.ts`; keep in step. */
function stateDir() {
  const explicit = process.env.DRAFT_CANVAS_STATE;
  if (explicit !== undefined && explicit !== '') {
    return explicit.replace(/^~(?=$|[\\/])/, homedir());
  }
  const wanted = process.env.DRAFT_CANVAS_HOST;
  const homes = [];
  if (wanted === 'workbuddy' || wanted === 'codebuddy') homes.push(`.${wanted}`);
  else homes.push('.workbuddy', '.codebuddy');
  for (const name of homes) {
    const home = join(homedir(), name);
    if (existsSync(home)) return join(home, 'draft-canvas');
  }
  return join(homedir(), '.workbuddy', 'draft-canvas');
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const PENDING_DIR = 'pending';

/**
 * Pops the queued messages for this session. The file is rewritten atomically before anything is
 * printed, so a hook killed mid-way cannot deliver the same edits twice.
 */
function takePending(dir, sessionId) {
  const file = join(dir, PENDING_DIR, `${encodeURIComponent(sessionId)}.json`);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  let items = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.items)) items = parsed.items.filter((item) => typeof item?.text === 'string' && item.text.trim() !== '');
  } catch {
    items = [];
  }
  if (items.length === 0) return [];
  try {
    unlinkSync(file);
  } catch {
    try {
      writeFileSync(file, `${JSON.stringify({ sessionId, items: [] }, null, 2)}\n`, 'utf8');
    } catch {
      // nothing else to do; the 30-minute expiry in the hub covers this
    }
  }
  return items;
}

function wrap(fences) {
  return [
    '下面这段内容是用户在 Draft Canvas 面板里做的修改和意见，不在聊天记录里。请按顺序处理：',
    '1) 先把每个 draft-changelog 套用到它写的 from 版本上（多个同 id 的，以最后一条为准）；',
    '2) 再按 draft-rewrite 的意见改被选中的那段；',
    '3) 最后回一个完整的 draft 块：同一个 id、写全文、不要片段、不要 diff。',
    '（English: user edits from the Draft Canvas panel are below. Apply the changelogs to version `from`, then the rewrite requests, then reply with one complete `draft` fence per id.）',
    '',
    fences,
  ].join('\n');
}

function notifyHub(dir, payload) {
  const hubFile = join(dir, 'hub.json');
  let port;
  try {
    port = JSON.parse(readFileSync(hubFile, 'utf8')).port;
  } catch {
    return;
  }
  if (typeof port !== 'number') return;
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const req = request(
    {
      host: '127.0.0.1',
      port,
      path: '/api/hook',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': body.length, 'x-draft-canvas-request': '1' },
      timeout: TIMEOUT_MS,
    },
    (res) => {
      res.resume();
    },
  );
  req.on('error', () => undefined);
  req.on('timeout', () => req.destroy());
  req.end(body);
}

function main() {
  const raw = readStdin();
  if (raw.trim() === '') return;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  const event = typeof payload?.hook_event_name === 'string' ? payload.hook_event_name : '';
  const sessionId = typeof payload?.session_id === 'string' ? payload.session_id : '';
  if (sessionId === '') return;
  const dir = stateDir();

  let injected = false;
  if (event === 'UserPromptSubmit') {
    const items = takePending(dir, sessionId);
    if (items.length > 0) {
      injected = true;
      const context = wrap(items.map((item) => item.text).join('\n\n'));
      process.stdout.write(
        `${JSON.stringify({
          suppressOutput: true,
          hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
        })}\n`,
      );
    }
  }

  notifyHub(dir, {
    session_id: sessionId,
    transcript_path: payload?.transcript_path,
    cwd: payload?.cwd,
    hook_event_name: event,
    permission_mode: payload?.permission_mode,
    generation_id: payload?.generation_id,
    prompt: payload?.prompt,
    source: payload?.source,
    reason: payload?.reason,
    injected,
  });
}

try {
  main();
} catch {
  // never fail a turn
}
process.exitCode = 0;
