import { describe, expect, it } from 'vitest';

import * as core from '../src/index';

/**
 * Harness smoke test only: proves that Vitest finds this package's tests, runs them in a
 * Node environment, and can load the package entry point. Real core tests start at T-22.
 */
describe('core test harness', () => {
  it('runs in a Node environment with no DOM globals', () => {
    expect(typeof (globalThis as { window?: unknown }).window).toBe('undefined');
  });

  it('loads the package entry point', () => {
    expect(core).toBeTypeOf('object');
  });

  it('executes assertions', () => {
    expect(1 + 1).toBe(2);
  });
});
