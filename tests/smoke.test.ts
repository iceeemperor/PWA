import { it, expect } from 'vitest';
it('test environment provides indexedDB and crypto.randomUUID', () => {
  expect(typeof indexedDB.open).toBe('function');
  expect(crypto.randomUUID()).toMatch(/^[0-9a-f-]{36}$/);
});
