import { HostAdapterError, type WorkingCopy, type WorkingCopyStorage } from '@draft-canvas/core';

/** The part of the Web Storage interface this module uses. `window.localStorage` satisfies it. */
export interface KeyValueStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PREFIX = 'draft-canvas:v1:wc:';

/** Prefix shared by every working copy of a session: `draft-canvas:v1:wc:<enc(sessionId)>:`. */
export function sessionKeyPrefix(sessionId: string): string {
  return `${PREFIX}${encodeURIComponent(sessionId)}:`;
}

export function workingCopyKey(sessionId: string, draftId: string): string {
  return `${sessionKeyPrefix(sessionId)}${encodeURIComponent(draftId)}`;
}

function isWorkingCopy(value: unknown): value is WorkingCopy {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sessionId === 'string' &&
    typeof v.draftId === 'string' &&
    typeof v.baseVersion === 'number' &&
    Number.isInteger(v.baseVersion) &&
    typeof v.baseHash === 'string' &&
    typeof v.text === 'string' &&
    typeof v.updatedAt === 'string' &&
    (v.stagedHash === undefined || typeof v.stagedHash === 'string') &&
    (v.sentHash === undefined || typeof v.sentHash === 'string')
  );
}

function hostError(action: string, cause: unknown): HostAdapterError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new HostAdapterError('host_error', `Working-copy storage failed while trying to ${action}: ${detail}`, { cause });
}

/**
 * Working copies in the panel page's `localStorage` (ADAPTER_INTERFACE section 14.2).
 *
 * Best-effort by design: a corrupt record counts as missing, and a failing write (quota, private
 * mode) rejects with `host_error` so the controller keeps the copy in memory and shows a notice.
 * The working copy never becomes a version and is only sent when the user clicks "Send to the agent".
 *
 * In WorkBuddy the panel lives at `http://127.0.0.1:<port>`; `localStorage` is keyed by that origin,
 * and the hub reuses a stable port when it can, so the copies usually survive a restart. When the
 * port changes they are lost — uncommitted edits only, never a version (principle 2).
 */
export class LocalStorageWorkingCopies implements WorkingCopyStorage {
  constructor(private readonly backend?: KeyValueStorage) {}

  private store(): KeyValueStorage {
    if (this.backend !== undefined) return this.backend;
    const g = globalThis as { localStorage?: KeyValueStorage };
    const found = g.localStorage;
    if (found === undefined) throw new Error('localStorage is not available');
    return found;
  }

  async load(sessionId: string, draftId: string): Promise<WorkingCopy | null> {
    try {
      return this.read(workingCopyKey(sessionId, draftId));
    } catch (err) {
      throw hostError('read your changes', err);
    }
  }

  async save(copy: WorkingCopy): Promise<void> {
    try {
      this.store().setItem(workingCopyKey(copy.sessionId, copy.draftId), JSON.stringify(copy));
    } catch (err) {
      throw hostError('save your changes', err);
    }
  }

  async remove(sessionId: string, draftId: string): Promise<void> {
    try {
      this.store().removeItem(workingCopyKey(sessionId, draftId));
    } catch (err) {
      throw hostError('remove saved changes', err);
    }
  }

  async list(sessionId: string): Promise<WorkingCopy[]> {
    try {
      const store = this.store();
      const prefix = sessionKeyPrefix(sessionId);
      const keys: string[] = [];
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        if (key !== null && key.startsWith(prefix)) keys.push(key);
      }
      const copies: WorkingCopy[] = [];
      for (const key of keys) {
        const copy = this.read(key);
        if (copy !== null && copy.sessionId === sessionId) copies.push(copy);
      }
      return copies;
    } catch (err) {
      throw hostError('list saved changes', err);
    }
  }

  private read(key: string): WorkingCopy | null {
    const raw = this.store().getItem(key);
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isWorkingCopy(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}
