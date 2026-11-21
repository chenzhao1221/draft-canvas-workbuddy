import type { HistoryCompleteness, Message } from '@draft-canvas/core';

/**
 * Wire types of the local hub (ADAPTER_INTERFACE section 5, WorkBuddy host).
 *
 * The panel is a browser page served by the hub, so everything the adapter needs travels over
 * loopback HTTP: REST for reads and writes, Server-Sent Events for pushes. Types here are shared by
 * the browser adapter and the Node hub, and contain no DOM or Node API.
 */

/** Bumped when a route changes shape; the panel refuses a hub it does not understand. */
export const HUB_PROTOCOL_VERSION = '1';

/** Version of this host package, shown by the panel's Diagnostics button. */
export const ADAPTER_VERSION = '0.1.0';

export const HOST_ID = 'workbuddy';
export const HOST_DISPLAY_NAME = 'WorkBuddy';

export interface SessionSummary {
  sessionId: string;
  title?: string;
  /** ISO 8601 of the last activity the hub knows about (hook event or transcript mtime). */
  updatedAt?: string;
  /** False when the hub knows the session from a hook but cannot read its transcript. */
  transcript?: boolean;
}

export interface PendingSummary {
  sessionId: string;
  count: number;
  /** ISO 8601 of the oldest queued message. */
  queuedAt: string;
}

export interface HubInfo {
  protocol: string;
  hubVersion: string;
  host: {
    id: string;
    displayName: string;
    /** `~/.workbuddy` or `~/.codebuddy`, whichever the hub is watching. */
    home: string;
    settingsPath: string;
    /** True when the Draft Canvas hooks are registered in `settingsPath`. */
    hooksInstalled: boolean;
  };
  sessions: SessionSummary[];
  activeSessionId: string | null;
  /** False when the hooks are not installed: the panel then warns that pushes may not arrive. */
  liveUpdates: boolean;
  pending: PendingSummary[];
  /** Set when the hub runs in demo mode (`simulate`); the panel shows it in Diagnostics. */
  demo?: boolean;
}

export interface HistoryBody {
  messages: Message[];
  completeness: HistoryCompleteness;
  /** Where the messages came from; `none` means the transcript could not be read. */
  source: 'transcript' | 'none';
  /** Short, non-secret explanation for the panel and the diagnostics log. */
  note?: string;
}

export interface InjectBody {
  ok: true;
  sessionId: string;
  queuedAt: string;
  /** How many messages now wait for the user's next turn. */
  pending: number;
  note: string;
}

export interface HookBody {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  permission_mode?: string;
  generation_id?: string;
  prompt?: string;
  reason?: string;
  source?: string;
  /** Set by the hook script: whether it injected a pending message into this turn. */
  injected?: boolean;
}

export interface HookReply {
  ok: true;
  /** Echoed for the hook's log; the hook prints its own JSON. */
  injected?: boolean;
}

export interface ErrorBody {
  error: { code: string; message: string };
}

/** One SSE frame. `host` carries a `HostEvent` verbatim. */
export type StreamFrame =
  | { type: 'host'; event: unknown }
  | { type: 'sessions'; activeSessionId: string | null; sessions: SessionSummary[] }
  | { type: 'hello'; info: HubInfo };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function pickString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}
