import { describe, expect, it } from 'vitest';
import { requestPersistentStorage } from '../../src/data/persist';

const fail = async (): Promise<boolean> => {
  throw new Error('persist must not be called');
};

describe('requestPersistentStorage', () => {
  it('returns true without asking when storage is already persisted', async () => {
    expect(await requestPersistentStorage({ persisted: async () => true, persist: fail })).toBe(true);
  });
  it('asks for persistence otherwise and returns the answer', async () => {
    expect(await requestPersistentStorage({ persisted: async () => false, persist: async () => false })).toBe(false);
    expect(await requestPersistentStorage({ persisted: async () => false, persist: async () => true })).toBe(true);
  });
  it('returns false when the API throws or is missing', async () => {
    expect(await requestPersistentStorage({ persisted: async () => { throw 1; }, persist: fail })).toBe(false);
    expect(await requestPersistentStorage(undefined)).toBe(false);
  });
});
