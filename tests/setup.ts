import { afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';

// Vitest globals are off, so Testing Library cannot register its own cleanup.
// Only load it for DOM environments to keep node-environment tests light.
if (typeof document !== 'undefined') {
  const { cleanup } = await import('@testing-library/react');
  afterEach(() => cleanup());
}
