import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openLocalDb, type LocalDb } from '../../src/data/local-db';
import { createRepo, type Repo } from '../../src/data/repo';
import { buildBackup } from '../../src/backup/export-json';
import { validateBackup } from '../../src/backup/validate';

const U = '11111111-1111-4111-8111-111111111111';
let dbCount = 0;
let db: LocalDb;
let repo: Repo;

beforeEach(async () => {
  db = await openLocalDb(`backup-test-${++dbCount}`);
  let n = 0;
  repo = createRepo(db, {
    userId: () => U,
    now: () => new Date('2026-11-05T10:00:00.000Z'),
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  });
});

afterEach(() => db.close());

// A local tombstone: purged_at set and content reset.
async function makeTombstone(id: string): Promise<void> {
  const row = await db.raw.get('todos', id);
  await db.raw.put('todos', {
    ...row,
    title: '',
    note: '',
    steps: [],
    purged_at: '2026-11-05T11:00:00.000Z',
  });
}

describe('buildBackup', () => {
  it('exports format, version and exported_at', async () => {
    const f = await buildBackup(db, () => new Date('2026-11-05T00:00:00Z'));
    expect(f).toMatchObject({
      format: 'productivity-app-export',
      version: 1,
      exported_at: '2026-11-05T00:00:00.000Z',
    });
  });

  it('includes trashed records, excludes tombstones, and strips server-managed fields', async () => {
    const live = await repo.create('todos', { title: 'a' });
    const gone = await repo.create('todos', { title: 'b' });
    await repo.remove('todos', gone.id);
    const dead = await repo.create('todos', { title: 'c' });
    await makeTombstone(dead.id);
    const f = await buildBackup(db);
    expect(f.tables.todos.map((r) => r.id).sort()).toEqual([live.id, gone.id].sort());
    for (const r of f.tables.todos) {
      expect(r).not.toHaveProperty('user_id');
      expect(r).not.toHaveProperty('rev');
      expect(r).not.toHaveProperty('purged_at');
    }
    expect(f.tables.todos.find((r) => r.id === gone.id)!.deleted_at).not.toBeNull();
    expect(f.tables.todos.find((r) => r.id === live.id)).toMatchObject({
      title: 'a',
      created_at: expect.any(String),
      updated_at: expect.any(String),
    });
  });

  it('has an empty array for every table that does not exist yet', async () => {
    const f = await buildBackup(db);
    for (const k of ['event_overrides', 'notes', 'journal'] as const) {
      expect(f.tables[k]).toEqual([]);
    }
  });

  it('exports events, trashed ones included, tombstones left out', async () => {
    const live = await repo.create('events', { title: 'a', starts_at: '2026-11-23' });
    const gone = await repo.create('events', { title: 'b', starts_at: '2026-11-24' });
    await repo.remove('events', gone.id);
    const dead = await repo.create('events', { title: 'c', starts_at: '2026-11-25' });
    const row = await db.raw.get('events', dead.id);
    await db.raw.put('events', { ...row, title: '', note: '', purged_at: '2026-11-05T11:00:00.000Z' });
    const f = await buildBackup(db);
    expect(f.tables.events.map((r) => r.id).sort()).toEqual([live.id, gone.id].sort());
    for (const r of f.tables.events) {
      expect(r).not.toHaveProperty('user_id');
      expect(r).not.toHaveProperty('rev');
      expect(r).not.toHaveProperty('purged_at');
    }
    expect(f.tables.events.find((r) => r.id === gone.id)!.deleted_at).not.toBeNull();
    expect(validateBackup(JSON.parse(JSON.stringify(f)))).toMatchObject({ ok: true });
  });

  it('does not change the stored records', async () => {
    const t = await repo.create('todos', { title: 'a' });
    const before = await db.raw.get('todos', t.id);
    await buildBackup(db);
    expect(await db.raw.get('todos', t.id)).toEqual(before);
    expect(before).toHaveProperty('user_id');
    expect(before).toHaveProperty('rev');
  });
});
