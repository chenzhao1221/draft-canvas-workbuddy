import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The panel is React + CodeMirror 6 and needs a DOM, so component tests run under jsdom.
    environment: 'jsdom',
    // jsdom shims for CodeMirror's Range measurement (see test/setup.ts).
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    passWithNoTests: false,
  },
});
