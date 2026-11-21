import type { StreamFrame } from './protocol';
import type { Transport } from './adapter';

/**
 * Browser transport: `fetch` for reads and writes, `EventSource` for pushes.
 *
 * No CORS is involved — the hub serves this page, so every request is same-origin. The
 * `x-draft-canvas-request` header makes the hub refuse a bare `POST` from a page that is not the
 * panel (a cross-origin page would need a preflight, and the hub answers none).
 */
export class HttpTransport implements Transport {
  constructor(private readonly base: string = '') {}

  async get(path: string): Promise<unknown> {
    return this.request(path, { method: 'GET' });
  }

  async post(path: string, body?: unknown): Promise<unknown> {
    return this.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  }

  stream(
    onFrame: (frame: StreamFrame) => void,
    onState: (state: 'connected' | 'reconnecting' | 'disconnected') => void,
  ): () => void {
    if (typeof EventSource !== 'function') {
      throw new Error('this browser has no EventSource; the panel needs live updates from the hub');
    }
    const source = new EventSource(`${this.base}/api/events`);
    source.onopen = () => onState('connected');
    // EventSource reconnects by itself; the panel only needs to know it is currently behind.
    source.onerror = () => onState('reconnecting');
    source.onmessage = (event: MessageEvent<string>) => {
      let frame: unknown;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      if (typeof frame === 'object' && frame !== null && 'type' in frame) onFrame(frame as StreamFrame);
    };
    return () => {
      source.close();
      onState('disconnected');
    };
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        ...init,
        headers: { 'x-draft-canvas-request': '1', ...(init.headers ?? {}) },
        cache: 'no-store',
      });
    } catch (err) {
      // Chrome says "Failed to fetch" when the hub is gone; keep the message but add what it means.
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`hub unreachable (${detail}). Is "draft-canvas-wb start" still running?`);
    }
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const body: unknown = await response.json();
        if (typeof body === 'object' && body !== null && 'error' in body) {
          const error = (body as { error?: { message?: unknown } }).error;
          if (typeof error?.message === 'string') message = error.message;
        }
      } catch {
        // keep the status text
      }
      throw new Error(message);
    }
    const text = await response.text();
    if (text === '') return {};
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }
}
