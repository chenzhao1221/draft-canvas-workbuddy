/** Time source for the controller. Inject a fake in tests. */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  /** Runs `callback` once after `delayMs`. Returns a function that cancels it. */
  setTimer(callback: () => void, delayMs: number): () => void;
}

interface TimerGlobals {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Default clock: `Date.now` and the JavaScript runtime's timers. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimer(callback, delayMs) {
    const g = globalThis as unknown as TimerGlobals;
    const handle = g.setTimeout(callback, delayMs);
    return () => g.clearTimeout(handle);
  },
};
