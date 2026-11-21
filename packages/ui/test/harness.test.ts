import { describe, expect, it } from 'vitest';

/**
 * Harness smoke test only: proves that Vitest runs this package's tests under jsdom so
 * component tests (T-38) have a DOM. It intentionally does not import `../src/index` while
 * the panel shell is still being written by Kiro.
 */
describe('ui test harness', () => {
  it('runs in a jsdom environment', () => {
    expect(typeof document).toBe('object');
    expect(document.createElement('div').nodeName).toBe('DIV');
  });

  it('executes assertions', () => {
    expect(1 + 1).toBe(2);
  });
});
