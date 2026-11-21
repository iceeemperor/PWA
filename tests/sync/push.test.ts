import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openLocalDb, type LocalDb } from '../../src/data/local-db';
import { createRepo } from '../../src/data/repo';
import type { PushOp, PushResult, QueuedOp, TodoRecord } from '../../src/domain/types';
import { createSyncEngine, type SyncStatus } from '../../src/sync/engine';
import {
  TEST_USER_A,
  createTestDb,
  makeTombstone as tombstoneIn,
  rowOf,
  trashAt,
  type TestDb,
} from '../db/harness';
import { createDevice, type Device } from '../helpers/device';
import { createFlakyCloud, type FlakyCloud } from '../helpers/flaky-cloud';
import { createPgliteCloud } from '../helpers/pglite-cloud';

const U = TEST_USER_A;

let t: TestDb;
let flaky: FlakyCloud;
let a: Device;
let opened: LocalDb[];

beforeEach(async () => {
  opened = [];
  t = await createTestDb();
  flaky = createFlakyCloud(createPgliteCloud(t, U));
  a = await createDevice({ name: 'a', cloud: flaky, userId: U });
  opened.push(a.db);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of opened) db.close();
  await t.pg.close();
});

// Helpers bound to the current test's databases.
const queue = (db: LocalDb = a.db): Promise<QueuedOp[]> => db.raw.getAll('queue');
const rawTodo = (id: string): Promise<TodoRecord | undefined> => a.db.raw.get('todos', id);
const makeTombstone = (id: string) => tombstoneIn(t, id);

/** Rewrites the queued insert's title, bypassing the Repo's validation. */
async function forceTitle(id: string, title: string): Promise<void> {
  const op = (await queue()).find((q) => q.id === id && q.kind === 'insert');
  if (!op) throw new Error(`no queued insert for ${id}`);
  await a.db.raw.put('queue', { ...op, fields: { ...op.fields, title } });
}

async function cloudRowCount(): Promise<number> {
  await t.asRole('postgres');
  const r = await t.pg.query<{ n: number }>('select count(*)::int as n from todos');
  return r.rows[0].n;
}

/** Another device's write, straight into the cloud (bumps rev through the trigger). */
async function serverSet(id: string, sql: string): Promise<void> {
  await t.asRole('postgres');
  await t.pg.query(`update todos set ${sql} where id = $1`, [id]);
}

/** A promise-chain stand-in for navigator.locks: one holder at a time per manager. */
function fakeLocks(): Pick<LockManager, 'request'> {
  let chain: Promise<unknown> = Promise.resolve();
  const request = (_name: string, cb: (lock: Lock | null) => unknown) => {
    const run = chain.then(() => cb(null));
    chain = run.then(() => {}, () => {});
    return run;
  };
  return { request } as unknown as Pick<LockManager, 'request'>;
}

describe('push: the brief', () => {
  it('drains the queue in order and stores the server rev', async () => {
    const r = await a.repo.create('todos', { title: 'x' });
    expect(await a.engine.sync()).toMatchObject({ outcome: 'ok', pushed: 1, failed: 0 });
    expect((await a.repo.get('todos', r.id))!.rev).toBeGreaterThan(0); expect(await a.repo.pendingCount()).toBe(0);
  });
  it('later queued ops on the same record get the new base_rev, so own edits never conflict', async () => {
    const r = await a.repo.create('todos', { title: 'x' }); await a.repo.update('todos', r.id, { done: true });
    expect(await a.engine.sync()).toMatchObject({ pushed: 2, conflicts: 0 });
  });
  it('a successful push does not overwrite newer local edits still in the queue', async () => {
    const r = await a.repo.create('todos', { title: 'x' }); await a.repo.update('todos', r.id, { title: 'y' }); await a.engine.sync();
    expect((await a.repo.get('todos', r.id))!.title).toBe('y');
  });
  it('a network error keeps the queue and retries the same op_id later', async () => {
    await a.repo.create('todos', { title: 'x' }); flaky.failNext('network');
    expect(await a.engine.sync()).toMatchObject({ outcome: 'offline', pushed: 0 }); expect(await a.repo.pendingCount()).toBe(1);
    expect(await a.engine.sync()).toMatchObject({ outcome: 'ok', pushed: 1 }); expect(await cloudRowCount()).toBe(1);
  });
  it('an auth error stops the run and keeps the queue', async () => {
    await a.repo.create('todos', { title: 'x' }); flaky.failNext('auth');
    expect(await a.engine.sync()).toMatchObject({ outcome: 'auth_expired' }); expect(await a.repo.pendingCount()).toBe(1);
    expect(a.engine.status().state).toBe('auth_expired');
  });
  it('an unavailable cloud reports unavailable and keeps the queue', async () => {
    await a.repo.create('todos', { title: 'x' }); flaky.failNext('unavailable');
    expect(await a.engine.sync()).toMatchObject({ outcome: 'unavailable' }); expect(await a.repo.pendingCount()).toBe(1);
  });
  it('a rejected op moves to the failed list and does not block later ops', async () => {
    const bad = await a.repo.create('todos', { title: 'x' }); await forceTitle(bad.id, ''); await a.repo.create('todos', { title: 'ok' });
    expect(await a.engine.sync()).toMatchObject({ pushed: 1, failed: 1 }); expect(await a.repo.failedOps()).toHaveLength(1);
    expect(a.engine.status()).toMatchObject({ failed: 1, pending: 0 });
  });
  it('an op on a tombstone is discarded, not retried forever', async () => {
    const r = await a.repo.create('todos', { title: 'x' }); await a.engine.sync(); await makeTombstone(r.id);
    await a.repo.update('todos', r.id, { done: true });
    expect(await a.engine.sync()).toMatchObject({ dropped: 1 }); expect(await a.repo.pendingCount()).toBe(0);
  });
  it('concurrent sync() calls share one run', async () => {
    await a.repo.create('todos', { title: 'x' }); const spy = vi.spyOn(flaky, 'push');
    await Promise.all([a.engine.sync(), a.engine.sync()]); expect(spy).toHaveBeenCalledTimes(1);
  });
  it('runs inside the cross-tab lock when one is provided', async () => {
    const locks = { request: vi.fn((_n: string, cb: () => Promise<unknown>) => cb()) };
    const d = await createDevice({ name: 'locked', cloud: flaky, userId: U, locks: locks as any }); opened.push(d.db);
    await d.engine.sync();
    expect(locks.request).toHaveBeenCalledWith('pa-sync', expect.any(Function));
  });
});

describe('push: order, retries and the local copy', () => {
  it('pushes in queue order, one op per call, with the queued op unchanged', async () => {
    const r1 = await a.repo.create('todos', { title: 'one' });
    const r2 = await a.repo.create('todos', { title: 'two' });
    await a.repo.remove('todos', r1.id);
    const queued = await queue();
    const spy = vi.spyOn(flaky, 'push');
    expect(await a.engine.sync()).toMatchObject({ outcome: 'ok', pushed: 3, dropped: 0, failed: 0, pulled: 0, conflicts: 0 });
    const sent = spy.mock.calls.map(([op]) => op);
    expect(sent.map((op) => [op.id, op.kind])).toEqual([[r1.id, 'insert'], [r2.id, 'insert'], [r1.id, 'delete']]);
    // Only the PushOp fields go out, and op_id/fields are the queued ones.
    expect(Object.keys(sent[0]).sort()).toEqual(['base_rev', 'fields', 'id', 'kind', 'op_id', 'table']);
    expect(sent.map((op) => op.op_id)).toEqual(queued.map((q) => q.op_id));
    expect(sent[0].fields).toEqual(queued[0].fields);
    expect(await queue()).toEqual([]);
  });

  it('rebases a later op from base_rev 0 to the rev the insert got', async () => {
    const r = await a.repo.create('todos', { title: 'x' });
    await a.repo.update('todos', r.id, { done: true });
    const spy = vi.spyOn(flaky, 'push');
    await a.engine.sync();
    const insertResult = (await spy.mock.results[0].value) as PushResult;
    expect(spy.mock.calls[1][0].base_rev).toBe(insertResult.rev);
    expect((await rowOf(t, r.id)).done).toBe(true);
  });

  it('retries the very same op_id after a network error', async () => {
    await a.repo.create('todos', { title: 'x' });
    const spy = vi.spyOn(flaky, 'push');
    flaky.failNext('network');
    await a.engine.sync();
    await a.engine.sync();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1][0].op_id).toBe(spy.mock.calls[0][0].op_id);
  });

  it('a network error mid-queue keeps the rest, and ops already pushed stay pushed', async () => {
    await a.repo.create('todos', { title: 'one' });
    await a.repo.create('todos', { title: 'two' });
    const original = flaky.push.bind(flaky);
    vi.spyOn(flaky, 'push').mockImplementationOnce(async (op: PushOp) => {
      const res = await original(op);
      flaky.failNext('network');
      return res;
    });
    expect(await a.engine.sync()).toMatchObject({ outcome: 'offline', pushed: 1 });
    expect(await a.repo.pendingCount()).toBe(1);
    expect(await a.engine.sync()).toMatchObject({ outcome: 'ok', pushed: 1 });
    expect(await cloudRowCount()).toBe(2);
  });

  it('with no ops left for the record, the local copy becomes the server record', async () => {
    const r = await a.repo.create('todos', { title: 'x' });
    const spy = vi.spyOn(flaky, 'push');
    await a.engine.sync();
    const res = (await spy.mock.results[0].value) as PushResult;
    expect(await rawTodo(r.id)).toEqual(res.record);
    // The server's updated_at replaces the Repo's placeholder.
    expect((await rawTodo(r.id))!.updated_at).toBe((res.record as { updated_at: string }).updated_at);
  });

  it('with ops still queued for the record, only rev, updated_at, deleted_at and purged_at come from the server', async () => {
    const r = await a.repo.create('todos', { title: 'x' });
    await a.repo.update('todos', r.id, { title: 'y' });
    const local = (await rawTodo(r.id))!;
    const original = flaky.push.bind(flaky);
    let first: PushResult | undefined;
    vi.spyOn(flaky, 'push').mockImplementationOnce(async (op: PushOp) => {
      first = await original(op);
      flaky.failNext('network'); // the update stays queued
      return first;
    });
    expect(await a.engine.sync()).toMatchObject({ outcome: 'offline', pushed: 1 });
    const rec = first!.record as Record<string, unknown>;
    expect(await rawTodo(r.id)).toEqual({
      ...local,
      rev: first!.rev,
      updated_at: rec.updated_at,
      deleted_at: null,
      purged_at: null,
    });
    expect(local.title).toBe('y');
    expect((await queue())[0].base_rev).toBe(first!.rev);
    expect(await a.engine.sync()).toMatchObject({ outcome: 'ok', pushed: 1, conflicts: 0 });
    expect((await rowOf(t, r.id)).title).toBe('y');
  });

  it('a replayed result older than the local copy does not take it backwards', async () => {
    const r = await a.repo.create('todos', { title: 'x' });
    const spy = vi.spyOn(flaky, 'push');
    await a.engine.sync();
    const old = (await spy.mock.results[0].value) as PushResult;
    await a.repo.update('todos', r.id, { title: 'y' });
    // Meanwhile a newer version arrived (as a pull would bring it).
    await a.db.raw.put('todos', { ...(await rawTodo(r.id))!, rev: old.rev! + 100 });
    spy.mockResolvedValueOnce(old);
    await a.engine.sync();
    expect(await a.repo.get('todos', r.id)).toMatchObject({ title: 'y', rev: old.rev! + 100 });
  });

  it('an applied result never brings a local tombstone back to life', async () => {
    const r = await a.repo.create('todos', { title: 'x' });
    const tomb = { ...(await rawTodo(r.id))!, title: '', purged_at: '2026-11-01T00:00:00.000Z', deleted_at: '2026-11-01T00:00:00.000Z' };
    await a.db.raw.put('todos', tomb);
    vi.spyOn(flaky, 'push').mockResolvedValueOnce({
      status: 'applied', conflict: false, rev: 5, message: null,
      record: { ...tomb, title: 'x', rev: 5, deleted_at: null, purged_at: null },
    });
    await a.engine.sync();
    expect(await rawTodo(r.id)).toEqual(tomb);
  });

  it('a server record without deleted_at or purged_at is stored with both set to null', async () => {
    const r = await a.repo.create('todos', { title: 'x' });
    const { deleted_at: _d, purged_at: _p, ...partial } = (await rawTodo(r.id))!;
    vi.spyOn(flaky, 'push').mockResolvedValueOnce({
      status: 'applied', conflict: false, rev: 7, message: null, record: { ...partial, rev: 7 },
    });
    await a.engine.sync();
    expect(await rawTodo(r.id)).toEqual({ ...partial, rev: 7, deleted_at: null, purged_at: null });
    expect(await a.repo.get('todos', r.id)).toBeDefined();
  });

  /** The next push goes through, and the one after it fails with a network error. */
  function failAfterFirstPush(): void {
    const original = flaky.push.bind(flaky);
    vi.spyOn(flaky, 'push').mockImplementationOnce(async (op: PushOp) => {
      const res = await original(op);
      flaky.failNext('network');
      return res;
    });
  }

  it('a queued delete keeps the record in the trash while an earlier op is settled', async () => {
    const r = await a.repo.create('todos', { title: 'x' });
    await a.repo.remove('todos', r.id);
    const trashedAt = (await rawTodo(r.id))!.deleted_at;
    failAfterFirstPush();
    expect(await a.engine.sync()).toMatchObject({ outcome: 'offline', pushed: 1 });
    expect((await rowOf(t, r.id)).deleted_at).toBeNull(); // the server only has the insert so far
    expect((await rawTodo(r.id))!.deleted_at).toBe(trashedAt);
    expect(await a.repo.list('todos')).toEqual([]);
    expect((await a.repo.list('todos', { trashed: true })).map((x) => x.id)).toEqual([r.id]);
    await expect(a.repo.update('todos', r.id, { done: true })).rejects.toThrow(/trash/);
  });

  it('the queued delete then pushes cleanly on the next sync', async () => {
    const r = await a.repo.create('todos', { title: 'x' });
    await a.repo.remove('todos', r.id);
    failAfterFirstPush();
    await a.engine.sync();
    expect(await a.engine.sync()).toMatchObject({ outcome: 'ok', pushed: 1, dropped: 0, failed: 0, conflicts: 0 });
    expect(await a.repo.pendingCount()).toBe(0);
    const row = await rowOf(t, r.id);
    expect(row.deleted_at).not.toBeNull();
    const local = (await rawTodo(r.id))!;
    expect(local.deleted_at).not.toBeNull();
    expect(local.rev).toBe(Number(row.rev));
    expect((await a.repo.list('todos', { trashed: true })).map((x) => x.id)).toEqual([r.id]);
  });

  it('a queued restore keeps the record out of the trash while an earlier delete is settled', async () => {
    const r = await a.repo.create('todos', { title: 'x' });
    await a.engine.sync();
    await a.repo.remove('todos', r.id);
    await a.repo.restore('todos', r.id);
    failAfterFirstPush();
    expect(await a.engine.sync()).toMatchObject({ outcome: 'offline', pushed: 1 });
    expect((await rowOf(t, r.id)).deleted_at).not.toBeNull(); // the server has the delete, not yet the restore
    expect((await rawTodo(r.id))!.deleted_at).toBeNull();
    expect((await a.repo.list('todos')).map((x) => x.id)).toEqual([r.id]);
    await a.repo.update('todos', r.id, { title: 'edited' }); // allowed: locally it is live
    expect(await a.engine.sync()).toMatchObject({ outcome: 'ok', pushed: 2, dropped: 0 });
    expect(await rowOf(t, r.id)).toMatchObject({ deleted_at: null, title: 'edited' });
  });

  it('records the engine writes always carry deleted_at and purged_at', async () => {
    const r = await a.repo.create('todos', { title: 'x' });
    await a.engine.sync();
    const stored = (await rawTodo(r.id))! as unknown as Record<string, unknown>;
    expect(stored).toHaveProperty('deleted_at', null);
    expect(stored).toHaveProperty('purged_at', null);
    expect(await a.repo.list('todos')).toHaveLength(1);
  });

  it('counts conflicts when another device changed the record first, and the edit still wins', async () => {
    const r = await a.repo.create('todos', { title: 'x' });
    await a.engine.sync();
    await serverSet(r.id, 'done = true');
    await a.repo.update('todos', r.id, { title: 'mine' });
    expect(await a.engine.sync()).toMatchObject({ outcome: 'ok', pushed: 1, conflicts: 1 });
    expect(a.engine.status().conflicts).toBe(1);
    const row = await rowOf(t, r.id);
    expect(row).toMatchObject({ title: 'mine', done: true });
    // Nothing queued any more, so the local copy now also has the other device's change.
    expect(await a.repo.get('todos', r.id)).toMatchObject({ title: 'mine', done: true, rev: Number(row.rev) });
  });
});

describe('push: dropped, invalid and rejected', () => {
  it('dropped_purged turns the local record into a tombstone', async () => {
    const r = await a.repo.create('todos', { title: 'x', note: 'secret' });
    await a.engine.sync();
    await makeTombstone(r.id);
    await a.repo.update('todos', r.id, { done: true });
    expect(await a.engine.sync()).toMatchObject({ outcome: 'ok', dropped: 1, pushed: 0, failed: 0 });
    expect(await a.repo.get('todos', r.id)).toBeUndefined();
    expect(await a.repo.list('todos', { trashed: true })).toEqual([]);
    const stored = (await rawTodo(r.id))!;
    expect(stored).toMatchObject({ title: '', note: '', done: false, kind: 'todo', priority: 'normal', due_date: null, steps: [] });
    expect(stored.purged_at).not.toBeNull();
    expect(stored.deleted_at).not.toBeNull();
    expect(stored.rev).toBe(Number((await rowOf(t, r.id)).rev));
  });

  it('dropped_purged keeps the server tombstone purged_at', async () => {
    const r = await a.repo.create('todos', { title: 'x' });
    await a.engine.sync();
    await makeTombstone(r.id);
    await a.repo.remove('todos', r.id);
    const spy = vi.spyOn(flaky, 'push');
    await a.engine.sync();
    const res = (await spy.mock.results[0].value) as PushResult;
    expect(res.status).toBe('dropped_purged');
    expect((await rawTodo(r.id))!.purged_at).toBe((res.record as { purged_at: string }).purged_at);
  });

  it('dropped_purged without a record builds the tombstone from the local copy', async () => {
    const r = await a.repo.create('todos', { title: 'x', note: 'secret', done: true, priority: 'high' });
    const local = (await rawTodo(r.id))!;
    vi.spyOn(flaky, 'push').mockResolvedValueOnce({ status: 'dropped_purged', conflict: false, rev: null, record: null, message: null });
    expect(await a.engine.sync()).toMatchObject({ dropped: 1 });
    const stored = (await rawTodo(r.id))!;
    expect(stored).toMatchObject({
      id: r.id, created_at: local.created_at, rev: 0,
      kind: 'todo', title: '', done: false, priority: 'normal', due_date: null, note: '', steps: [],
    });
    expect(stored.purged_at).not.toBeNull();
    expect(stored.deleted_at).not.toBeNull();
    expect(await a.repo.get('todos', r.id)).toBeUndefined();
  });

  it('dropped_trashed discards the edit and shows the record as trashed', async () => {
    const r = await a.repo.create('todos', { title: 'x' });
    await a.engine.sync();
    await trashAt(t, r.id, 1);
    await a.repo.update('todos', r.id, { title: 'lost' });
    expect(await a.engine.sync()).toMatchObject({ outcome: 'ok', dropped: 1, pushed: 0 });
    expect(await a.repo.pendingCount()).toBe(0);
    const trashed = await a.repo.list('todos', { trashed: true });
    expect(trashed.map((x) => [x.id, x.title])).toEqual([[r.id, 'x']]);
  });

  it('an invalid op keeps its message as the failure reason and is not sent again', async () => {
    const bad = await a.repo.create('todos', { title: 'x' });
    await forceTitle(bad.id, '');
    await a.engine.sync();
    const [failed] = await a.repo.failedOps();
    expect(failed.id).toBe(bad.id);
    expect(failed.failed?.reason).toMatch(/check/i);
    const spy = vi.spyOn(flaky, 'push');
    expect(await a.engine.sync()).toMatchObject({ outcome: 'ok', pushed: 0, failed: 0 });
    expect(spy).not.toHaveBeenCalled();
    // The local record is left as it was.
    expect((await a.repo.get('todos', bad.id))!.rev).toBe(0);
  });

  it('a rejected CloudError is handled like invalid: the op fails, the run goes on', async () => {
    const first = await a.repo.create('todos', { title: 'one' });
    await a.repo.create('todos', { title: 'two' });
    flaky.failNext('rejected');
    expect(await a.engine.sync()).toMatchObject({ outcome: 'ok', pushed: 1, failed: 1 });
    const [failed] = await a.repo.failedOps();
    expect(failed.id).toBe(first.id);
    expect(failed.failed?.reason).toBeTruthy();
    expect(await cloudRowCount()).toBe(1);
  });
});

describe('push: status and subscribers', () => {
  it('starts idle with nothing synced yet', () => {
    expect(a.engine.status()).toEqual({ state: 'idle', pending: 0, failed: 0, lastSyncedAt: null, conflicts: 0 });
  });

  it('an engine opened on a non-empty queue reports its counts without a sync', async () => {
    await a.repo.create('todos', { title: 'x' });
    const bad = await a.repo.create('todos', { title: 'y' });
    await a.db.raw.put('queue', { ...(await queue()).find((q) => q.id === bad.id)!, failed: { reason: 'old' } });
    const engine = createSyncEngine({ db: a.db, cloud: flaky });
    const seen: SyncStatus[] = [];
    engine.subscribe((s) => seen.push(s));
    await vi.waitFor(() => expect(engine.status()).toMatchObject({ state: 'idle', pending: 1, failed: 1 }));
    expect(seen.at(-1)).toMatchObject({ pending: 1, failed: 1 });
  });

  it('tells subscribers about the run and the result, until unsubscribed', async () => {
    await a.repo.create('todos', { title: 'x' });
    const seen: SyncStatus[] = [];
    const off = a.engine.subscribe((s) => seen.push(s));
    await a.engine.sync();
    expect(seen.map((s) => s.state)).toContain('syncing');
    const last = seen.at(-1)!;
    expect(last).toMatchObject({ state: 'idle', pending: 0, failed: 0, conflicts: 0 });
    expect(last.lastSyncedAt).not.toBeNull();
    expect(a.engine.status()).toEqual(last);
    off();
    const n = seen.length;
    await a.engine.sync();
    expect(seen.length).toBe(n);
  });

  it('a syncing status shows how many ops are waiting', async () => {
    await a.repo.create('todos', { title: 'x' });
    await a.repo.create('todos', { title: 'y' });
    const seen: SyncStatus[] = [];
    a.engine.subscribe((s) => seen.push(s));
    await a.engine.sync();
    expect(seen.find((s) => s.state === 'syncing')).toMatchObject({ pending: 2 });
  });

  it('offline keeps pending and lastSyncedAt; a later good run clears the state', async () => {
    await a.repo.create('todos', { title: 'x' });
    flaky.failNext('network');
    await a.engine.sync();
    expect(a.engine.status()).toMatchObject({ state: 'offline', pending: 1, lastSyncedAt: null });
    await a.engine.sync();
    expect(a.engine.status()).toMatchObject({ state: 'idle', pending: 0 });
    expect(a.engine.status().lastSyncedAt).not.toBeNull();
  });

  it('an auth error keeps the last good sync time', async () => {
    await a.repo.create('todos', { title: 'x' });
    await a.engine.sync();
    const at = a.engine.status().lastSyncedAt;
    await a.repo.create('todos', { title: 'y' });
    flaky.failNext('auth');
    expect(await a.engine.sync()).toMatchObject({ outcome: 'auth_expired', pushed: 0 });
    expect(a.engine.status()).toMatchObject({ state: 'auth_expired', pending: 1, lastSyncedAt: at });
  });

  it('a throwing subscriber does not break the run', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    a.engine.subscribe(() => { throw new Error('boom'); });
    await a.repo.create('todos', { title: 'x' });
    expect(await a.engine.sync()).toMatchObject({ outcome: 'ok', pushed: 1 });
  });
});

describe('push: two tabs on one browser', () => {
  it('two tabs syncing at once under one lock push each op once', async () => {
    const name = `shared-${Math.random()}`;
    const db1 = await openLocalDb(name);
    const db2 = await openLocalDb(name);
    opened.push(db1, db2);
    const locks = fakeLocks();
    const repo1 = createRepo(db1, { userId: () => U });
    const tab1 = createSyncEngine({ db: db1, cloud: flaky, locks });
    const tab2 = createSyncEngine({ db: db2, cloud: flaky, locks });
    await repo1.create('todos', { title: 'x' });
    await repo1.create('todos', { title: 'y' });
    const spy = vi.spyOn(flaky, 'push');
    const [r1, r2] = await Promise.all([tab1.sync(), tab2.sync()]);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(r1.pushed + r2.pushed).toBe(2);
    expect(await cloudRowCount()).toBe(2);
    expect(await queue(db2)).toEqual([]);
  });

  it('a second run after the first one finished starts afresh', async () => {
    await a.repo.create('todos', { title: 'x' });
    const first = a.engine.sync();
    expect(a.engine.sync()).toBe(first);
    await first;
    await a.repo.create('todos', { title: 'y' });
    const second = a.engine.sync();
    expect(second).not.toBe(first);
    expect(await second).toMatchObject({ pushed: 1 });
  });
});
