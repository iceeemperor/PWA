import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, MIGRATIONS_DIR, migrationFiles, rowOf, SUPABASE_SHIM, TEST_USER_A as A, TEST_USER_B as B, type TestDb } from './harness';

type Row = Record<string, any>;

let t: TestDb;
beforeEach(async () => { t = await createTestDb(); });
afterEach(async () => { await t.pg.close(); });

// Insert as `uid` (never as the superuser, so RLS applies); unset columns take the table defaults.
async function ins(uid: string, overrides: Row = {}): Promise<Row> {
  await t.asUser(uid);
  const f: Row = { id: randomUUID(), title: 'task', ...overrides };
  const keys = Object.keys(f);
  const r = await t.pg.query<Row>(
    `insert into todos (${keys.map(k => `"${k}"`).join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')}) returning *`,
    keys.map(k => f[k]),
  );
  return r.rows[0];
}

// Update as `uid`; resolves to undefined when RLS hides the row (zero rows updated).
async function upd(uid: string, id: string, fields: Row): Promise<Row | undefined> {
  await t.asUser(uid);
  const keys = Object.keys(fields);
  const r = await t.pg.query<Row>(
    `update todos set ${keys.map((k, i) => `"${k}" = $${i + 2}`).join(', ')} where id = $1 returning *`,
    [id, ...keys.map(k => fields[k])],
  );
  return r.rows[0];
}

/**
 * F5: signed-in users have no INSERT or UPDATE on todos (every write goes through the security definer functions).
 * The trigger, RLS and constraint tests below grant them back, as a mistaken grant would, to show that the trigger,
 * the policies (spec 3.3) and the CHECKs still hold as a second line of defence.
 */
async function grantDirectWritesByMistake(): Promise<void> {
  await t.asRole('postgres');
  await t.pg.exec('grant insert, update on todos to authenticated');
}

async function rows(uid: string): Promise<Row[]> {
  await t.asUser(uid);
  return (await t.pg.query<Row>('select * from todos order by rev')).rows;
}

describe('todos: server-managed columns', () => {
  beforeEach(grantDirectWritesByMistake);
  it('rev comes from one shared sequence and increases on every write', async () => {
    const a = await ins(A, {}); const b = await ins(A, {}); await upd(A, a.id, { done: true });
    const r = await rows(A); expect(r.find(x => x.id === a.id)!.rev).toBeGreaterThan(b.rev);
  });
  it('client-supplied rev and updated_at are ignored', async () => {
    const x = await ins(A, { rev: 999999, updated_at: '2000-01-01T00:00:00Z' });
    expect(x.rev).toBeLessThan(999999); expect(new Date(x.updated_at).getFullYear()).toBeGreaterThan(2000);
    const y = await upd(A, x.id, { rev: 5, updated_at: '2000-01-01T00:00:00Z' }); expect(y!.rev).not.toBe(5);
    expect(new Date(y!.updated_at).getFullYear()).toBeGreaterThan(2000);
  });
  it('created_at cannot be changed by an update', async () => {
    const x = await ins(A, {}); const y = await upd(A, x.id, { created_at: '2000-01-01T00:00:00Z' }); expect(y!.created_at).toEqual(x.created_at);
  });
  it('a client-supplied created_at is kept on insert', async () => {
    const x = await ins(A, { created_at: '2020-02-02T00:00:00Z' }); expect(x.created_at).toEqual(new Date('2020-02-02T00:00:00Z'));
  });
  it('app.keep_updated_at = on keeps updated_at for that transaction only, while rev still comes from the sequence', async () => {
    const first = await ins(A, {});
    const old = '2000-01-01T00:00:00Z';
    const { inserted, updated } = await t.pg.transaction(async tx => {
      await tx.query(`select set_config('app.keep_updated_at', 'on', true)`);
      const inserted = (await tx.query<Row>(`insert into todos (id, title, updated_at) values ($1, 'kept', $2) returning *`, [randomUUID(), old])).rows[0];
      const updated = (await tx.query<Row>(`update todos set done = true, updated_at = $2 where id = $1 returning *`, [first.id, old])).rows[0];
      return { inserted, updated };
    });
    expect(inserted.updated_at).toEqual(new Date(old)); expect(updated.updated_at).toEqual(new Date(old));
    expect(inserted.rev).toBeGreaterThan(first.rev); expect(updated.rev).toBeGreaterThan(inserted.rev);
    // The setting was local to that transaction: the next write is stamped again.
    const after = await ins(A, { updated_at: old }); expect(after.updated_at.getFullYear()).toBeGreaterThan(2000);
    const later = await upd(A, first.id, { updated_at: old }); expect(later!.updated_at.getFullYear()).toBeGreaterThan(2000);
  });
});

describe('todos: row-level security', () => {
  beforeEach(grantDirectWritesByMistake);
  it('a user cannot insert a row owned by someone else', async () => expect(ins(A, { user_id: B })).rejects.toThrow(/row-level security/));
  it('a user cannot read or update another user\'s rows', async () => {
    const x = await ins(A, {}); expect(await rows(B)).toHaveLength(0); expect(await upd(B, x.id, { done: true })).toBeUndefined();
    expect((await rows(A))[0].done).toBe(false);
  });
  it('an update cannot move a row to another user', async () => {
    const x = await ins(A, {}); await expect(upd(A, x.id, { user_id: B })).rejects.toThrow(/row-level security/);
    expect((await rows(A))[0].user_id).toBe(A);
  });
  it('user_id defaults to the signed-in user', async () => { expect((await ins(A, {})).user_id).toBe(A); expect((await ins(B, {})).user_id).toBe(B); });
  it('nobody signed in can hard-delete a row, not even their own: a purged row must stay forever as a tombstone', async () => {
    const x = await ins(A, {});
    await t.asUser(A);
    await expect(t.pg.query('delete from todos where id = $1', [x.id])).rejects.toThrow(/permission denied for table todos/);
    await t.asUser(B);
    await expect(t.pg.query('delete from todos where id = $1', [x.id])).rejects.toThrow(/permission denied for table todos/);
    expect(await rows(A)).toHaveLength(1);
  });
  it('the DELETE policy is a second lock: even with delete granted by mistake, no row can be deleted', async () => {
    const x = await ins(A, {});
    await t.asRole('postgres'); await t.pg.exec('grant delete on todos to authenticated');
    await t.asUser(A);
    expect((await t.pg.query('delete from todos where id = $1 returning id', [x.id])).rows).toHaveLength(0);
    expect(await rowOf(t, x.id)).toMatchObject({ id: x.id });
  });
  it('anon has no access to todos at all', async () => {
    const x = await ins(A, {}); await t.asRole('anon');
    await expect(t.pg.query('select * from todos')).rejects.toThrow(/permission denied for table todos/);
    await expect(t.pg.query(`insert into todos (id, title) values ($1, 'x')`, [randomUUID()])).rejects.toThrow(/permission denied for table todos/);
    await expect(t.pg.query(`insert into todos (id, user_id, title) values ($1, $2, 'x')`, [randomUUID(), A])).rejects.toThrow(/permission denied for table todos/);
    await expect(t.pg.query('update todos set done = true where id = $1', [x.id])).rejects.toThrow(/permission denied for table todos/);
    await expect(t.pg.query('delete from todos where id = $1', [x.id])).rejects.toThrow(/permission denied for table todos/);
    expect(await rowOf(t, x.id)).toMatchObject({ id: x.id, done: false });
  });
  it('todos has four separate policies, and the insert and update ones carry a WITH CHECK', async () => {
    const r = await t.pg.query<{ cmd: string; with_check: string | null }>(
      `select cmd, with_check from pg_policies where schemaname = 'public' and tablename = 'todos' order by cmd`);
    expect(r.rows.map(p => p.cmd)).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    for (const p of r.rows.filter(p => p.cmd === 'INSERT' || p.cmd === 'UPDATE')) expect(p.with_check).toMatch(/user_id = auth\.uid\(\)/);
  });
  it('every table in public has row-level security enabled', async () => {
    const r = await t.pg.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
    expect(r.rows).toEqual([]);
  });
});

describe('todos: constraints', () => {
  beforeEach(grantDirectWritesByMistake);
  it('title must be non-empty unless purged_at is set', async () => {
    await expect(ins(A, { title: '' })).rejects.toThrow(/check constraint/);
    await expect(ins(A, { title: '', purged_at: new Date().toISOString() })).resolves.toBeDefined();
  });
  it('kind and priority only accept their allowed values', async () => {
    await expect(ins(A, { kind: 'event' })).rejects.toThrow(/check constraint/);
    await expect(ins(A, { priority: 'urgent' })).rejects.toThrow(/check constraint/);
    const x = await ins(A, { kind: 'goal', priority: 'high' }); expect(x).toMatchObject({ kind: 'goal', priority: 'high' });
  });
  it('an insert with only a title fills every other content column from its default', async () => {
    expect(await ins(A, { title: 'only title' })).toMatchObject({
      kind: 'todo', done: false, priority: 'normal', due_date: null, note: '', steps: [], deleted_at: null, purged_at: null,
    });
  });
  it('every content column has a DEFAULT, because purging resets them to it', async () => {
    const r = await t.pg.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'todos' and column_default is null
          and column_name not in ('id', 'deleted_at', 'purged_at', 'due_date')`);
    expect(r.rows).toEqual([]);
  });
  it('rev has an index per user for incremental pulls', async () => {
    const r = await t.pg.query<{ indexdef: string }>(`select indexdef from pg_indexes where tablename = 'todos'`);
    expect(r.rows.some(i => /\(user_id, rev\)/.test(i.indexdef))).toBe(true);
  });
});

describe('sync bookkeeping tables', () => {
  it('sync_tables lists todos and is readable but not writable by signed-in users', async () => {
    await t.asUser(A);
    expect((await t.pg.query('select name, copy_fields from sync_tables')).rows).toEqual([{ name: 'todos', copy_fields: [] }]);
    await expect(t.pg.query(`insert into sync_tables (name) values ('x')`)).rejects.toThrow(/permission denied/);
    await expect(t.pg.query(`update sync_tables set copy_fields = '{title}'`)).rejects.toThrow(/permission denied/);
    await expect(t.pg.query('delete from sync_tables')).rejects.toThrow(/permission denied/);
    await t.asRole('postgres'); expect((await t.pg.query('select * from sync_tables')).rows).toEqual([{ name: 'todos', copy_fields: [] }]);
  });
  it('anon cannot read or write sync_tables', async () => {
    await t.asRole('anon');
    await expect(t.pg.query('select * from sync_tables')).rejects.toThrow(/permission denied/);
    await expect(t.pg.query(`insert into sync_tables (name) values ('x')`)).rejects.toThrow(/permission denied/);
  });
  it('applied_ops is closed to signed-in users and anon: only security definer functions can touch it', async () => {
    await t.pg.query(`insert into applied_ops (user_id, op_id, result) values ($1, $2, '{}')`, [A, randomUUID()]);
    for (const asWho of [() => t.asUser(A), () => t.asRole('anon')]) {
      await asWho();
      await expect(t.pg.query('select * from applied_ops')).rejects.toThrow(/permission denied for table applied_ops/);
      await expect(t.pg.query(`insert into applied_ops (user_id, op_id, result) values ($1, $2, '{}')`, [A, randomUUID()])).rejects.toThrow(/permission denied for table applied_ops/);
    }
    await t.asRole('postgres'); expect((await t.pg.query('select * from applied_ops')).rows).toHaveLength(1);
  });
  it('applied_ops has RLS on and no policy: a mistaken grant would still show and allow nothing', async () => {
    await t.pg.query(`insert into applied_ops (user_id, op_id, result) values ($1, $2, '{}')`, [A, randomUUID()]);
    await t.pg.exec('grant select, insert on applied_ops to authenticated');
    await t.asUser(A);
    expect((await t.pg.query('select * from applied_ops')).rows).toHaveLength(0);
    await expect(t.pg.query(`insert into applied_ops (user_id, op_id, result) values ($1, $2, '{}')`, [A, randomUUID()])).rejects.toThrow(/row-level security/);
    await t.asRole('postgres'); expect((await t.pg.query('select * from applied_ops')).rows).toHaveLength(1);
  });
});

// Functions are executable by anon and authenticated by default (like on Supabase), so the tests that
// Tasks 5, 6 and 13 write for their functions can tell a missing `revoke ... from anon` from a good migration.
describe('function privileges', () => {
  const call = async () => (await t.pg.query<{ n: number }>('select public.probe_fn() as n')).rows[0].n;

  it('revoking only from public leaves a function callable by anon: an "anon cannot call" test catches that mistake', async () => {
    await t.pg.exec(`create function public.probe_fn() returns int language sql as 'select 1'; revoke all on function public.probe_fn() from public;`);
    await t.asRole('anon'); expect(await call()).toBe(1);               // the half-done revoke is visible
    await t.asRole('postgres');
    await t.pg.exec('revoke all on function public.probe_fn() from public, anon, authenticated; grant execute on function public.probe_fn() to authenticated;');
    await t.asRole('anon'); await expect(call()).rejects.toThrow(/permission denied for function probe_fn/);
    await t.asUser(A); expect(await call()).toBe(1);
  });
});

// The migration grants explicitly and the harness gives tables and sequences nothing by default, so what
// a role can do with them is exactly what the migration says. TRUNCATE and setval are not covered by RLS, so they are checked here.
describe('privileges', () => {
  const can = async (role: string, priv: string, table: string) =>
    (await t.pg.query<{ ok: boolean }>('select has_table_privilege($1, $2, $3) as ok', [role, `public.${table}`, priv])).rows[0].ok;

  it('authenticated may only select todos (F5: no direct insert or update; writes go through the functions)', async () => {
    expect(await can('authenticated', 'select', 'todos'), 'select').toBe(true);
    for (const priv of ['insert', 'update', 'delete', 'truncate', 'references', 'trigger']) expect(await can('authenticated', priv, 'todos'), priv).toBe(false);
  });
  it('a direct insert or update by a signed-in user is denied, so a tombstone cannot be brought back outside import (F5)', async () => {
    await t.asUser(A);
    const op = { op_id: randomUUID(), id: randomUUID(), kind: 'insert', base_rev: null, fields: { title: 'mine' } };
    const r = (await t.pg.query<{ r: Row }>('select push_change($1, $2::jsonb) as r', ['todos', JSON.stringify(op)])).rows[0].r;
    expect(r.status).toBe('applied');
    await t.asRole('postgres');
    await t.pg.query(`update todos set purged_at = now(), deleted_at = now(), title = '' where id = $1`, [op.id]);
    await t.asUser(A);
    await expect(t.pg.query(`insert into todos (id, title) values ($1, 'x')`, [randomUUID()])).rejects.toThrow(/permission denied for table todos/);
    await expect(t.pg.query(`insert into todos (id, user_id, title) values ($1, $2, 'x')`, [randomUUID(), A])).rejects.toThrow(/permission denied for table todos/);
    await expect(t.pg.query(`update todos set purged_at = null, title = 'resurrected' where id = $1`, [op.id])).rejects.toThrow(/permission denied for table todos/);
    await expect(t.pg.query(`update todos set steps = '"direct"' where id = $1`, [op.id])).rejects.toThrow(/permission denied for table todos/);
    expect(await rowOf(t, op.id)).toMatchObject({ title: '', purged_at: expect.any(Date) });
    // Reading stays: pull_changes is security invoker and needs SELECT.
    expect((await t.pg.query('select id from todos')).rows).toHaveLength(1);
  });
  it('anon has no privilege on any table', async () => {
    for (const table of ['todos', 'applied_ops', 'sync_tables'])
      for (const priv of ['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) expect(await can('anon', priv, table), `${table} ${priv}`).toBe(false);
  });
  it('signed-in users cannot truncate todos or applied_ops, and anon cannot truncate todos', async () => {
    await grantDirectWritesByMistake();
    const x = await ins(A, {});
    await t.asRole('postgres');
    await t.pg.query(`insert into applied_ops (user_id, op_id, result) values ($1, $2, '{}')`, [A, randomUUID()]);
    await t.asUser(A);
    await expect(t.pg.query('truncate todos')).rejects.toThrow(/permission denied for table todos/);
    await expect(t.pg.query('truncate applied_ops')).rejects.toThrow(/permission denied for table applied_ops/);
    await t.asRole('anon');
    await expect(t.pg.query('truncate todos')).rejects.toThrow(/permission denied for table todos/);
    expect(await rowOf(t, x.id)).toMatchObject({ id: x.id });
    await t.asRole('postgres'); expect((await t.pg.query('select * from applied_ops')).rows).toHaveLength(1);
  });
  it('rev_seq: signed-in users may only take the next value (their writes need it); they cannot reset it or read it', async () => {
    const seq = async (role: string, priv: string) =>
      (await t.pg.query<{ ok: boolean }>(`select has_sequence_privilege($1, 'public.rev_seq', $2) as ok`, [role, priv])).rows[0].ok;
    expect(await seq('authenticated', 'usage')).toBe(true);
    expect(await seq('authenticated', 'update')).toBe(false);
    expect(await seq('authenticated', 'select')).toBe(false);
    for (const priv of ['usage', 'update', 'select']) expect(await seq('anon', priv), `anon ${priv}`).toBe(false);
    await t.asUser(A);
    await expect(t.pg.query(`select setval('rev_seq', 1)`)).rejects.toThrow(/permission denied for sequence rev_seq/);
    expect((await t.pg.query<{ n: number }>(`select nextval('rev_seq') as n`)).rows[0].n).toBeGreaterThan(0);
    await t.asRole('anon');
    await expect(t.pg.query(`select nextval('rev_seq')`)).rejects.toThrow(/permission denied for sequence rev_seq/);
  });
});

// Projects created before Supabase stopped exposing new tables still hand every new table, sequence and
// function to anon and authenticated. The `revoke all` lines in the migration are what keep the privileges
// right there, and the harness (which grants nothing by default) cannot show them working. So this runs the
// migrations on a fresh database that has the old default grants.
describe('migration on a project with the old default grants', () => {
  it('still ends up with exactly the intended privileges', async () => {
    const pg = new PGlite();
    try {
      await pg.exec(SUPABASE_SHIM);
      await pg.exec(`
        alter default privileges in schema public grant all on tables to anon, authenticated;
        alter default privileges in schema public grant all on sequences to anon, authenticated;
        alter default privileges in schema public grant all on functions to anon, authenticated;
      `);
      for (const file of migrationFiles()) await pg.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));

      const granted = async (check: 'has_table_privilege' | 'has_sequence_privilege', role: string, object: string, privs: string[]) =>
        (await pg.query<{ p: string }>(
          `select p from unnest($3::text[]) with ordinality as u(p, i) where ${check}($1, $2, p) order by i`,
          [role, `public.${object}`, privs])).rows.map(r => r.p);
      const tablePrivs = ['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'];
      const seqPrivs = ['usage', 'select', 'update'];

      // The old defaults really are in force here: a table nobody revoked is open to both roles.
      await pg.exec('create table public.probe (n int)');
      expect(await granted('has_table_privilege', 'authenticated', 'probe', tablePrivs)).toEqual(tablePrivs);
      expect(await granted('has_table_privilege', 'anon', 'probe', tablePrivs)).toEqual(tablePrivs);

      expect({
        'todos authenticated': await granted('has_table_privilege', 'authenticated', 'todos', tablePrivs),
        'todos anon': await granted('has_table_privilege', 'anon', 'todos', tablePrivs),
        'applied_ops authenticated': await granted('has_table_privilege', 'authenticated', 'applied_ops', tablePrivs),
        'applied_ops anon': await granted('has_table_privilege', 'anon', 'applied_ops', tablePrivs),
        'sync_tables authenticated': await granted('has_table_privilege', 'authenticated', 'sync_tables', tablePrivs),
        'sync_tables anon': await granted('has_table_privilege', 'anon', 'sync_tables', tablePrivs),
        'rev_seq authenticated': await granted('has_sequence_privilege', 'authenticated', 'rev_seq', seqPrivs),
        'rev_seq anon': await granted('has_sequence_privilege', 'anon', 'rev_seq', seqPrivs),
      }).toEqual({
        'todos authenticated': ['select'],
        'todos anon': [],
        'applied_ops authenticated': [],
        'applied_ops anon': [],
        'sync_tables authenticated': ['select'],
        'sync_tables anon': [],
        'rev_seq authenticated': ['usage'],
        'rev_seq anon': [],
      });
    } finally { await pg.close(); }
  }, 30_000);
});
