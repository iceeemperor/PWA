import { afterEach, expect, it } from 'vitest';
import { openLocalDb, type LocalDb } from '../../src/data/local-db';
import { TABLE_DEFAULTS } from '../../src/domain/tables';
import type { PushResult } from '../../src/domain/types';
import type { CloudClient } from '../../src/sync/cloud';
import { createSyncEngine } from '../../src/sync/engine';

let db: LocalDb;
afterEach(() => db.close());

// A cloud that answers every push with dropped_purged (no record) and has nothing to pull.
const purgedCloud: CloudClient = {
  push: async (): Promise<PushResult> => ({ status: 'dropped_purged', conflict: false, rev: null, record: null, message: null }),
  pull: async () => ({ rows: [], has_more: false }),
  purgeExpired: async () => {},
  importBackup: async () => ({ added: 0, restored: 0, skipped: {} }),
};

it('a purged event becomes a tombstone whose content is TABLE_DEFAULTS.events', async () => {
  db = await openLocalDb(`tombstone-events-${Math.random()}`);
  const id = '00000000-0000-4000-8000-0000000000e1';
  await db.raw.put('events', {
    id, user_id: 'u', created_at: 'c', updated_at: 'u', rev: 4, deleted_at: null, purged_at: null,
    title: '会', all_day: false, starts_at: '2026-11-23T09:00', ends_at: '2026-11-23T10:00', tz: 'Asia/Shanghai',
    note: 'secret', important: true, done: true, rrule: null,
  });
  await db.raw.add('queue', { op_id: 'op', table: 'events', id, kind: 'update', base_rev: 4, fields: { note: 'secret' }, failed: null });
  const engine = createSyncEngine({ db, cloud: purgedCloud });
  expect(await engine.sync()).toMatchObject({ outcome: 'ok', dropped: 1 });
  const stored = (await db.raw.get('events', id)) as Record<string, unknown>;
  expect(stored).toMatchObject({ ...TABLE_DEFAULTS.events, id, rev: 4 });
  expect(stored.purged_at).not.toBeNull();
  expect(await db.raw.getAll('queue')).toEqual([]);
});
