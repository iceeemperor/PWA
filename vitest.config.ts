import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Tests run in node by default. UI test files opt in to jsdom with
// `// @vitest-environment jsdom` as their first line.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    // The first createTestDb() of a db test file starts PGlite (2 to 3 s on a small machine, longer when several files run at once).
    hookTimeout: 30_000,
  },
});
