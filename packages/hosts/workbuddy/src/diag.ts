/**
 * In-memory diagnostic log for the panel's "Diagnostics" button (same idea as the Kiro Crew host).
 * It records what happened — pushes received, re-reads, history reads, errors — never draft or
 * message text.
 */
const MAX_LINES = 200;
const lines: string[] = [];

function stamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function diag(line: string): void {
  const entry = `${stamp()} ${line}`;
  lines.push(entry);
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  // Also in the browser console: on a local panel this is the fastest way to see what the hub sent.
  console.info(`[draft-canvas] ${line}`);
}

export function diagText(header: string): string {
  return [header, ...lines].join('\n');
}

/** For tests. */
export function clearDiag(): void {
  lines.length = 0;
}
