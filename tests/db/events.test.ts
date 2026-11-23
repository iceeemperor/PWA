// The cloud `events` table (stage 2): its push, pull, purge and privilege rules, and the explicit user filter in
// pull_changes.
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TABLE_DEFAULTS } from '../../src/domain/tables';
import { createTestDb, rowOf as rowOfRaw, trashAt as trashAtRaw, TEST_USER_A as A, TEST_USER_B as B, type TestDb } from './harness';

type Row = Record<string, any>;
type Kind = 'insert' | 'update' | 'delete' | 'restore';
type Page = { rows: { table: string; row: Row }[]; has_more: boolean };

let t: TestDb;
let id: string;
beforeEach(async () => { t = await createTestDb(); id = randomUUID(); });
afterEach(async () => { await t.pg.close(); });

const rowOf = (rid: string) => rowOfRaw(t, rid, 'events');
const trashAt = (rid: string, daysAgo: number) => trashAtRaw(t, rid, daysAgo, 'events');

const VALID: Row = { title: '会', all_day: true, starts_at: '2026-11-23' };
const op = (kind: Kind, rid: string, fields: Row, base_rev: number | null = null) =>
  ({ op_id: randomUUID(), id: rid, kind, base_rev, fields });
/** An insert op for `id`; the fields replace VALID entirely when given, so each case says exactly what it sends. */
const insertEvent = (fields: Row = VALID) => op('insert', id, fields);

async function push(uid: string, o: Row, table = 'events'): Promise<Row> {
  await t.asUser(uid);
  return (await t.pg.query<{ r: Row }>('select push_change($1, $2::jsonb) as r', [table, JSON.stringify(o)])).rows[0].r;
}
async function pull(uid: string, since = 0, limit = 100): Promise<Page> {
  await t.asUser(uid);
  return (await t.pg.query<{ p: Page }>('select pull_changes($1, $2) as p', [since, limit])).rows[0].p;
}
async function purgeAsCron(): Promise<void> { await t.asRole('postgres'); await t.pg.query('select purge_expired()'); }
async function eventCount(): Promise<number> {
  await t.asRole('postgres');
  return Number((await t.pg.query<{ n: number }>('select count(*)::int as n from events')).rows[0].n);
}
/** The content columns of a row, as the client sees them (TABLE_DEFAULTS keys). */
const content = (row: Row, table: 'todos' | 'events') =>
  Object.fromEntries(Object.keys(TABLE_DEFAULTS[table]).map(k => [k, row[k]]));

describe('events: the brief', () => {
  it('a signed-in user can push, pull, trash and restore an event', async () => {
    const ins = await push(A, insertEvent());
    expect(ins).toMatchObject({ status: 'applied', conflict: false });
    expect(ins.record).toMatchObject({ id, user_id: A, title: '会', all_day: true, starts_at: '2026-11-23' });
    const p = await pull(A);
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]).toMatchObject({ table: 'events', row: { id, user_id: A } });
    expect(p.rows[0].row.rev).toBeGreaterThan(0);
    const d = await push(A, op('delete', id, {}, 0));
    expect(d.status).toBe('applied'); expect(d.record.deleted_at).not.toBeNull();
    const s = await push(A, op('restore', id, {}, d.rev));
    expect(s.status).toBe('applied'); expect(s.record.deleted_at).toBeNull();
    expect(s.rev).toBeGreaterThan(d.rev);
  });

  it('defaults: a minimal timed insert stores the column defaults for the rest', async () => {
    const r = await push(A, insertEvent({ title: '会', all_day: false, starts_at: '2026-11-23T09:00', tz: 'Asia/Shanghai' }));
    expect(r.status).toBe('applied');
    expect(await rowOf(id)).toMatchObject({ ends_at: null, note: '', important: false, done: false, rrule: null });
  });

  it.each([
    ['blank title', { title: ' ' }],
    ['all-day with a time', { all_day: true, starts_at: '2026-11-23T09:00', tz: null }],
    ['all-day with a tz', { all_day: true, starts_at: '2026-11-23', tz: 'Asia/Shanghai' }],
    ['timed without tz', { all_day: false, starts_at: '2026-11-23T09:00', tz: null }],
    ['timed with seconds or offset', { all_day: false, starts_at: '2026-11-23T09:00:00+08:00', tz: 'Asia/Shanghai' }],
    ['end before start', { all_day: true, starts_at: '2026-11-23', ends_at: '2026-11-22' }],
    ['end in the other form', { all_day: true, starts_at: '2026-11-23', ends_at: '2026-11-23T10:00' }],
    ['rrule set', { all_day: true, starts_at: '2026-11-23', rrule: 'FREQ=DAILY' }],
  ])('push_change rejects %s as invalid', async (_n, fields) => {
    // The cases change one thing against a valid all-day event, so the rejection is caused by that one thing.
    const r = await push(A, insertEvent({ ...VALID, ...fields }));
    expect(r.status).toBe('invalid'); expect(r.message).toBeTruthy();
    expect(await eventCount()).toBe(0);
  });

  it('purge turns an expired trashed event into a tombstone that satisfies every CHECK', async () => {
    const r = await push(A, insertEvent({
      title: 'T', all_day: false, starts_at: '2026-11-23T09:00', ends_at: '2026-11-23T10:30', tz: 'Europe/Berlin',
      note: 'N', important: true, done: true }));
    expect(r.status).toBe('applied');
    await trashAt(id, 31);
    const before = await rowOf(id);
    await purgeAsCron();
    const after = await rowOf(id);
    expect(after.purged_at).toBeInstanceOf(Date);
    expect(after.deleted_at).toEqual(before.deleted_at);
    expect(content(after, 'events')).toEqual(TABLE_DEFAULTS.events);
    expect(Number(after.rev)).toBeGreaterThan(Number(before.rev));
    // The tombstone is still valid against every constraint (re-checked by touching the row).
    await t.asRole('postgres');
    await expect(t.pg.query('update events set id = id where id = $1', [id])).resolves.toBeTruthy();
  });

  it('authenticated cannot insert, update or delete events directly; anon cannot select', async () => {
    await t.asRole('postgres');
    const can = async (role: string, priv: string) =>
      (await t.pg.query<{ ok: boolean }>('select has_table_privilege($1, $2, $3) as ok', [role, 'public.events', priv])).rows[0].ok;
    const privs = ['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'];
    const granted = async (role: string) => { const out: string[] = []; for (const p of privs) if (await can(role, p)) out.push(p); return out; };
    expect(await granted('authenticated')).toEqual(['select']);
    expect(await granted('anon')).toEqual([]);

    expect((await push(A, insertEvent())).status).toBe('applied');
    await t.asUser(A);
    await expect(t.pg.query(`insert into events (id, title) values ($1, 'x')`, [randomUUID()])).rejects.toThrow(/permission denied for table events/);
    await expect(t.pg.query(`update events set title = 'direct' where id = $1`, [id])).rejects.toThrow(/permission denied for table events/);
    await expect(t.pg.query('delete from events where id = $1', [id])).rejects.toThrow(/permission denied for table events/);
    await expect(t.pg.query('truncate events')).rejects.toThrow(/permission denied for table events/);
    expect((await t.pg.query('select id from events')).rows).toEqual([{ id }]);
    await t.asRole('anon');
    await expect(t.pg.query('select * from events')).rejects.toThrow(/permission denied for table events/);
    await expect(t.pg.query(`insert into events (id, title) values ($1, 'x')`, [randomUUID()])).rejects.toThrow(/permission denied for table events/);
    expect(await rowOf(id)).toMatchObject({ title: '会' });
  });

  it("pull_changes never returns another user's rows even if RLS were disabled", async () => {
    expect((await push(A, insertEvent())).status).toBe('applied');
    const theirs = randomUUID();
    expect((await push(B, op('insert', theirs, { ...VALID, title: 'B secret' }))).status).toBe('applied');
    const theirTodo = randomUUID();
    expect((await push(B, op('insert', theirTodo, { title: 'B todo' }), 'todos')).status).toBe('applied');
    await t.asRole('postgres');
    await t.pg.exec('alter table events disable row level security; alter table todos disable row level security');
    try {
      // RLS is really off: a plain select as A now sees B's rows.
      await t.asUser(A);
      expect((await t.pg.query('select id from events')).rows).toHaveLength(2);
      const p = await pull(A);
      expect(p.rows.map(r => r.row.id)).toEqual([id]);
      expect(p.rows.every(r => r.row.user_id === A)).toBe(true);
      expect((await pull(B)).rows.map(r => r.row.id).sort()).toEqual([theirs, theirTodo].sort());
    } finally {
      await t.asRole('postgres');
      await t.pg.exec('alter table events enable row level security; alter table todos enable row level security');
    }
  });
});

describe('events: beyond the brief', () => {
  it('push_change type-checks event fields generically (text is a string, boolean a boolean, null only where allowed)', async () => {
    for (const fields of [
      { ...VALID, all_day: 'yes' }, { ...VALID, important: 1 }, { ...VALID, done: null },
      { ...VALID, title: 5 }, { ...VALID, starts_at: null }, { ...VALID, note: null }, { ...VALID, ends_at: 20261124 },
      { ...VALID, tz: false },
    ]) {
      const r = await push(A, op('insert', randomUUID(), fields));
      expect(r.status, JSON.stringify(fields)).toBe('invalid');
    }
    expect(await eventCount()).toBe(0);
    // Nullable columns accept a JSON null.
    const r = await push(A, insertEvent({ ...VALID, ends_at: null, tz: null, rrule: null }));
    expect(r.status).toBe('applied');
  });

  it('accepts the valid forms: multi-day all-day, timed with an end, same-moment end, tz shapes', async () => {
    for (const fields of [
      { title: 'a', all_day: true, starts_at: '2026-11-23', ends_at: '2026-11-25' },
      { title: 'a', all_day: true, starts_at: '2026-11-23', ends_at: '2026-11-23' },
      { title: 'a', all_day: false, starts_at: '2026-11-23T00:00', ends_at: '2026-11-24T23:59', tz: 'America/Argentina/Buenos_Aires' },
      { title: 'a', all_day: false, starts_at: '2026-11-23T09:00', ends_at: '2026-11-23T09:00', tz: 'UTC' },
      { title: 'a', all_day: false, starts_at: '2026-11-23T09:00', tz: 'Etc/GMT+8' },
    ]) {
      const r = await push(A, op('insert', randomUUID(), fields));
      expect(r.status, JSON.stringify(fields)).toBe('applied');
    }
  });

  it.each([
    ['a timed end before start', { all_day: false, starts_at: '2026-11-23T09:00', ends_at: '2026-11-23T08:59', tz: 'UTC' }],
    ['a timed end in the all-day form', { all_day: false, starts_at: '2026-11-23T09:00', ends_at: '2026-11-24', tz: 'UTC' }],
    ['hour 24', { all_day: false, starts_at: '2026-11-23T24:00', tz: 'UTC' }],
    ['minute 60', { all_day: false, starts_at: '2026-11-23T09:60', tz: 'UTC' }],
    ['a timed start without a time', { all_day: false, starts_at: '2026-11-23', tz: 'UTC' }],
    ['an empty start', { all_day: true, starts_at: '' }],
    ['a tz with a space', { all_day: false, starts_at: '2026-11-23T09:00', tz: 'Asia/ Shanghai' }],
    ['a tz starting with a slash', { all_day: false, starts_at: '2026-11-23T09:00', tz: '/Asia' }],
    ['an empty tz', { all_day: false, starts_at: '2026-11-23T09:00', tz: '' }],
    ['a trailing newline in the date', { all_day: true, starts_at: '2026-11-23\n' }],
    ['a full-width blank title', { title: '　' }],
  ])('rejects %s', async (_n, fields) => {
    const r = await push(A, insertEvent({ ...VALID, ...fields }));
    expect(r.status).toBe('invalid');
  });

  it('an update that breaks a rule is invalid and leaves the row as it was', async () => {
    const r1 = await push(A, insertEvent());
    const r2 = await push(A, op('update', id, { all_day: false }, r1.rev));
    expect(r2.status).toBe('invalid');
    expect(await rowOf(id)).toMatchObject({ all_day: true, starts_at: '2026-11-23', tz: null });
    const r3 = await push(A, op('update', id, { all_day: false, starts_at: '2026-11-23T09:00', tz: 'Asia/Shanghai' }, r1.rev));
    expect(r3).toMatchObject({ status: 'applied', conflict: false });
  });

  it('table shape: common columns as todos, content columns with their defaults, no UNIQUE, index on (user_id, rev)', async () => {
    await t.asRole('postgres');
    const cols = (await t.pg.query<Row>(
      `select column_name, data_type, is_nullable, column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'events' order by ordinal_position`)).rows;
    expect(cols.map(c => c.column_name)).toEqual([
      'id', 'user_id', 'created_at', 'updated_at', 'rev', 'deleted_at', 'purged_at',
      'title', 'all_day', 'starts_at', 'ends_at', 'tz', 'note', 'important', 'done', 'rrule']);
    const todoCommon = (await t.pg.query<Row>(
      `select column_name, data_type, is_nullable, column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'todos' order by ordinal_position limit 7`)).rows;
    expect(cols.slice(0, 7)).toEqual(todoCommon);
    const unique = (await t.pg.query(
      `select conname from pg_constraint where conrelid = 'public.events'::regclass and contype = 'u'`)).rows;
    expect(unique).toEqual([]);
    const idx = (await t.pg.query<Row>(`select indexdef from pg_indexes where schemaname = 'public' and tablename = 'events'`)).rows.map(r => r.indexdef);
    expect(idx.some(d => /\(user_id, rev\)/.test(d))).toBe(true);
    const trig = (await t.pg.query(`select tgname from pg_trigger where tgrelid = 'public.events'::regclass and not tgisinternal`)).rows;
    expect(trig).toEqual([{ tgname: 'events_set_rev_and_updated_at' }]);
  });

  it('the server owns rev, updated_at and user_id; created_at is kept on insert and in range', async () => {
    const r = await push(A, insertEvent({ ...VALID, created_at: '2025-01-01T00:00:00Z', user_id: B, rev: 999999 }));
    expect(r.status).toBe('applied');
    expect(await rowOf(id)).toMatchObject({ user_id: A, created_at: new Date('2025-01-01T00:00:00Z') });
    expect(Number((await rowOf(id)).rev)).toBeLessThan(999999);
    const bad = await push(A, op('insert', randomUUID(), { ...VALID, created_at: '1999-12-31T23:59:59Z' }));
    expect(bad.status).toBe('invalid');
  });

  it('events has four policies (DELETE matches nothing) and sync_tables lists it with no copy fields', async () => {
    await t.asRole('postgres');
    const r = await t.pg.query<Row>(
      `select cmd, qual, with_check from pg_policies where schemaname = 'public' and tablename = 'events' order by cmd`);
    expect(r.rows.map(p => p.cmd)).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    expect(r.rows[0].qual).toBe('false');
    for (const p of r.rows.filter(p => p.cmd === 'INSERT' || p.cmd === 'UPDATE')) expect(p.with_check).toMatch(/user_id = auth\.uid\(\)/);
    for (const p of r.rows.filter(p => p.cmd === 'SELECT' || p.cmd === 'UPDATE')) expect(p.qual).toMatch(/user_id = auth\.uid\(\)/);
    expect((await t.pg.query(`select copy_fields from sync_tables where name = 'events'`)).rows).toEqual([{ copy_fields: [] }]);
  });

  it('pull_changes keeps its grants (authenticated only), stays security invoker and filters by the caller', async () => {
    await t.asRole('postgres');
    const r = await t.pg.query<Row>(`
      select p.prosecdef, p.proconfig, pg_get_functiondef(p.oid) as def,
             array(select distinct case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end
                     from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                    where a.privilege_type = 'EXECUTE' order by 1) as grantees
        from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'pull_changes'`);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ prosecdef: false, proconfig: ['search_path=public, pg_temp'], grantees: ['authenticated', 'postgres'] });
    expect(r.rows[0].def).toMatch(/t\.user_id = auth\.uid\(\)/);
    await t.asRole('anon');
    await expect(t.pg.query('select pull_changes(0, 10)')).rejects.toThrow(/permission denied/);
  });
});

describe('every sync table: SQL defaults equal TABLE_DEFAULTS', () => {
  it.each(['todos', 'events'] as const)('%s: a minimal row, purged, holds exactly TABLE_DEFAULTS', async (table) => {
    await t.asRole('postgres');
    const listed = (await t.pg.query<{ name: string }>('select name from sync_tables order by name')).rows.map(r => r.name);
    expect(listed).toEqual(['events', 'todos']);
    // Only the required fields: id and owner. purged_at is set so the content CHECKs (title not blank) do not apply.
    await t.pg.query(`insert into ${table} (id, user_id, purged_at) values ($1, $2, now())`, [id, A]);
    const row = await rowOfRaw(t, id, table);
    // The content columns in the catalog are exactly the TABLE_DEFAULTS keys.
    const cols = (await t.pg.query<{ c: string }>(
      `select column_name as c from information_schema.columns where table_schema = 'public' and table_name = $1
         and column_name not in ('id', 'user_id', 'created_at', 'updated_at', 'rev', 'deleted_at', 'purged_at') order by ordinal_position`,
      [table])).rows.map(r => r.c);
    expect(cols.sort()).toEqual(Object.keys(TABLE_DEFAULTS[table]).sort());
    // A date column comes back as a Date from PGlite; every default here is null or a plain JSON value.
    expect(content(row, table)).toEqual(TABLE_DEFAULTS[table]);
    // And purge_expired resets a full row to the same values.
    const live = table === 'events'
      ? `starts_at = '2026-11-23', ends_at = '2026-11-24', note = 'n', important = true, done = true`
      : `kind = 'goal', note = 'n', done = true, priority = 'high', due_date = '2026-01-01', steps = '[{"id":"s","text":"t","done":true}]'`;
    await t.pg.query(`update ${table} set purged_at = null, deleted_at = now() - interval '31 days', title = 'x', ${live} where id = $1`, [id]);
    expect(content(await rowOfRaw(t, id, table), table)).not.toEqual(TABLE_DEFAULTS[table]);
    await purgeAsCron();
    expect(content(await rowOfRaw(t, id, table), table)).toEqual(TABLE_DEFAULTS[table]);
  });
});
