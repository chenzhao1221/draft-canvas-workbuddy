import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The hub and the transcript parser are Node code; the adapter is tested against a fake
    // transport and a fake `localStorage`, so no DOM environment is needed.
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
    passWithNoTests: false,
  },
});
