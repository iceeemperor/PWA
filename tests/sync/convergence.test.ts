import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalDb } from '../../src/data/local-db';
import type { CloudClient } from '../../src/sync/cloud';
import { TEST_USER_A, createTestDb, makeTombstone as tombstoneIn, type TestDb } from '../db/harness';
import { createDevice, type Device, type DeviceOptions } from '../helpers/device';
import { createFlakyCloud, type FlakyCloud } from '../helpers/flaky-cloud';
import { createPgliteCloud } from '../helpers/pglite-cloud';
import { cloudRowCount as countIn, cloudRows as rowsIn, seedAndSync, snapshot } from '../helpers/sync-helpers';

const U = TEST_USER_A;

let t: TestDb;
let cloud: CloudClient;
let flakyA: FlakyCloud;
let flakyB: FlakyCloud;
let a: Device;
let b: Device;
let opened: LocalDb[];

async function createTracked(o: DeviceOptions): Promise<Device> {
  const d = await createDevice(o);
  opened.push(d.db);
  return d;
}

beforeEach(async () => {
  opened = [];
  t = await createTestDb();
  cloud = createPgliteCloud(t, U);
  flakyA = createFlakyCloud(cloud);
  flakyB = createFlakyCloud(cloud);
  a = await createTracked({ name: 'a', cloud: flakyA, userId: U });
  b = await createTracked({ name: 'b', cloud: flakyB, userId: U });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of opened) db.close();
  await t.pg.close();
});

const cloudRows = () => rowsIn(t);
const cloudRowCount = () => countIn(t);
const makeTombstone = (id: string) => tombstoneIn(t, id);
const createDeviceT = createTracked;

describe('convergence: the brief', () => {
  it('clearing browser data never deletes anything in the cloud', async () => {
    await seedAndSync(a, 3); const before = await cloudRowCount(); const fresh = await a.reopenFresh(); opened.push(fresh.db); await fresh.engine.sync();
    expect(await cloudRowCount()).toBe(before); expect(await fresh.repo.list('todos')).toHaveLength(3);
  });
  it('edits to different fields on two devices both survive and both devices converge', async () => {
    const r = await a.repo.create('todos', { title: 'x' }); await a.engine.sync(); await b.engine.sync();
    await a.repo.update('todos', r.id, { title: 'A title' }); await b.repo.update('todos', r.id, { done: true });
    await a.engine.sync(); await b.engine.sync(); await a.engine.sync();
    expect(await a.repo.get('todos', r.id)).toMatchObject({ title: 'A title', done: true }); expect(await snapshot(a)).toEqual(await snapshot(b));
  });
  it('deleting on one device beats an offline edit on the other', async () => {
    const r = await a.repo.create('todos', { title: 'x' }); await a.engine.sync(); await b.engine.sync();
    await a.repo.remove('todos', r.id); await a.engine.sync(); await b.repo.update('todos', r.id, { title: 'late' });
    expect(await b.engine.sync()).toMatchObject({ dropped: 1 }); expect(await b.repo.list('todos', { trashed: true })).toHaveLength(1);
  });
  it('offline writes replay in order after reconnecting', async () => {
    flakyA.failNext('network', 99); const r = await a.repo.create('todos', { title: 'x' }); await a.repo.update('todos', r.id, { done: true }); await a.engine.sync();
    flakyA.failNext('network', 0); await a.engine.sync(); await b.engine.sync();
    expect(await b.repo.get('todos', r.id)).toMatchObject({ title: 'x', done: true });
  });
  it('a wrong device clock does not affect server timestamps or rev order', async () => {
    const skewed = await createDeviceT({ name: 'skew', cloud, userId: U, now: () => new Date('2036-01-01T00:00:00Z') });
    await skewed.repo.create('todos', { title: 'x' }); await skewed.engine.sync(); const [row] = await cloudRows();
    expect(new Date(row.updated_at).getFullYear()).toBeLessThan(2036);
  });
});

describe('convergence: more devices and states', () => {
  it('three devices with mixed edits, a trash and a tombstone end up identical', async () => {
    const c = await createTracked({ name: 'c', cloud, userId: U });
    const [x, y, z] = await seedAndSync(a, 3);
    await b.engine.sync(); await c.engine.sync();
    await a.repo.update('todos', x.id, { title: 'from a' });
    await b.repo.update('todos', x.id, { priority: 'high' });
    await c.repo.remove('todos', y.id);
    await b.repo.update('todos', z.id, { note: 'n' });
    await makeTombstone(z.id);
    for (let i = 0; i < 2; i++) { await a.engine.sync(); await b.engine.sync(); await c.engine.sync(); }
    const sa = await snapshot(a);
    expect(sa.queued).toBe(0);
    expect(await snapshot(b)).toEqual(sa);
    expect(await snapshot(c)).toEqual(sa);
    expect(await a.repo.get('todos', x.id)).toMatchObject({ title: 'from a', priority: 'high' });
    expect(await a.repo.list('todos', { trashed: true })).toHaveLength(1);
    expect(await a.repo.get('todos', z.id)).toBeUndefined();
    // Every device's copy matches the cloud's rev for each row.
    const revs = Object.fromEntries((await cloudRows()).map((r) => [r.id, Number(r.rev)]));
    for (const rec of sa.todos) expect(rec.rev).toBe(revs[rec.id as string]);
  });
  it('a fresh device catches up to an identical snapshot, tombstones included', async () => {
    const [x, y] = await seedAndSync(a, 3);
    await a.repo.remove('todos', x.id); await a.engine.sync(); await makeTombstone(y.id); await a.engine.sync();
    const fresh = await createTracked({ name: 'fresh', cloud, userId: U });
    await fresh.engine.sync();
    expect(await snapshot(fresh)).toEqual(await snapshot(a));
  });
  it('the conflict count reaches the report when another device changed the record first', async () => {
    const r = await a.repo.create('todos', { title: 'x' }); await a.engine.sync(); await b.engine.sync();
    await a.repo.update('todos', r.id, { title: 'A' }); await a.engine.sync();
    await b.repo.update('todos', r.id, { title: 'B' });
    expect(await b.engine.sync()).toMatchObject({ pushed: 1, conflicts: 1 });
    expect(b.engine.status().conflicts).toBe(1);
    await a.engine.sync();
    expect(await snapshot(a)).toEqual(await snapshot(b));
  });
});
