import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalDb } from '../../src/data/local-db';
import type { PullPage, PushResult, QueuedOp, TodoRecord } from '../../src/domain/types';
import { CloudError, type CloudClient } from '../../src/sync/cloud';
import { PULL_REWIND, type SyncStatus } from '../../src/sync/engine';
import { TEST_USER_A, createTestDb, makeTombstone as tombstoneIn, rowOf, type TestDb } from '../db/harness';
import { createDevice, type Device, type DeviceOptions } from '../helpers/device';
import { createFlakyCloud, type FlakyCloud } from '../helpers/flaky-cloud';
import { createPgliteCloud } from '../helpers/pglite-cloud';
import { seedAndSync } from '../helpers/sync-helpers';

const U = TEST_USER_A;

let t: TestDb;
let cloud: CloudClient;
let flakyA: FlakyCloud;
let a: Device;
let b: Device;
let opened: LocalDb[];

async function device(o: Omit<DeviceOptions, 'userId'> & { userId?: string }): Promise<Device> {
  const d = await createDevice({ userId: U, ...o });
  opened.push(d.db);
  return d;
}

beforeEach(async () => {
  opened = [];
  t = await createTestDb();
  cloud = createPgliteCloud(t, U);
  flakyA = createFlakyCloud(cloud);
  a = await device({ name: 'a', cloud: flakyA });
  b = await device({ name: 'b', cloud });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of opened) db.close();
  await t.pg.close();
});

const makeTombstone = (id: string) => tombstoneIn(t, id);
const queue = (d: Device): Promise<QueuedOp[]> => d.db.raw.getAll('queue');
const rawTodo = (d: Device, id: string): Promise<TodoRecord | undefined> => d.db.raw.get('todos', id);

/** Another device's write, straight into the cloud (bumps rev through the trigger). */
async function serverSet(id: string, sql: string): Promise<void> {
  await t.asRole('postgres');
  await t.pg.query(`update todos set ${sql} where id = $1`, [id]);
}

describe('pull: the brief', () => {
  it('applies rows with a higher rev and ignores equal or lower ones', async () => {
    await b.repo.create('todos', { title: 'x' }); await b.engine.sync(); expect(await a.engine.sync()).toMatchObject({ pulled: 1 });
    expect(await a.engine.sync()).toMatchObject({ pulled: 0 });
  });
  it('rewinds the cursor by 100 and re-applies nothing twice', async () => {
    await seedAndSync(b, 3); await a.engine.sync(); const c = await a.db.getMeta<number>('cursor');
    expect(await a.engine.sync()).toMatchObject({ pulled: 0 }); expect(await a.db.getMeta('cursor')).toBe(c);
  });
  it('walks through all pages', async () => {
    const small = await device({ name: 'small', cloud, pageSize: 2 }); await seedAndSync(b, 5);
    expect(await small.engine.sync()).toMatchObject({ pulled: 5 }); expect(await small.repo.list('todos')).toHaveLength(5);
  });
  it('a pulled tombstone removes the record from every list', async () => {
    const r = await b.repo.create('todos', { title: 'x' }); await b.engine.sync(); await a.engine.sync(); await makeTombstone(r.id); await a.engine.sync();
    expect(await a.repo.get('todos', r.id)).toBeUndefined(); expect(await a.repo.list('todos', { trashed: true })).toHaveLength(0);
  });
  it('a fresh install creates db_id, downloads everything and sets the cursor', async () => {
    await seedAndSync(b, 3); const fresh = await device({ name: 'fresh', cloud });
    expect(await fresh.engine.sync()).toMatchObject({ pulled: 3 }); expect(await fresh.db.getMeta<number>('cursor')).toBeGreaterThan(0);
  });
  it('a local edit made while a sync is running stays visible on top of the pulled server row', async () => {
    const r = await b.repo.create('todos', { title: 'x' }); await b.engine.sync();
    let hook: (() => Promise<unknown>) | undefined;
    const hooked: CloudClient = { ...cloud, pull: async (s, l) => { await hook?.(); return cloud.pull(s, l); } };
    const h = await device({ name: 'hooked', cloud: hooked }); await h.engine.sync();
    await b.repo.update('todos', r.id, { done: true }); await b.engine.sync();
    hook = () => h.repo.update('todos', r.id, { title: 'mine' });
    await h.engine.sync();
    expect(await h.repo.get('todos', r.id)).toMatchObject({ title: 'mine', done: true });
  });
});

describe('pull: paging and the cursor', () => {
  it('asks for since = max(0, cursor - 100) with the page size, then from the last rev of each page', async () => {
    const small = await device({ name: 'small', cloud, pageSize: 2 });
    const pullSpy = vi.spyOn(cloud, 'pull');
    await seedAndSync(b, 5);
    pullSpy.mockClear();
    await small.engine.sync();
    const revs = (await small.db.raw.getAll('todos') as TodoRecord[]).map((r) => r.rev).sort((x, y) => x - y);
    expect(pullSpy.mock.calls).toEqual([[0, 2], [revs[1], 2], [revs[3], 2]]);
    expect(await small.db.getMeta('cursor')).toBe(revs[4]);
    pullSpy.mockClear();
    await small.engine.sync();
    expect(pullSpy.mock.calls[0]).toEqual([Math.max(0, revs[4] - PULL_REWIND), 2]);
  });
  it('uses the cursor minus the rewind when the cursor is large', async () => {
    await a.db.setMeta('cursor', 1000);
    const pullSpy = vi.spyOn(flakyA, 'pull');
    await a.engine.sync();
    expect(pullSpy.mock.calls[0]).toEqual([1000 - PULL_REWIND, 500]);
    // Nothing above rev 900 in the cloud: the cursor never goes backwards.
    expect(await a.db.getMeta('cursor')).toBe(1000);
  });
  it('the cursor never decreases even when a page only holds older revs', async () => {
    const [r] = await seedAndSync(b, 1); await a.engine.sync();
    const c = (await a.db.getMeta<number>('cursor'))!;
    await a.db.setMeta('cursor', c + 50);
    await serverSet(r.id, `title = 'again'`);
    expect(await a.engine.sync()).toMatchObject({ pulled: 1 });
    expect(await a.db.getMeta('cursor')).toBe(c + 50);
  });
  it('the cursor is stored as a plain number under the out-of-line key', async () => {
    await seedAndSync(b, 2); await a.engine.sync();
    const tx = a.db.raw.transaction('meta', 'readonly');
    expect(typeof (await tx.store.get('cursor'))).toBe('number');
    expect(await tx.store.getAllKeys()).toEqual(expect.arrayContaining(['cursor', 'db_id']));
    expect(await tx.store.count()).toBe(2);
  });
  it('a pull error mid-paging keeps what earlier pages committed and reports the outcome', async () => {
    const f = createFlakyCloud(cloud);
    const small = await device({ name: 'small', cloud: f, pageSize: 2 });
    await seedAndSync(b, 5);
    let calls = 0;
    const real = f.pull;
    f.pull = async (s, l) => { if (++calls === 2) f.failNext('network'); return real(s, l); };
    const report = await small.engine.sync();
    expect(report).toMatchObject({ outcome: 'offline', pulled: 2 });
    const revs = (await small.db.raw.getAll('todos') as TodoRecord[]).map((r) => r.rev).sort((x, y) => x - y);
    expect(revs).toHaveLength(2);
    expect(await small.db.getMeta('cursor')).toBe(revs[1]);
    expect(small.engine.status()).toMatchObject({ state: 'offline', lastSyncedAt: null });
    expect(await small.engine.sync()).toMatchObject({ outcome: 'ok', pulled: 3 });
    expect(await small.repo.list('todos')).toHaveLength(5);
  });
  it('an auth or unavailable error while pulling gives that outcome', async () => {
    await seedAndSync(b, 1);
    flakyA.failNext('auth');
    expect(await a.engine.sync()).toMatchObject({ outcome: 'auth_expired', pulled: 0 });
    flakyA.failNext('unavailable');
    expect(await a.engine.sync()).toMatchObject({ outcome: 'unavailable', pulled: 0 });
    expect(await a.engine.sync()).toMatchObject({ outcome: 'ok', pulled: 1 });
  });
  it('does not pull when the push stopped on a network error', async () => {
    await seedAndSync(b, 1);
    await a.repo.create('todos', { title: 'mine' });
    const pullSpy = vi.spyOn(flakyA, 'pull');
    flakyA.failNext('network');
    expect(await a.engine.sync()).toMatchObject({ outcome: 'offline', pulled: 0 });
    expect(pullSpy).not.toHaveBeenCalled();
  });
  it('still pulls when the push only had failed (rejected) ops', async () => {
    await seedAndSync(b, 1);
    vi.spyOn(flakyA, 'push').mockResolvedValueOnce({ status: 'invalid', conflict: false, rev: null, record: null, message: 'bad' } as PushResult);
    await a.repo.create('todos', { title: 'mine' });
    expect(await a.engine.sync()).toMatchObject({ outcome: 'ok', failed: 1, pulled: 1 });
  });
  it('an empty page with has_more true does not loop forever', async () => {
    const page: PullPage = { rows: [], has_more: true };
    const pullSpy = vi.spyOn(flakyA, 'pull').mockResolvedValue(page);
    expect(await a.engine.sync()).toMatchObject({ outcome: 'ok', pulled: 0 });
    expect(pullSpy).toHaveBeenCalledTimes(1);
  });
});

describe('pull: applying rows', () => {
  it('a row with rev lower or equal to the local one is ignored', async () => {
    const r = await a.repo.create('todos', { title: 'x' }); await a.engine.sync();
    const local = (await rawTodo(a, r.id))!;
    const stale = { ...(await rowOf(t, r.id)), title: 'stale' };
    vi.spyOn(flakyA, 'pull').mockResolvedValueOnce({ rows: [{ table: 'todos', row: { ...stale, rev: local.rev } }, { table: 'todos', row: { ...stale, rev: local.rev - 1 } }], has_more: false });
    expect(await a.engine.sync()).toMatchObject({ pulled: 0 });
    expect(await rawTodo(a, r.id)).toEqual(local);
  });
  it('a record with no pending ops becomes the server row, with deleted_at and purged_at present', async () => {
    const r = await b.repo.create('todos', { title: 'x', note: 'n' }); await b.engine.sync();
    const row = await rowOf(t, r.id);
    const { deleted_at: _d, purged_at: _p, ...bare } = row;
    vi.spyOn(flakyA, 'pull').mockResolvedValueOnce({ rows: [{ table: 'todos', row: { ...bare, rev: String(row.rev) } }], has_more: false });
    expect(await a.engine.sync()).toMatchObject({ pulled: 1 });
    const local = (await rawTodo(a, r.id))! as unknown as Record<string, unknown>;
    expect(local).toHaveProperty('deleted_at', null);
    expect(local).toHaveProperty('purged_at', null);
    expect(local.rev).toBe(Number(row.rev));
    expect(await a.repo.get('todos', r.id)).toMatchObject({ title: 'x', note: 'n' });
  });
  it('a pulled trashed row shows in the trash', async () => {
    const r = await b.repo.create('todos', { title: 'x' }); await b.engine.sync(); await a.engine.sync();
    await b.repo.remove('todos', r.id); await b.engine.sync();
    expect(await a.engine.sync()).toMatchObject({ pulled: 1 });
    expect(await a.repo.list('todos')).toHaveLength(0);
    expect(await a.repo.list('todos', { trashed: true })).toHaveLength(1);
  });
  it('a tombstone for a record never seen is stored as a tombstone, keeping purged_at', async () => {
    const r = await b.repo.create('todos', { title: 'x' }); await b.engine.sync(); await makeTombstone(r.id);
    const row = await rowOf(t, r.id);
    expect(await a.engine.sync()).toMatchObject({ pulled: 1 });
    const local = (await rawTodo(a, r.id))!;
    expect(local.purged_at).not.toBeNull();
    expect(new Date(local.purged_at!).getTime()).toBe(new Date(row.purged_at).getTime());
    expect(await a.repo.get('todos', r.id)).toBeUndefined();
  });
  it('a pulled tombstone while ops are still pending (added during the pull) drops them', async () => {
    const r = await b.repo.create('todos', { title: 'x' }); await b.engine.sync();
    const other = await b.repo.create('todos', { title: 'other' }); await b.engine.sync();
    let hook: (() => Promise<unknown>) | undefined;
    const hooked: CloudClient = { ...cloud, pull: async (s, l) => { await hook?.(); return cloud.pull(s, l); } };
    const h = await device({ name: 'hooked', cloud: hooked }); await h.engine.sync();
    await makeTombstone(r.id);
    hook = async () => { await h.repo.update('todos', r.id, { title: 'late' }); await h.repo.update('todos', other.id, { title: 'kept' }); };
    expect(await h.engine.sync()).toMatchObject({ pulled: 1 });
    hook = undefined;
    const q = await queue(h);
    expect(q.map((op) => op.id)).toEqual([other.id]);
    expect(await h.repo.get('todos', r.id)).toBeUndefined();
    expect(h.engine.status()).toMatchObject({ pending: 1 });
  });
  it('pending ops overlay the pulled row in seq order and keep their base_rev', async () => {
    const r = await b.repo.create('todos', { title: 'x' }); await b.engine.sync();
    let hook: (() => Promise<unknown>) | undefined;
    const hooked: CloudClient = { ...cloud, pull: async (s, l) => { await hook?.(); return cloud.pull(s, l); } };
    const h = await device({ name: 'hooked', cloud: hooked }); await h.engine.sync();
    const base = (await rawTodo(h, r.id))!.rev;
    await b.repo.update('todos', r.id, { done: true, note: 'server' }); await b.engine.sync();
    hook = async () => {
      await h.repo.update('todos', r.id, { title: 'one', note: 'first' });
      await h.repo.update('todos', r.id, { note: 'second' });
    };
    await h.engine.sync();
    hook = undefined;
    const server = await rowOf(t, r.id);
    expect(await rawTodo(h, r.id)).toMatchObject({ title: 'one', note: 'second', done: true, rev: Number(server.rev) });
    const q = await queue(h);
    expect(q.map((op) => op.base_rev)).toEqual([base, base]);
    // Pushing them later still makes both devices agree.
    await h.engine.sync(); await b.engine.sync();
    expect(await b.repo.get('todos', r.id)).toMatchObject({ title: 'one', note: 'second', done: true });
  });
  it('failed ops are not overlaid', async () => {
    const r = await b.repo.create('todos', { title: 'x' }); await b.engine.sync(); await a.engine.sync();
    vi.spyOn(flakyA, 'push').mockResolvedValueOnce({ status: 'invalid', conflict: false, rev: null, record: null, message: 'bad' } as PushResult);
    await a.repo.update('todos', r.id, { title: 'refused' });
    await b.repo.update('todos', r.id, { done: true }); await b.engine.sync();
    expect(await a.engine.sync()).toMatchObject({ failed: 1, pulled: 1 });
    expect(await a.repo.get('todos', r.id)).toMatchObject({ title: 'x', done: true });
  });
  it('a pending delete keeps the record trashed over a live pulled row', async () => {
    const r = await b.repo.create('todos', { title: 'x' }); await b.engine.sync();
    let hook: (() => Promise<unknown>) | undefined;
    const hooked: CloudClient = { ...cloud, pull: async (s, l) => { await hook?.(); return cloud.pull(s, l); } };
    const h = await device({ name: 'hooked', cloud: hooked }); await h.engine.sync();
    await b.repo.update('todos', r.id, { done: true }); await b.engine.sync();
    hook = () => h.repo.remove('todos', r.id);
    await h.engine.sync();
    hook = undefined;
    const local = (await rawTodo(h, r.id))!;
    expect(local.deleted_at).not.toBeNull();
    expect(local.done).toBe(true);
    expect(await h.repo.list('todos', { trashed: true })).toHaveLength(1);
    await h.engine.sync(); await b.engine.sync();
    expect(await b.repo.list('todos', { trashed: true })).toHaveLength(1);
  });
  it('a pending restore keeps the record live over a trashed pulled row', async () => {
    const r = await b.repo.create('todos', { title: 'x' }); await b.engine.sync();
    let hook: (() => Promise<unknown>) | undefined;
    const hooked: CloudClient = { ...cloud, pull: async (s, l) => { await hook?.(); return cloud.pull(s, l); } };
    const h = await device({ name: 'hooked', cloud: hooked });
    await b.repo.remove('todos', r.id); await b.engine.sync();
    await h.engine.sync();
    expect(await h.repo.list('todos', { trashed: true })).toHaveLength(1);
    await serverSet(r.id, `title = 'renamed'`);
    hook = () => h.repo.restore('todos', r.id);
    await h.engine.sync();
    hook = undefined;
    const local = (await rawTodo(h, r.id))!;
    expect(local).toMatchObject({ deleted_at: null, title: 'renamed' });
    await h.engine.sync(); await b.engine.sync();
    expect(await b.repo.get('todos', r.id)).toMatchObject({ deleted_at: null, title: 'renamed' });
  });
  it('rows of a table this client does not know are skipped but the cursor moves past them', async () => {
    vi.spyOn(flakyA, 'pull').mockResolvedValueOnce({ rows: [{ table: 'mystery' as never, row: { id: 'x', rev: 7 } }], has_more: false });
    expect(await a.engine.sync()).toMatchObject({ outcome: 'ok', pulled: 0 });
    expect(await a.db.getMeta('cursor')).toBe(7);
  });
});

describe('pull: status', () => {
  it('tells subscribers after a run that only pulled, and sets lastSyncedAt', async () => {
    await seedAndSync(b, 2);
    const seen: SyncStatus[] = [];
    a.engine.subscribe((s) => seen.push(s));
    expect(await a.engine.sync()).toMatchObject({ pulled: 2 });
    expect(seen.at(-1)).toMatchObject({ state: 'idle' });
    expect(seen.at(-1)!.lastSyncedAt).not.toBeNull();
  });
});

describe('push: a stale replayed result never lowers base_rev', () => {
  it('keeps the higher base_rev of a later queued op', async () => {
    const r = await a.repo.create('todos', { title: 'x' }); await a.engine.sync();
    const oldRev = (await rawTodo(a, r.id))!.rev;
    await serverSet(r.id, `done = true`);
    await a.engine.sync();
    const newRev = (await rawTodo(a, r.id))!.rev;
    expect(newRev).toBeGreaterThan(oldRev);
    await a.repo.update('todos', r.id, { title: 'one' });
    await a.repo.update('todos', r.id, { title: 'two' });
    // The first push gets an old, replayed result (as when another tab already pushed it); then the network goes.
    const stale = { ...(await rowOf(t, r.id)), rev: oldRev };
    vi.spyOn(flakyA, 'push')
      .mockResolvedValueOnce({ status: 'applied', conflict: false, rev: oldRev, record: stale, message: null })
      .mockRejectedValueOnce(new CloudError('network'));
    await a.engine.sync();
    const q = await queue(a);
    expect(q).toHaveLength(1);
    expect(q[0].base_rev).toBe(newRev);
  });
});
