import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  startSyncTriggers: vi.fn((_d: unknown) => () => {}),
  createSyncEngine: vi.fn(),
}));

vi.mock('../../src/supabase', () => ({
  getSupabase: () => ({
    rpc: vi.fn(),
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
  }),
}));
vi.mock('../../src/sync/triggers', () => ({ startSyncTriggers: mocks.startSyncTriggers }));
vi.mock('../../src/sync/engine', async (orig) => {
  const real = await orig<typeof import('../../src/sync/engine')>();
  mocks.createSyncEngine.mockImplementation(real.createSyncEngine);
  return { ...real, createSyncEngine: mocks.createSyncEngine };
});

import { createServices } from '../../src/app/services';
import { LocalDbUnavailableError } from '../../src/data/local-db';

const env = (extra: Record<string, string> = {}) => ({ ...import.meta.env, ...extra }) as ImportMetaEnv;

afterEach(() => {
  vi.unstubAllGlobals();
  mocks.startSyncTriggers.mockClear();
  mocks.createSyncEngine.mockClear();
});

describe('createServices', () => {
  it('rethrows LocalDbUnavailableError as it is', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await expect(createServices(env())).rejects.toBeInstanceOf(LocalDbUnavailableError);
  });

  it('wires the cross-tab lock when navigator.locks exists', async () => {
    const locks = { request: vi.fn() };
    vi.stubGlobal('navigator', { locks });
    await createServices(env());
    expect(mocks.createSyncEngine).toHaveBeenCalledWith(expect.objectContaining({ locks }));
  });

  it('passes no lock when navigator.locks is missing', async () => {
    vi.stubGlobal('navigator', {});
    await createServices(env());
    expect(mocks.createSyncEngine.mock.calls[0][0]).not.toHaveProperty('locks');
  });

  it('does not start the triggers itself; startSync passes purgeOnStart only when the flag is "true"', async () => {
    const on = await createServices(env({ VITE_PURGE_ON_START: 'true' }));
    expect(mocks.startSyncTriggers).not.toHaveBeenCalled();
    on.startSync!();
    expect(mocks.startSyncTriggers).toHaveBeenLastCalledWith(expect.objectContaining({ engine: on.engine, repo: on.repo, purgeOnStart: on.cloud }));

    const off = await createServices(env({ VITE_PURGE_ON_START: '' }));
    off.startSync!();
    expect(mocks.startSyncTriggers.mock.lastCall![0]).not.toHaveProperty('purgeOnStart');
  });

  it('the repo refuses to write while signed out', async () => {
    const s = await createServices(env());
    await expect(s.repo.create('todos', { title: 'x' })).rejects.toThrow();
    expect(await s.repo.pendingCount()).toBe(0);
  });
});
