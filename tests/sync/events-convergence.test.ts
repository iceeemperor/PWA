import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openLocalDb } from '../../src/data/local-db';
import { createRepo } from '../../src/data/repo';
import { buildAgenda } from '../../src/agenda/agenda';
import type { EventRecord, TodoRecord } from '../../src/domain/types';
import type { CloudClient } from '../../src/sync/cloud';
import { createSyncEngine } from '../../src/sync/engine';
import { TEST_USER_A, createTestDb, rowOf, type TestDb } from '../db/harness';
import { createDevice, type Device, type DeviceOptions } from '../helpers/device';
import { createFlakyCloud, type FlakyCloud } from '../helpers/flaky-cloud';
import { createPgliteCloud } from '../helpers/pglite-cloud';
import { snapshot } from '../helpers/sync-helpers';
import { seedVersion1 } from '../helpers/version1-db';

const U = TEST_USER_A;
const DAY = { title: 'Dentist', starts_at: '2026-11-25' };

let t: TestDb;
let cloud: CloudClient;
let flakyA: FlakyCloud;
let a: Device;
let b: Device;
let opened: { close(): void }[];

async function track(o: Omit<DeviceOptions, 'userId'>): Promise<Device> {
  const d = await createDevice({ userId: U, ...o });
  opened.push(d.db);
  return d;
}

/** Every local event record (live, trashed, tombstones), sorted by id. */
async function eventsOf(d: Device) {
  return ((await d.db.raw.getAll('events')) as Record<string, unknown>[]).sort((x, y) => String(x.id).localeCompare(String(y.id)));
}

beforeEach(async () => {
  opened = [];
  t = await createTestDb();
  cloud = createPgliteCloud(t, U);
  flakyA = createFlakyCloud(cloud);
  a = await track({ name: 'a', cloud: flakyA });
  b = await track({ name: 'b', cloud });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of opened) d.close();
  await t.pg.close();
});

describe('events converge across devices and offline', () => {
  it("an important event made on one device shows in the other device's upcoming list", async () => {
    const e = await a.repo.create('events', { ...DAY, important: true });
    await a.engine.sync(); await b.engine.sync();
    const todos = (await b.repo.list('todos')) as TodoRecord[];
    const events = (await b.repo.list('events')) as EventRecord[];
    const agenda = buildAgenda(todos, events, { now: new Date('2026-11-23T04:00:00Z'), tz: 'Asia/Shanghai', mode: 'date', showDone: false });
    expect(await b.repo.get('events', e.id)).toMatchObject({ important: true });
    expect(agenda.groups.flatMap((g) => g.items).map((i) => i.id)).toContain(e.id);
  });

  it('done on one device and a new title on the other both survive', async () => {
    const e = await a.repo.create('events', DAY); await a.engine.sync(); await b.engine.sync();
    await a.repo.update('events', e.id, { done: true });
    await b.repo.update('events', e.id, { title: 'Dentist (moved)' });
    await a.engine.sync(); await b.engine.sync(); await a.engine.sync();
    for (const d of [a, b]) expect(await d.repo.get('events', e.id)).toMatchObject({ done: true, title: 'Dentist (moved)' });
    expect(await snapshot(a)).toEqual(await snapshot(b));
    expect(await eventsOf(a)).toEqual(await eventsOf(b));
  });

  it('deleting an event on one device beats an offline edit on the other', async () => {
    const e = await a.repo.create('events', DAY); await a.engine.sync(); await b.engine.sync();
    await a.repo.remove('events', e.id); await a.engine.sync();
    await b.repo.update('events', e.id, { title: 'late' });
    expect(await b.engine.sync()).toMatchObject({ dropped: 1 });
    await a.engine.sync();
    for (const d of [a, b]) {
      expect(await d.repo.list('events', { trashed: true })).toHaveLength(1);
      expect(await d.repo.list('events')).toHaveLength(0);
    }
    expect(await eventsOf(a)).toEqual(await eventsOf(b));
  });

  it('a purged event reaches every device as a tombstone and leaves the trash list', async () => {
    const e = await a.repo.create('events', DAY); await a.engine.sync(); await b.engine.sync();
    await a.repo.remove('events', e.id); await a.engine.sync(); await b.engine.sync();
    expect(await b.repo.list('events', { trashed: true })).toHaveLength(1);
    // The purge: content back to its defaults, purged_at and deleted_at set (the trigger bumps rev).
    await t.asRole('postgres');
    await t.pg.query(
      `update events set purged_at = now(), deleted_at = now(), title = default, all_day = default, starts_at = default,
         ends_at = default, tz = default, note = default, important = default, done = default, rrule = default
       where id = $1`, [e.id]);
    expect((await rowOf(t, e.id, 'events')).purged_at).not.toBeNull();
    await a.engine.sync(); await b.engine.sync();
    for (const d of [a, b]) {
      expect(await d.repo.get('events', e.id)).toBeUndefined();
      expect(await d.repo.list('events', { trashed: true })).toHaveLength(0);
    }
    expect(await eventsOf(a)).toEqual(await eventsOf(b));
  });

  it('a stage-1 device that upgrades pulls the events it skipped before', async () => {
    const e = await a.repo.create('events', DAY); await a.engine.sync();
    const server = await rowOf(t, e.id, 'events');
    // Stage 1 skipped the unknown table but still advanced its cursor past the row.
    const name = `stage1-${Math.random()}`;
    (await seedVersion1(name, {
      todos: [], queue: [], meta: { db_id: '00000000-0000-4000-8000-0000000000d1', cursor: Number(server.rev) + 500 },
    })).close();
    const db = await openLocalDb(name);
    opened.push(db);
    const repo = createRepo(db, { userId: () => U });
    const engine = createSyncEngine({ db, cloud });
    expect(await db.raw.getAll('events')).toEqual([]);
    await engine.sync();
    expect(await repo.get('events', e.id)).toMatchObject({ title: 'Dentist', starts_at: '2026-11-25' });
  });

  it('offline event edits replay in order after reconnecting', async () => {
    flakyA.failNext('network', 99);
    const e = await a.repo.create('events', DAY);
    await a.repo.update('events', e.id, { title: 'Dentist v2' });
    await a.repo.update('events', e.id, { done: true });
    await a.repo.update('events', e.id, { title: 'Dentist v3' });
    await a.engine.sync();
    await b.engine.sync();
    expect(await b.repo.get('events', e.id)).toBeUndefined();
    flakyA.failNext('network', 0);
    await a.engine.sync(); await b.engine.sync();
    expect(await b.repo.get('events', e.id)).toMatchObject({ title: 'Dentist v3', done: true });
    expect(await eventsOf(a)).toEqual(await eventsOf(b));
  });
});
