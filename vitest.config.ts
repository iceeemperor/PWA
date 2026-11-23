import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Tests run in node by default. UI test files opt in to jsdom with
// `// @vitest-environment jsdom` as their first line.
export default defineConfig({
  plugins: [react()],
  resolve: {
    // vite-plugin-pwa's virtual module only exists in the app build; tests get a stub (vi.mock can override it).
    alias: { 'virtual:pwa-register/react': fileURLToPath(new URL('tests/helpers/pwa-register-stub.ts', import.meta.url)) },
  },
  test: {
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    // The first createTestDb() of a db test file starts PGlite (2 to 3 s on a small machine, longer when several files run at once).
    hookTimeout: 30_000,
    // A fixed device zone, so deviceTimeZone() and the date labels in UI tests do not depend on the machine.
    env: { TZ: 'Asia/Shanghai' },
  },
});
