import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDb, makeTombstone as makeTombstoneRaw, MIGRATIONS_DIR, migrationFiles, rowOf as rowOfRaw,
  trashAt as trashAtRaw, TEST_USER_A as A, TEST_USER_B as B, type TestDb,
} from './harness';

type Row = Record<string, any>;
type Page = { rows: { table: string; row: Row }[]; has_more: boolean };

let t: TestDb;
beforeEach(async () => { t = await createTestDb(); });
afterEach(async () => { await t.pg.close(); });

// Local wrappers bound to the current `t`.
const rowOf = (id: string) => rowOfRaw(t, id);
const trashAt = (id: string, daysAgo: number) => trashAtRaw(t, id, daysAgo);
const makeTombstone = (id: string) => makeTombstoneRaw(t, id);
const revOf = async (id: string): Promise<number> => Number((await rowOf(id)).rev);

/** Create `n` live todos for `uid` through push_change, so revs come from the real write path. Resolves to their ids. */
async function seed(uid: string, n: number, fields: Row = {}): Promise<string[]> {
  await t.asUser(uid);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = randomUUID();
    const op = { op_id: randomUUID(), id, kind: 'insert', base_rev: null, fields: { title: `task ${i}`, ...fields } };
    const r = (await t.pg.query<{ r: Row }>('select push_change($1, $2::jsonb) as r', ['todos', JSON.stringify(op)])).rows[0].r;
    if (r.status !== 'applied') throw new Error(`seed failed: ${JSON.stringify(r)}`);
    ids.push(id);
  }
  return ids;
}

/** Trash or restore a todo as `uid` through push_change. */
async function pushKind(uid: string, kind: 'delete' | 'restore' | 'update', id: string, fields: Row = {}, baseRev = 0): Promise<Row> {
  await t.asUser(uid);
  const op = { op_id: randomUUID(), id, kind, base_rev: baseRev, fields };
  return (await t.pg.query<{ r: Row }>('select push_change($1, $2::jsonb) as r', ['todos', JSON.stringify(op)])).rows[0].r;
}
const trash = (uid: string, id: string) => pushKind(uid, 'delete', id);

async function pull(uid: string, since: number | null, limit: number | null): Promise<Page> {
  await t.asUser(uid);
  return (await t.pg.query<{ p: Page }>('select pull_changes($1, $2) as p', [since, limit])).rows[0].p;
}
const ids = (p: Page) => p.rows.map(r => r.row.id as string);
const revs = (p: Page) => p.rows.map(r => Number(r.row.rev));

async function purgeAs(uid: string): Promise<void> { await t.asUser(uid); await t.pg.query('select purge_expired()'); }
/** What pg_cron does: the owner, no signed-in user. */
async function purgeAsCron(): Promise<void> { await t.asRole('postgres'); await t.pg.query('select purge_expired()'); }

/** An applied_ops row `days` old, written as the superuser (callers have no access to the table). */
async function agedOp(days: number, uid: string = A): Promise<void> {
  await t.asRole('postgres');
  await t.pg.query(
    `insert into applied_ops (user_id, op_id, result, created_at) values ($1, $2, '{}', now() - $3::float8 * interval '1 day')`,
    [uid, randomUUID(), days]);
}
async function opCount(uid: string | null = null): Promise<number> {
  await t.asRole('postgres');
  return Number((await t.pg.query<{ n: number }>(
    'select count(*)::int as n from applied_ops where $1::uuid is null or user_id = $1', [uid])).rows[0].n);
}
async function todoCount(): Promise<number> {
  await t.asRole('postgres');
  return Number((await t.pg.query<{ n: number }>('select count(*)::int as n from todos')).rows[0].n);
}

/** Insert todos with chosen revs, in the given physical order. Triggers are off for this, so rev is kept as given. */
async function rawTodos(uid: string, revList: number[]): Promise<string[]> {
  await t.asRole('postgres');
  await t.pg.exec('set session_replication_role = replica');
  const out: string[] = [];
  try {
    for (const rev of revList) {
      const id = randomUUID();
      await t.pg.query(`insert into todos (id, user_id, rev, title) values ($1, $2, $3, $4)`, [id, uid, rev, `rev ${rev}`]);
      out.push(id);
    }
  } finally { await t.pg.exec('reset session_replication_role'); }
  return out;
}

// A second synced table, so the functions are shown to work for "every table in sync_tables" and not for todos only.
async function addScratchTable(): Promise<void> {
  await t.asRole('postgres');
  await t.pg.exec(`
    create table scratch_items (
      id uuid primary key,
      user_id uuid not null default auth.uid(),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      rev bigint not null default 0,
      deleted_at timestamptz,
      purged_at timestamptz,
      body text not null default 'dflt',
      extra int,
      tags text[] not null default '{a,b}'
    );
    create trigger scratch_set_rev before insert or update on scratch_items
      for each row execute function set_rev_and_updated_at();
    alter table scratch_items enable row level security;
    create policy scratch_select on scratch_items for select to authenticated using (user_id = auth.uid());
    revoke all on scratch_items from anon, authenticated;
    grant select on scratch_items to authenticated;
    insert into sync_tables (name) values ('scratch_items');
  `);
}
async function scratch(uid: string, fields: { body?: string; extra?: number | null; tags?: string[]; deletedDaysAgo?: number } = {}): Promise<string> {
  await t.asRole('postgres');
  const id = randomUUID();
  await t.pg.query(
    `insert into scratch_items (id, user_id, body, extra, tags, deleted_at)
     values ($1, $2, coalesce($3, 'dflt'), $4, coalesce($5::text[], '{a,b}'), case when $6::float8 is null then null else now() - $6::float8 * interval '1 day' end)`,
    [id, uid, fields.body ?? null, fields.extra ?? null, fields.tags ?? null, fields.deletedDaysAgo ?? null]);
  return id;
}
async function scratchRow(id: string): Promise<Row> {
  await t.asRole('postgres');
  return (await t.pg.query<Row>('select * from scratch_items where id = $1', [id])).rows[0];
}

describe('pull_changes: the brief', () => {
  it("pull returns only the caller's rows after the cursor, in rev order, including trash and tombstones", async () => {
    const [a1, a2, a3] = await seed(A, 3); await seed(B, 1); await trash(A, a2); await makeTombstone(a3);
    const p = await pull(A, 0, 100);
    expect(ids(p).sort()).toEqual([a1, a2, a3].sort());
    const r = revs(p); expect(r).toEqual([...r].sort((x, y) => x - y)); expect(p.has_more).toBe(false);
    expect((await pull(A, p.rows[0].row.rev, 100)).rows).toHaveLength(2);
  });
  it('pull pages with has_more', async () => {
    await seed(A, 5); const p = await pull(A, 0, 2);
    expect(p.rows).toHaveLength(2); expect(p.has_more).toBe(true);
  });
});

describe('purge_expired: the brief', () => {
  it('purge clears content, keeps the row as a tombstone and bumps rev', async () => {
    const [id] = await seed(A, 1, { title: 'secret', note: 'n', steps: [{ id: 's', text: 't', done: false }] }); await trashAt(id, 31);
    const before = await revOf(id); await purgeAsCron();
    expect(await rowOf(id)).toMatchObject({ title: '', note: '', steps: [], purged_at: expect.anything() });
    expect(await revOf(id)).toBeGreaterThan(before);
  });
  it('purge leaves rows trashed less than 30 days ago and live rows alone', async () => {
    const [a, b] = await seed(A, 2); await trashAt(a, 29); await purgeAsCron();
    expect((await rowOf(a)).purged_at).toBeNull(); expect((await rowOf(b)).title).not.toBe('');
  });
  it('purge removes applied_ops older than 30 days only', async () => {
    await agedOp(31); await agedOp(1); await purgeAsCron(); expect(await opCount()).toBe(1);
  });
  it("a signed-in caller only purges their own rows; cron (no uid) purges everyone's", async () => {
    const [a] = await seed(A, 1); const [b] = await seed(B, 1); await trashAt(a, 31); await trashAt(b, 31);
    await purgeAs(A); expect((await rowOf(a)).purged_at).not.toBeNull(); expect((await rowOf(b)).purged_at).toBeNull();
    await purgeAsCron(); expect((await rowOf(b)).purged_at).not.toBeNull();
  });
  it('anon cannot call pull_changes or purge_expired, a signed-in user can call both', async () => {
    await t.asRole('anon');
    await expect(t.pg.query('select purge_expired()')).rejects.toThrow(/permission denied/);
    await expect(t.pg.query('select pull_changes(0, 10)')).rejects.toThrow(/permission denied/);
    await t.asUser(A);
    await expect(t.pg.query('select purge_expired()')).resolves.toBeDefined();
    await expect(t.pg.query('select pull_changes(0, 10)')).resolves.toBeDefined();
  });
});

describe('pull_changes: beyond the brief', () => {
  it("never returns another user's rows, in either direction, and RLS keeps them apart", async () => {
    const [a1, a2] = await seed(A, 2); const [b1, b2] = await seed(B, 2);
    await trash(B, b2); await makeTombstone(a2);
    const pa = await pull(A, 0, 100); const pb = await pull(B, 0, 100);
    expect(ids(pa).sort()).toEqual([a1, a2].sort()); expect(ids(pb).sort()).toEqual([b1, b2].sort());
    for (const r of [...pa.rows, ...pb.rows]) expect(r.table).toBe('todos');
    expect(pa.rows.every(r => r.row.user_id === A)).toBe(true); expect(pb.rows.every(r => r.row.user_id === B)).toBe(true);
  });
  it('is a security invoker function, so it is RLS that keeps users apart', async () => {
    await t.asRole('postgres');
    const r = await t.pg.query<Row>(`select prosecdef from pg_proc where proname = 'pull_changes' and pronamespace = 'public'::regnamespace`);
    expect(r.rows).toEqual([{ prosecdef: false }]);
  });
  it('returns { rows: [{ table, row }], has_more } with the whole row, like PullPage', async () => {
    const [id] = await seed(A, 1, { title: 'x', note: 'n', due_date: '2026-12-01', priority: 'high' });
    const p = await pull(A, 0, 10);
    expect(Object.keys(p).sort()).toEqual(['has_more', 'rows']);
    expect(Object.keys(p.rows[0]).sort()).toEqual(['row', 'table']);
    expect(p.rows[0].table).toBe('todos');
    expect(Object.keys(p.rows[0].row).sort()).toEqual([
      'created_at', 'deleted_at', 'done', 'due_date', 'id', 'kind', 'note', 'priority', 'purged_at', 'rev', 'steps', 'title', 'updated_at', 'user_id']);
    expect(p.rows[0].row).toMatchObject({
      id, user_id: A, kind: 'todo', title: 'x', done: false, priority: 'high', due_date: '2026-12-01', note: 'n', steps: [], deleted_at: null, purged_at: null });
    expect(typeof p.rows[0].row.rev).toBe('number'); expect(p.rows[0].row.rev).toBe(await revOf(id));
    expect(Number.isNaN(Date.parse(p.rows[0].row.created_at))).toBe(false);
  });
  it('an empty result is { rows: [], has_more: false }', async () => {
    expect(await pull(A, 0, 10)).toEqual({ rows: [], has_more: false });
    await seed(B, 1); expect(await pull(A, 0, 10)).toEqual({ rows: [], has_more: false });
  });
  it('rev > p_since: a row whose rev equals p_since is not returned, the next one is', async () => {
    const [a1, a2, a3] = await seed(A, 3);
    const r1 = await revOf(a1); const r2 = await revOf(a2);
    expect(ids(await pull(A, r2, 100))).toEqual([a3]);
    expect(ids(await pull(A, r2 - 1, 100))).toEqual([a2, a3]);
    expect(ids(await pull(A, r1, 100))).toEqual([a2, a3]);
    expect((await pull(A, await revOf(a3), 100)).rows).toEqual([]);
  });
  it('sorts by rev, not by insertion order, and a page holds the lowest revs', async () => {
    // Five rows stored from the highest rev down: a page of 2 only comes out right if every table is cut by rev
    // (with 3 rows the whole table would fit in the "page + 1" it is cut to, and the order could not show).
    // Index scans are switched off: the (user_id, rev) index would hand the rows back in rev order by itself and hide a missing ORDER BY.
    await t.pg.exec('set enable_indexscan = off; set enable_bitmapscan = off; set enable_indexonlyscan = off');
    const [x50, x40, x30, x20, x10] = await rawTodos(A, [50, 40, 30, 20, 10]);
    expect(ids(await pull(A, 0, 100))).toEqual([x10, x20, x30, x40, x50]);
    const p = await pull(A, 0, 2); expect(ids(p)).toEqual([x10, x20]); expect(p.has_more).toBe(true);
    expect(ids(await pull(A, 10, 100))).toEqual([x20, x30, x40, x50]);
    expect(ids(await pull(A, 30, 100))).toEqual([x40, x50]);
  });
  it('has_more is false when exactly p_limit rows are left, true when one more exists', async () => {
    await seed(A, 3);
    const exact = await pull(A, 0, 3); expect(exact.rows).toHaveLength(3); expect(exact.has_more).toBe(false);
    const short = await pull(A, 0, 2); expect(short.rows).toHaveLength(2); expect(short.has_more).toBe(true);
    const roomy = await pull(A, 0, 4); expect(roomy.rows).toHaveLength(3); expect(roomy.has_more).toBe(false);
  });
  it('walking pages with the last rev as the next cursor visits every row exactly once', async () => {
    const all = await seed(A, 7); await seed(B, 3); await trash(A, all[1]); await makeTombstone(all[2]);
    const seen: string[] = []; let since = 0; let pages = 0; let more = true;
    while (more) {
      const p = await pull(A, since, 3); pages++;
      seen.push(...ids(p)); more = p.has_more;
      if (p.rows.length) since = Number(p.rows[p.rows.length - 1].row.rev);
      if (pages > 10) throw new Error('paging does not terminate');
    }
    expect(pages).toBe(3); expect(seen).toHaveLength(7); expect([...seen].sort()).toEqual([...all].sort());
  });
  it('trashed rows come with deleted_at, and a purged row comes as a tombstone with empty content and purged_at', async () => {
    const [live, gone, dead] = await seed(A, 3, { title: 'keep', note: 'secret', priority: 'high', done: true });
    await trash(A, gone); await trashAt(dead, 31); await purgeAsCron();
    const byId = Object.fromEntries((await pull(A, 0, 100)).rows.map(r => [r.row.id, r.row]));
    expect(byId[live]).toMatchObject({ title: 'keep', deleted_at: null, purged_at: null });
    expect(byId[gone]).toMatchObject({ title: 'keep', note: 'secret', deleted_at: expect.any(String), purged_at: null });
    expect(byId[dead]).toMatchObject({ kind: 'todo', title: '', done: false, priority: 'normal', due_date: null, note: '', steps: [], purged_at: expect.any(String), user_id: A });
  });
  it('a null cursor counts as 0 and a negative one returns everything', async () => {
    const all = await seed(A, 3);
    expect(ids(await pull(A, null, 100))).toEqual(all); expect(ids(await pull(A, -5, 100))).toEqual(all);
  });
  it('p_limit: null uses the default of 500, zero and negative give one row (so a paging loop always advances), huge is capped at 1000', async () => {
    await t.asRole('postgres');
    await t.pg.query(`insert into todos (id, user_id, title) select gen_random_uuid(), $1, 'bulk' from generate_series(1, 1001)`, [A]);
    const dflt = await pull(A, 0, null); expect(dflt.rows).toHaveLength(500); expect(dflt.has_more).toBe(true);
    const zero = await pull(A, 0, 0); expect(zero.rows).toHaveLength(1); expect(zero.has_more).toBe(true);
    const neg = await pull(A, 0, -3); expect(neg.rows).toHaveLength(1); expect(neg.has_more).toBe(true);
    expect(ids(neg)).toEqual(ids(zero));
    const huge = await pull(A, 0, 2147483647); expect(huge.rows).toHaveLength(1000); expect(huge.has_more).toBe(true);
    const last = await pull(A, Number(huge.rows[999].row.rev), 2147483647); expect(last.rows).toHaveLength(1); expect(last.has_more).toBe(false);
  });
  it('without a signed-in user it raises not_authenticated instead of returning an empty page', async () => {
    await t.asUser(''); // role authenticated, token without a subject
    await expect(t.pg.query('select pull_changes(0, 10)')).rejects.toThrow(/not_authenticated/);
    await t.asRole('postgres'); // superuser with no user
    await expect(t.pg.query('select pull_changes(0, 10)')).rejects.toThrow(/not_authenticated/);
  });
  it('merges every table in sync_tables into one page in rev order, labelled with the table name', async () => {
    await addScratchTable();
    const [todoLow] = await seed(A, 1); const s1 = await scratch(A, { body: 's1' }); const [todoMid] = await seed(A, 1);
    const s2 = await scratch(A, { body: 's2' }); await scratch(B, { body: 'not mine' }); const [todoHigh] = await seed(A, 1);
    const p = await pull(A, 0, 100);
    expect(p.rows.map(r => [r.table, r.row.id])).toEqual([['todos', todoLow], ['scratch_items', s1], ['todos', todoMid], ['scratch_items', s2], ['todos', todoHigh]]);
    expect(p.rows[1].row).toMatchObject({ body: 's1', user_id: A });
    const r = revs(p); expect(r).toEqual([...r].sort((x, y) => x - y));
    const first = await pull(A, 0, 3); expect(first.rows.map(x => x.row.id)).toEqual([todoLow, s1, todoMid]); expect(first.has_more).toBe(true);
    const rest = await pull(A, revs(first)[2], 3); expect(rest.rows.map(x => x.row.id)).toEqual([s2, todoHigh]); expect(rest.has_more).toBe(false);
  });
  it('the global page takes the lowest revs across tables, whatever each table holds', async () => {
    await addScratchTable();
    const [tA, tB] = await rawTodos(A, [40, 10]);
    await t.asRole('postgres'); await t.pg.exec('set session_replication_role = replica');
    const sIds: string[] = [];
    try {
      for (const rev of [30, 20, 50]) {
        const id = randomUUID(); sIds.push(id);
        await t.pg.query('insert into scratch_items (id, user_id, rev) values ($1, $2, $3)', [id, A, rev]);
      }
    } finally { await t.pg.exec('reset session_replication_role'); }
    const p = await pull(A, 0, 3);
    expect(p.rows.map(r => [r.table, Number(r.row.rev)])).toEqual([['todos', 10], ['scratch_items', 20], ['scratch_items', 30]]);
    expect(p.has_more).toBe(true);
    expect((await pull(A, 0, 100)).rows.map(r => Number(r.row.rev))).toEqual([10, 20, 30, 40, 50]);
    expect(tA).toBeTruthy(); expect(tB).toBeTruthy();
  });
});

describe('pull_changes and purge_expired: events (stage 2)', () => {
  async function pushEvent(uid: string, kind: 'insert' | 'delete', id: string, fields: Row = {}): Promise<Row> {
    await t.asUser(uid);
    const op = { op_id: randomUUID(), id, kind, base_rev: 0, fields };
    return (await t.pg.query<{ r: Row }>('select push_change($1, $2::jsonb) as r', ['events', JSON.stringify(op)])).rows[0].r;
  }
  it('an events tombstone is in the pull result, with default content, next to todos', async () => {
    const ev = randomUUID();
    expect((await pushEvent(A, 'insert', ev, { title: 'secret', all_day: true, starts_at: '2026-11-23', note: 'n' })).status).toBe('applied');
    const [todo] = await seed(A, 1);
    const cursor = Number((await rowOfRaw(t, ev, 'events')).rev);
    await trashAtRaw(t, ev, 31, 'events'); await purgeAsCron();
    const p = await pull(A, 0, 100);
    expect(p.rows.map(r => [r.table, r.row.id])).toEqual([['todos', todo], ['events', ev]]);
    expect(p.rows[1].row).toMatchObject({
      user_id: A, title: '', all_day: true, starts_at: '', ends_at: null, tz: null, note: '', important: false, done: false, rrule: null,
      purged_at: expect.any(String), deleted_at: expect.any(String) });
    // A device whose cursor sits at the event's old rev still pulls the tombstone.
    expect(ids(await pull(A, cursor, 100))).toContain(ev);
    expect(ids(await pull(B, 0, 100))).toEqual([]);
  });
  it('a pushed delete on an event shows up in the pull with deleted_at', async () => {
    const ev = randomUUID();
    await pushEvent(A, 'insert', ev, { title: 'x', all_day: true, starts_at: '2026-11-23' });
    expect((await pushEvent(A, 'delete', ev)).status).toBe('applied');
    const p = await pull(A, 0, 100);
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]).toMatchObject({ table: 'events', row: { id: ev, deleted_at: expect.any(String), purged_at: null, title: 'x' } });
  });
});

describe('purge_expired: beyond the brief', () => {
  it('purges what was trashed 30 days and 1 hour ago, leaves 29 days and 23 hours', async () => {
    const [young, old] = await seed(A, 2);
    await trashAt(young, 29 + 23 / 24); await trashAt(old, 30 + 1 / 24); await purgeAsCron();
    expect((await rowOf(young)).purged_at).toBeNull(); expect((await rowOf(young)).title).not.toBe('');
    expect((await rowOf(old)).purged_at).not.toBeNull(); expect((await rowOf(old)).title).toBe('');
  });
  it('never purges rows that are not in the trash, however old, or that were restored after being trashed', async () => {
    const [ancient] = await seed(A, 1, { created_at: '2000-01-01T00:00:00Z', title: 'ancient' });
    const [back] = await seed(A, 1, { title: 'restored' }); await trashAt(back, 40);
    const r = await pushKind(A, 'restore', back); expect(r.status).toBe('applied'); expect(r.record.deleted_at).toBeNull();
    await purgeAsCron(); await purgeAs(A);
    expect(await rowOf(ancient)).toMatchObject({ title: 'ancient', purged_at: null, deleted_at: null });
    expect(await rowOf(back)).toMatchObject({ title: 'restored', purged_at: null, deleted_at: null });
  });
  it('resets every content column to its DEFAULT, the same values a fresh row gets', async () => {
    const [id] = await seed(A, 1, { kind: 'goal', title: 'T', done: true, priority: 'high', due_date: '2026-12-01', note: 'N', steps: [{ id: 's1', text: 'x', done: true }] });
    expect(await rowOf(id)).toMatchObject({ kind: 'goal', done: true, priority: 'high', note: 'N' });
    await trashAt(id, 31); await purgeAsCron();
    const purged = await rowOf(id);
    // A fresh insert shows what each column defaults to (a row with purged_at set may have an empty title).
    await t.asRole('postgres');
    const freshId = randomUUID(); await t.pg.query('insert into todos (id, user_id, purged_at) values ($1, $2, now())', [freshId, A]);
    const fresh = await rowOf(freshId);
    expect(fresh).toMatchObject({ kind: 'todo', title: '', done: false, priority: 'normal', due_date: null, note: '', steps: [] });
    // The list of content columns is derived from the catalog, so a column added later cannot slip past this test.
    const cols = (await t.pg.query<{ c: string }>(
      `select column_name as c from information_schema.columns where table_schema = 'public' and table_name = 'todos'
         and column_name not in ('id', 'user_id', 'created_at', 'updated_at', 'rev', 'deleted_at', 'purged_at') order by ordinal_position`)).rows.map(r => r.c);
    expect(cols).toEqual(['kind', 'title', 'done', 'priority', 'due_date', 'note', 'steps']);
    for (const c of cols) expect(purged[c], c).toEqual(fresh[c]);
  });
  it('produces the same tombstone as the harness makeTombstone', async () => {
    const fields = { kind: 'goal', title: 'T', done: true, priority: 'low', due_date: '2026-01-31', note: 'N', steps: [{ id: 's', text: 'x', done: false }] };
    const [viaPurge] = await seed(A, 1, fields); const [viaHelper] = await seed(A, 1, fields);
    await trashAt(viaPurge, 31); await purgeAsCron(); await makeTombstone(viaHelper);
    const p = await rowOf(viaPurge); const h = await rowOf(viaHelper);
    for (const c of ['user_id', 'kind', 'title', 'done', 'priority', 'due_date', 'note', 'steps']) expect(p[c], c).toEqual(h[c]);
    expect(p.purged_at).not.toBeNull(); expect(h.purged_at).not.toBeNull();
  });
  it('keeps id, user_id, created_at and deleted_at, sets purged_at to now, and updates updated_at', async () => {
    const [id] = await seed(A, 1, { created_at: '2020-05-06T07:08:09Z' }); await trashAt(id, 45);
    const before = await rowOf(id); await purgeAsCron(); const after = await rowOf(id);
    expect(after.id).toBe(id); expect(after.user_id).toBe(A);
    expect(after.created_at).toEqual(new Date('2020-05-06T07:08:09Z')); expect(after.deleted_at).toEqual(before.deleted_at);
    expect(Math.abs(Date.now() - (after.purged_at as Date).getTime())).toBeLessThan(60_000);
    expect(after.updated_at.getTime()).toBeGreaterThanOrEqual(before.updated_at.getTime());
  });
  it('never deletes a todos row: it only turns it into a tombstone', async () => {
    const [a, b] = await seed(A, 2); const [c] = await seed(B, 1);
    await trashAt(a, 31); await trashAt(c, 90); const before = await todoCount(); expect(before).toBe(3);
    await purgeAs(A); expect(await todoCount()).toBe(3);
    await purgeAsCron(); expect(await todoCount()).toBe(3);
    expect((await rowOf(a)).purged_at).not.toBeNull(); expect((await rowOf(c)).purged_at).not.toBeNull(); expect((await rowOf(b)).purged_at).toBeNull();
  });
  it('is idempotent: a second run leaves an existing tombstone and its rev alone', async () => {
    const [id] = await seed(A, 1); await trashAt(id, 31); await purgeAsCron();
    const first = await rowOf(id);
    await purgeAsCron(); await purgeAs(A); await purgeAsCron();
    expect(await rowOf(id)).toEqual(first);
  });
  it('the tombstone gets a new rev, so a device whose cursor sits at the old rev pulls it; a later push on it is dropped_purged', async () => {
    const [id] = await seed(A, 1, { title: 'bye' }); await trashAt(id, 31); const before = await revOf(id);
    await purgeAsCron();
    const p = await pull(A, before, 100);
    expect(ids(p)).toEqual([id]); expect(Number(p.rows[0].row.rev)).toBeGreaterThan(before);
    expect(p.rows[0].row).toMatchObject({ title: '', purged_at: expect.any(String) });
    expect((await pushKind(A, 'update', id, { title: 'late' }, before)).status).toBe('dropped_purged');
  });
  it('a signed-in purge also deletes only the caller\'s old applied_ops; cron deletes everyone\'s', async () => {
    await agedOp(31, A); await agedOp(31, A); await agedOp(31, B); await agedOp(2, A); await agedOp(2, B);
    await purgeAs(A);
    expect(await opCount(A)).toBe(1); expect(await opCount(B)).toBe(2);
    await purgeAsCron();
    expect(await opCount(A)).toBe(1); expect(await opCount(B)).toBe(1);
  });
  it('applied_ops from just under and just over 30 days: only the older one goes', async () => {
    await agedOp(29 + 23 / 24); await agedOp(30 + 1 / 24); await purgeAsCron(); expect(await opCount()).toBe(1);
  });
  it('a signed-in role without a subject (empty sub) cannot reach the everyone branch: it raises and changes nothing', async () => {
    const [id] = await seed(A, 1); await trashAt(id, 31); await agedOp(31); const ops = await opCount();
    await t.asUser('');
    await expect(t.pg.query('select purge_expired()')).rejects.toThrow(/not_authenticated/);
    expect((await rowOf(id)).purged_at).toBeNull(); expect(await opCount()).toBe(ops);
    // The owner without a subject (pg_cron) is still allowed.
    await purgeAsCron(); expect((await rowOf(id)).purged_at).not.toBeNull();
  });
  it('even if someone granted EXECUTE to anon by mistake, anon (no subject) would not get the everyone branch', async () => {
    const [id] = await seed(A, 1); await trashAt(id, 31);
    await t.asRole('postgres'); await t.pg.exec('grant execute on function purge_expired() to anon');
    await t.asRole('anon');
    await expect(t.pg.query('select purge_expired()')).rejects.toThrow(/not_authenticated/);
    expect((await rowOf(id)).purged_at).toBeNull();
  });
  it('purges every table in sync_tables, taking the content columns and their defaults from the catalog', async () => {
    await addScratchTable();
    const mine = await scratch(A, { body: 'secret', extra: 5, tags: ['x'], deletedDaysAgo: 31 });
    const theirs = await scratch(B, { body: 'theirs', extra: 6, deletedDaysAgo: 35 });
    const young = await scratch(A, { body: 'young', deletedDaysAgo: 5 });
    const before = await scratchRow(mine);
    await purgeAs(A);
    expect(await scratchRow(mine)).toMatchObject({ body: 'dflt', extra: null, tags: ['a', 'b'], user_id: A, purged_at: expect.any(Date), deleted_at: before.deleted_at });
    expect(Number((await scratchRow(mine)).rev)).toBeGreaterThan(Number(before.rev));
    expect(await scratchRow(theirs)).toMatchObject({ body: 'theirs', extra: 6, purged_at: null });
    expect(await scratchRow(young)).toMatchObject({ body: 'young', purged_at: null });
    await purgeAsCron();
    expect(await scratchRow(theirs)).toMatchObject({ body: 'dflt', extra: null, purged_at: expect.any(Date) });
    expect(await scratchRow(young)).toMatchObject({ body: 'young', purged_at: null });
  });
});

describe('function grants and settings', () => {
  it('both functions are executable by authenticated only (no PUBLIC, no anon) and pin search_path with pg_temp last', async () => {
    await t.asRole('postgres');
    const r = await t.pg.query<Row>(`
      select p.proname, p.prosecdef, p.proconfig,
             array(select distinct case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end
                     from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                    where a.privilege_type = 'EXECUTE' order by 1) as grantees
        from pg_proc p
       where p.pronamespace = 'public'::regnamespace and p.proname in ('pull_changes', 'purge_expired') order by p.proname`);
    expect(r.rows).toEqual([
      { proname: 'pull_changes', prosecdef: false, proconfig: ['search_path=public, pg_temp'], grantees: ['authenticated', 'postgres'] },
      { proname: 'purge_expired', prosecdef: true, proconfig: ['search_path=public, pg_temp'], grantees: ['authenticated', 'postgres'] },
    ]);
  });
});

describe('the pg_cron schedule file', () => {
  const FILE = '20261106000500_schedule_purge.cron.sql';
  it('is a migration the Supabase CLI runs after the functions exist, but the PGlite harness skips it', () => {
    const all = readdirSync(MIGRATIONS_DIR).sort();
    expect(all).toContain(FILE);
    expect(FILE).toMatch(/^\d+_.+\.sql$/);
    expect(all.indexOf(FILE)).toBeGreaterThan(all.indexOf('20261106000300_pull_and_purge.sql'));
    expect(migrationFiles()).not.toContain(FILE);
    expect(migrationFiles()).toContain('20261106000300_pull_and_purge.sql');
  });
  it('contains exactly the two statements: enable pg_cron, schedule purge_expired daily at 03:00 UTC', () => {
    const text = readFileSync(join(MIGRATIONS_DIR, FILE), 'utf8');
    const statements = text.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
      .split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    expect(statements).toEqual([
      'create extension if not exists pg_cron',
      `select cron.schedule('purge-expired', '0 3 * * *', $$select public.purge_expired()$$)`,
    ]);
  });
  it('was not run by the harness (there is no pg_cron here)', async () => {
    await t.asRole('postgres');
    const r = await t.pg.query<Row>(`select to_regnamespace('cron') is null as no_schema, (select count(*)::int from pg_extension where extname = 'pg_cron') as ext`);
    expect(r.rows[0]).toEqual({ no_schema: true, ext: 0 });
  });
});
