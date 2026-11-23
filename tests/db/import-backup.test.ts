import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDb, makeTombstone as makeTombstoneRaw, rowOf as rowOfRaw,
  TEST_USER_A as A, TEST_USER_B as B, type TestDb,
} from './harness';

type Row = Record<string, any>;
type Summary = { added: number; restored: number; skipped: Record<string, number> };

let t: TestDb;
let id1: string;
let id2: string;
beforeEach(async () => { t = await createTestDb(); id1 = randomUUID(); id2 = randomUUID(); });
afterEach(async () => { await t.pg.close(); });

const rowOf = (id: string) => rowOfRaw(t, id);
const makeTombstone = (id: string) => makeTombstoneRaw(t, id);
const revOf = async (id: string): Promise<number> => Number((await rowOf(id)).rev);

/** A todo as it appears in an export file (no user_id, rev or purged_at). */
function row(over: Row = {}): Row {
  return {
    id: randomUUID(), kind: 'todo', title: 'from file', done: false, priority: 'normal', due_date: null,
    note: '', steps: [], created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-02T00:00:00Z', deleted_at: null,
    ...over,
  };
}

/** import_backup as `uid` with `{ tables: { todos: rows } }`. */
async function imp(uid: string, rows: Row[], restore: boolean): Promise<Summary> {
  await t.asUser(uid);
  return (await t.pg.query<{ r: Summary }>('select import_backup($1::jsonb, $2) as r',
    [JSON.stringify({ tables: { todos: rows } }), restore])).rows[0].r;
}
async function impRaw(uid: string, payload: unknown, restore: boolean | null = false): Promise<Summary> {
  await t.asUser(uid);
  return (await t.pg.query<{ r: Summary }>('select import_backup($1::jsonb, $2) as r', [JSON.stringify(payload), restore])).rows[0].r;
}

/** A live todo for `uid` (default A) written as the superuser; rev from the trigger. */
async function seedRow(id: string, title: string, uid: string = A): Promise<void> {
  await t.asRole('postgres');
  await t.pg.query('insert into todos (id, user_id, title, created_at) values ($1, $2, $3, $4)',
    [id, uid, title, '2025-01-01T00:00:00Z']);
}
async function count(uid: string): Promise<number> {
  await t.asRole('postgres');
  return Number((await t.pg.query<{ n: number }>('select count(*)::int as n from todos where user_id = $1', [uid])).rows[0].n);
}
async function purgeAsCron(): Promise<void> { await t.asRole('postgres'); await t.pg.query('select purge_expired()'); }

describe('import_backup: the brief', () => {
  it('adds new rows keeping created_at, updated_at and trash state, with a new rev', async () => {
    const r = await imp(A, [row({ id: id1, created_at: '2025-01-01T00:00:00Z', updated_at: '2025-02-02T00:00:00Z', deleted_at: '2025-03-03T00:00:00Z' })], false);
    expect(r).toMatchObject({ added: 1, restored: 0 }); expect(await rowOf(id1)).toMatchObject({ updated_at: new Date('2025-02-02T00:00:00Z'), deleted_at: new Date('2025-03-03T00:00:00Z') });
    expect(await revOf(id1)).toBeGreaterThan(0);
  });
  it('skips ids that already exist with their content', async () => {
    await seedRow(id1, 'keep'); const r = await imp(A, [row({ id: id1, title: 'other' })], false);
    expect(r.skipped).toEqual({ exists: 1 }); expect((await rowOf(id1)).title).toBe('keep');
  });
  it('skips tombstones by default', async () => { await seedRow(id1, 'x'); await makeTombstone(id1); const r = await imp(A, [row({ id: id1, title: 'old' })], false); expect(r.skipped).toEqual({ purged: 1 }); expect((await rowOf(id1)).purged_at).not.toBeNull(); });
  it('restores tombstones when asked: content back, purged_at cleared, rev bumped', async () => {
    await seedRow(id1, 'x'); await makeTombstone(id1); const before = await revOf(id1);
    const r = await imp(A, [row({ id: id1, title: 'old', note: 'n' })], true);
    expect(r).toMatchObject({ restored: 1 }); expect(await rowOf(id1)).toMatchObject({ title: 'old', note: 'n', purged_at: null }); expect(await revOf(id1)).toBeGreaterThan(before);
  });
  it('a restored record that was in the trash gets a fresh deleted_at so the next purge keeps it', async () => {
    await seedRow(id1, 'x'); await makeTombstone(id1);
    await imp(A, [row({ id: id1, title: 'old', deleted_at: '2025-01-01T00:00:00Z' })], true); await purgeAsCron();
    expect((await rowOf(id1)).purged_at).toBeNull(); expect(Date.now() - (await rowOf(id1)).deleted_at.getTime()).toBeLessThan(60_000);
  });
  it('one invalid row aborts the whole import', async () => {
    await expect(imp(A, [row({ id: id1 }), row({ id: id2, title: '' })], false)).rejects.toThrow(); expect(await count(A)).toBe(0);
  });
  it('rows always belong to the caller', async () => { await imp(A, [row({ id: id1, user_id: B })], false); expect(await count(B)).toBe(0); expect(await count(A)).toBe(1); });
  it('anon cannot call import_backup', async () => { await t.asRole('anon'); await expect(t.pg.query(`select import_backup('{}', false)`)).rejects.toThrow(/permission denied/); });
});

describe('import_backup: edge cases', () => {
  it('an authenticated session without a subject raises not_authenticated (28000)', async () => {
    await t.asUser('');
    const err = await t.pg.query(`select import_backup('{"tables":{"todos":[]}}', false)`).then(() => null, (e: any) => e);
    expect(err?.message).toMatch(/not_authenticated/); expect(err?.code).toBe('28000');
  });
  it("an id owned by another user is skipped as exists and that row is left exactly as it was", async () => {
    await seedRow(id1, 'B secret', B); const before = await rowOf(id1);
    const r = await imp(A, [row({ id: id1, title: 'stolen' })], true);
    expect(r).toEqual({ added: 0, restored: 0, skipped: { exists: 1 } }); expect(await rowOf(id1)).toEqual(before);
  });
  it("another user's tombstone is not restored even with restore on", async () => {
    await seedRow(id1, 'x', B); await makeTombstone(id1); const before = await rowOf(id1);
    const r = await imp(A, [row({ id: id1, title: 'mine now' })], true);
    expect(r.skipped).toEqual({ exists: 1 }); expect(await rowOf(id1)).toEqual(before);
  });
  it('a trashed own row counts as exists, not purged, and is untouched', async () => {
    await seedRow(id1, 'keep'); await t.pg.query('update todos set deleted_at = now() where id = $1', [id1]); const before = await rowOf(id1);
    const r = await imp(A, [row({ id: id1, title: 'other' })], true);
    expect(r.skipped).toEqual({ exists: 1 }); expect(await rowOf(id1)).toEqual(before);
  });
  it('keeps the file\'s updated_at and created_at on insert but the rev comes from the sequence', async () => {
    await seedRow(id2, 'earlier'); const earlier = await revOf(id2);
    await imp(A, [row({ id: id1, created_at: '2024-05-05T05:05:05Z', updated_at: '2024-06-06T06:06:06Z', rev: 1 })], false);
    const r = await rowOf(id1);
    expect(r).toMatchObject({ created_at: new Date('2024-05-05T05:05:05Z'), updated_at: new Date('2024-06-06T06:06:06Z') });
    expect(Number(r.rev)).toBeGreaterThan(earlier);
  });
  it('the keep-updated_at flag does not outlive the import', async () => {
    await imp(A, [row({ id: id1 })], false);
    await t.asRole('postgres');
    await t.pg.query(`update todos set title = 'later' where id = $1`, [id1]);
    expect(Date.now() - (await rowOf(id1)).updated_at.getTime()).toBeLessThan(60_000);
  });
  it('payload keys user_id, rev and purged_at are ignored', async () => {
    await imp(A, [row({ id: id1, user_id: B, rev: 999999, purged_at: '2025-01-01T00:00:00Z' })], false);
    const r = await rowOf(id1);
    expect(r.user_id).toBe(A); expect(r.purged_at).toBeNull(); expect(Number(r.rev)).not.toBe(999999);
  });
  it('unknown keys in a row are ignored and missing content columns take their defaults', async () => {
    await imp(A, [{ id: id1, title: 't', bogus: 1, "x; drop table todos; --": 2 }], false);
    expect(await rowOf(id1)).toMatchObject({ title: 't', kind: 'todo', priority: 'normal', note: '', steps: [], deleted_at: null });
  });
  it('restore keeps created_at, takes updated_at from the file and clears deleted_at for a live file row', async () => {
    await seedRow(id1, 'x'); await makeTombstone(id1);
    await imp(A, [row({ id: id1, title: 'back', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-04-04T00:00:00Z', deleted_at: null, priority: 'high', steps: [{ id: 's', text: 'a', done: true }] })], true);
    expect(await rowOf(id1)).toMatchObject({
      title: 'back', priority: 'high', steps: [{ id: 's', text: 'a', done: true }],
      created_at: new Date('2025-01-01T00:00:00Z'), updated_at: new Date('2025-04-04T00:00:00Z'), deleted_at: null, purged_at: null,
    });
  });
  it('restore never changes created_at, even when the file says otherwise (created_at is immutable)', async () => {
    await seedRow(id1, 'x'); await makeTombstone(id1);
    await imp(A, [row({ id: id1, title: 'back', created_at: '2020-01-01T00:00:00Z' })], true);
    expect((await rowOf(id1)).created_at).toEqual(new Date('2025-01-01T00:00:00Z'));
  });
  it('an invalid row during restore aborts everything, including earlier adds and restores', async () => {
    await seedRow(id1, 'x'); await makeTombstone(id1); const before = await rowOf(id1); const id3 = randomUUID();
    await expect(imp(A, [row({ id: id3 }), row({ id: id1, title: 'ok' }), row({ id: id2, priority: 'urgent' })], true)).rejects.toThrow();
    expect(await rowOf(id1)).toEqual(before); expect(await count(A)).toBe(1);
  });
  it('a restore whose content is invalid aborts', async () => {
    await seedRow(id1, 'x'); await makeTombstone(id1);
    await expect(imp(A, [row({ id: id1, title: '' })], true)).rejects.toThrow(); expect((await rowOf(id1)).purged_at).not.toBeNull();
  });
  it('counts every outcome in one call; skipped holds only reasons that occurred', async () => {
    const live = randomUUID(); const tomb = randomUUID(); const tomb2 = randomUUID();
    await seedRow(live, 'l'); await seedRow(tomb, 't'); await makeTombstone(tomb); await seedRow(tomb2, 't'); await makeTombstone(tomb2);
    expect(await imp(A, [row({ id: id1 }), row({ id: live }), row({ id: tomb }), row({ id: tomb2 })], false))
      .toEqual({ added: 1, restored: 0, skipped: { exists: 1, purged: 2 } });
    expect(await imp(A, [row({ id: id2 })], false)).toEqual({ added: 1, restored: 0, skipped: {} });
    expect(await imp(A, [row({ id: tomb })], true)).toEqual({ added: 0, restored: 1, skipped: {} });
  });
  it('tables missing from the payload or not in sync_tables are ignored; a null restore flag means false', async () => {
    expect(await impRaw(A, { tables: { notes: [row()] } })).toEqual({ added: 0, restored: 0, skipped: {} });
    expect(await impRaw(A, {})).toEqual({ added: 0, restored: 0, skipped: {} });
    await seedRow(id1, 'x'); await makeTombstone(id1);
    expect(await impRaw(A, { tables: { todos: [row({ id: id1 })] } }, null)).toMatchObject({ skipped: { purged: 1 } });
  });
  it('a malformed payload is rejected', async () => {
    await expect(impRaw(A, [])).rejects.toThrow(/invalid_payload/);
    await expect(impRaw(A, { tables: [] })).rejects.toThrow(/invalid_payload/);
    await expect(impRaw(A, { tables: { todos: {} } })).rejects.toThrow(/invalid_payload/);
    await expect(impRaw(A, { tables: { todos: [1] } })).rejects.toThrow(/invalid_payload/);
    await expect(impRaw(A, { tables: { todos: [{ title: 'no id' }] } })).rejects.toThrow(/invalid_payload/);
    await expect(impRaw(A, { tables: { todos: [{ id: 'nope', title: 'x' }] } })).rejects.toThrow();
    expect(await count(A)).toBe(0);
  });
  it('works for every table in sync_tables, not only todos', async () => {
    await t.asRole('postgres');
    await t.pg.exec(`
      create table scratch_items (
        id uuid primary key, user_id uuid not null default auth.uid(),
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        rev bigint not null default 0, deleted_at timestamptz, purged_at timestamptz,
        body text not null default 'dflt');
      create trigger scratch_set_rev before insert or update on scratch_items
        for each row execute function set_rev_and_updated_at();
      insert into sync_tables (name) values ('scratch_items');`);
    expect(await impRaw(A, { tables: { scratch_items: [{ id: id1, body: 'hello', updated_at: '2025-01-01T00:00:00Z' }], todos: [row({ id: id2 })] } }))
      .toEqual({ added: 2, restored: 0, skipped: {} });
    expect((await rowOf(id2)).user_id).toBe(A);
    await t.asRole('postgres');
    expect((await t.pg.query<Row>('select * from scratch_items where id = $1', [id1])).rows[0])
      .toMatchObject({ user_id: A, body: 'hello', updated_at: new Date('2025-01-01T00:00:00Z') });
  });
  it('EXECUTE is granted to authenticated only', async () => {
    await t.asRole('postgres');
    const r = await t.pg.query<{ grantee: string }>(
      `select grantee from information_schema.routine_privileges where routine_name = 'import_backup' and privilege_type = 'EXECUTE' order by grantee`);
    expect(r.rows.map(x => x.grantee).filter(g => g !== 'postgres')).toEqual(['authenticated']);
  });
});

describe('import_backup: events (stage 2)', () => {
  /** An event as it appears in an export file. */
  const ev = (over: Row = {}): Row => ({
    id: randomUUID(), title: 'meeting', all_day: false, starts_at: '2026-11-23T09:00', ends_at: '2026-11-23T10:00',
    tz: 'Asia/Shanghai', note: 'n', important: true, done: false, rrule: null,
    created_at: '2025-01-01T00:00:00Z', updated_at: '2025-02-02T00:00:00Z', deleted_at: null, ...over,
  });
  const eventRow = (id: string) => rowOfRaw(t, id, 'events');

  it('events rows are added as they are and keep updated_at', async () => {
    const e = ev({ id: id1 });
    const r = await impRaw(A, { tables: { events: [e], todos: [row({ id: id2 })] } });
    expect(r).toEqual({ added: 2, restored: 0, skipped: {} });
    const stored = await eventRow(id1);
    expect(stored).toMatchObject({
      user_id: A, title: 'meeting', all_day: false, starts_at: '2026-11-23T09:00', ends_at: '2026-11-23T10:00',
      tz: 'Asia/Shanghai', note: 'n', important: true, done: false, rrule: null, purged_at: null, deleted_at: null,
      created_at: new Date('2025-01-01T00:00:00Z'), updated_at: new Date('2025-02-02T00:00:00Z'),
    });
    expect(Number(stored.rev)).toBeGreaterThan(0);
  });
  it('an invalid event aborts the whole import', async () => {
    await expect(impRaw(A, { tables: { events: [ev({ id: id1 }), ev({ id: id2, tz: null })], todos: [row()] } })).rejects.toThrow(/check constraint/);
    expect(await count(A)).toBe(0);
    await t.asRole('postgres');
    expect((await t.pg.query('select id from events')).rows).toEqual([]);
  });
  it('an event tombstone is skipped by default and restored when asked', async () => {
    await impRaw(A, { tables: { events: [ev({ id: id1 })] } });
    await t.asRole('postgres');
    await t.pg.query(`update events set deleted_at = now() - interval '31 days' where id = $1`, [id1]);
    await purgeAsCron();
    expect((await eventRow(id1)).purged_at).not.toBeNull();
    expect(await impRaw(A, { tables: { events: [ev({ id: id1 })] } })).toMatchObject({ skipped: { purged: 1 } });
    expect(await impRaw(A, { tables: { events: [ev({ id: id1, title: 'back' })] } }, true)).toMatchObject({ restored: 1 });
    expect(await eventRow(id1)).toMatchObject({ title: 'back', tz: 'Asia/Shanghai', purged_at: null });
  });
});

describe('import_backup: server-managed keys and the setting (F7)', () => {
  it('garbage in user_id, rev and purged_at is ignored, not an abort (add and restore)', async () => {
    const garbage = { user_id: 'not-a-uuid', rev: 'abc', purged_at: 'whenever' };
    const r = await imp(A, [row({ id: id1, title: 'added', ...garbage })], false);
    expect(r).toMatchObject({ added: 1 });
    expect(await rowOf(id1)).toMatchObject({ user_id: A, title: 'added', purged_at: null });

    await seedRow(id2, 'x'); await makeTombstone(id2);
    const s = await imp(A, [row({ id: id2, title: 'back', ...garbage })], true);
    expect(s).toMatchObject({ restored: 1 });
    expect(await rowOf(id2)).toMatchObject({ user_id: A, title: 'back', purged_at: null });
  });

  it('app.keep_updated_at is off again when import_backup returns, for the rest of the caller transaction', async () => {
    await t.asUser(A);
    const setting = await t.pg.transaction(async (tx) => {
      await tx.query('select import_backup($1::jsonb, false)', [JSON.stringify({ tables: { todos: [row({ id: id1 })] } })]);
      return (await tx.query<{ s: string | null }>(`select current_setting('app.keep_updated_at', true) as s`)).rows[0].s;
    });
    expect(setting ?? '').not.toBe('on');
    expect((await rowOf(id1)).updated_at).toEqual(new Date('2025-01-02T00:00:00Z'));
  });
});
