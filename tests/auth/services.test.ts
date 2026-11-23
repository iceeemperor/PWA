import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  startSyncTriggers: vi.fn((_d: unknown) => () => {}),
  createSyncEngine: vi.fn(),
  getSession: vi.fn(async (): Promise<unknown> => ({ data: { session: null }, error: null })),
}));

vi.mock('../../src/supabase', () => ({
  getSupabase: () => ({
    rpc: vi.fn(),
    auth: {
      getSession: () => mocks.getSession(),
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
import { AuthRetryableFetchError } from '@supabase/supabase-js';
import { deleteDB, openDB } from 'idb';
import { LocalDbUnavailableError, openLocalDb } from '../../src/data/local-db';
import { OWNER_SIGNED_IN, OWNER_USER_ID } from '../../src/data/owner';

const env = (extra: Record<string, string> = {}) => ({ ...import.meta.env, ...extra }) as ImportMetaEnv;

afterEach(() => {
  vi.unstubAllGlobals();
  mocks.startSyncTriggers.mockClear();
  mocks.createSyncEngine.mockClear();
  mocks.getSession.mockReset();
  mocks.getSession.mockImplementation(async () => ({ data: { session: null }, error: null }));
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

  it('offline with an expired token, boots quickly into the remembered owner (F1)', async () => {
    const owner = '00000000-0000-4000-8000-0000000000aa';
    const db = await openLocalDb();
    await db.setMeta(OWNER_USER_ID, owner);
    await db.setMeta(OWNER_SIGNED_IN, true);
    db.close();
    // auth-js offline: the refresh never comes back within boot's bound.
    mocks.getSession.mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let s: Awaited<ReturnType<typeof createServices>> | undefined;
      void createServices(env()).then((r) => (s = r));
      // Local IndexedDB work also runs on (faked) timers: step time until boot is done, never more than the bound.
      let waited = 0;
      while (!s && waited < 5000) {
        await vi.advanceTimersByTimeAsync(50);
        waited += 50;
      }
      // The bound is 2 s; without it auth-js would hold boot for about 25 s.
      expect(waited).toBeLessThan(3000);
      if (!s) throw new Error('boot did not finish');
      expect(s.auth.getUserId()).toBe(owner);
      await s.repo.create('todos', { title: 'offline' });
      expect(await s.repo.pendingCount()).toBe(1);
      s.db.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('offline with a retryable refresh error, also boots into the remembered owner; signed out stays signed out', async () => {
    const owner = '00000000-0000-4000-8000-0000000000ab';
    mocks.getSession.mockImplementation(async () => ({ data: { session: null }, error: new AuthRetryableFetchError('Failed to fetch', 0) }));
    const db = await openLocalDb();
    await db.setMeta(OWNER_USER_ID, owner);
    await db.setMeta(OWNER_SIGNED_IN, true);
    db.close();
    const s = await createServices(env());
    expect(s.auth.getUserId()).toBe(owner);
    s.db.close();

    const db2 = await openLocalDb();
    await db2.setMeta(OWNER_SIGNED_IN, false);
    db2.close();
    const t = await createServices(env());
    expect(t.auth.getUserId()).toBeNull();
    t.db.close();
  });

  it('at start-up, requeues ops that failed on a network-looking reason; refused ones stay failed', async () => {
    const db = await openLocalDb();
    await db.raw.clear('queue');
    const op = (reason: string) => ({
      op_id: crypto.randomUUID(), table: 'todos', id: crypto.randomUUID(), kind: 'insert', base_rev: null,
      fields: { title: 'x' }, failed: { reason },
    });
    await db.raw.add('queue', op('TypeError: Load failed'));
    await db.raw.add('queue', op('title cannot be empty'));
    await db.raw.add('queue', op('TypeError: Failed to fetch'));
    db.close();
    const s = await createServices(env());
    expect((await s.repo.failedOps()).map((o) => o.failed!.reason)).toEqual(['title cannot be empty']);
    expect(await s.repo.pendingCount()).toBe(2);
    await s.db.raw.clear('queue');
    s.db.close();
  });

  // Last in the file: it deletes the default database, so the tests above keep their order-independent setup.
  it('passes onVersionChange and onBlocked to the local database', async () => {
    const onVersionChange = vi.fn();
    const onBlocked = vi.fn();
    const s = await createServices(env(), { onVersionChange, onBlocked });
    const newer = await openDB('productivity-app', 3);
    expect(onVersionChange).toHaveBeenCalledTimes(1);
    expect(() => s.db.raw.transaction('meta')).toThrow();
    newer.close();
    await deleteDB('productivity-app');

    // A stage 1 tab that never closes its connection holds up version 2: createServices reports it as blocked.

    const stuck = await openDB('productivity-app', 1, {
      upgrade(d) {
        d.createObjectStore('todos', { keyPath: 'id' });
        d.createObjectStore('queue', { keyPath: 'seq', autoIncrement: true });
        d.createObjectStore('meta');
      },
    });
    const booting = createServices(env(), { onBlocked });
    await vi.waitFor(() => expect(onBlocked).toHaveBeenCalledTimes(1));
    stuck.close();
    const t = await booting;
    expect(t.db.raw.version).toBe(2);
    t.db.close();
    await deleteDB('productivity-app');
  });
});
