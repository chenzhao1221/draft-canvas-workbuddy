import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // core is pure TypeScript: no DOM, no host SDK, so a plain Node environment is enough.
    environment: 'node',
    include: ['test/**/*.test.ts'],
    passWithNoTests: false,
  },
});
