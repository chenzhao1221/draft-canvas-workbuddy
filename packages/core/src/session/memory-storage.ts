import type { WorkingCopy, WorkingCopyStorage } from '../adapter';

/**
 * In-memory working-copy storage. The controller uses it when the host
 * provides none; working copies are then lost when the panel unmounts.
 */
export class MemoryWorkingCopyStorage implements WorkingCopyStorage {
  private readonly copies = new Map<string, WorkingCopy>();

  private static key(sessionId: string, draftId: string): string {
    return `${sessionId}\u0000${draftId}`;
  }

  async load(sessionId: string, draftId: string): Promise<WorkingCopy | null> {
    const copy = this.copies.get(MemoryWorkingCopyStorage.key(sessionId, draftId));
    return copy === undefined ? null : { ...copy };
  }

  async save(copy: WorkingCopy): Promise<void> {
    this.copies.set(MemoryWorkingCopyStorage.key(copy.sessionId, copy.draftId), { ...copy });
  }

  async remove(sessionId: string, draftId: string): Promise<void> {
    this.copies.delete(MemoryWorkingCopyStorage.key(sessionId, draftId));
  }

  async list(sessionId: string): Promise<WorkingCopy[]> {
    return [...this.copies.values()].filter((c) => c.sessionId === sessionId).map((c) => ({ ...c }));
  }
}
