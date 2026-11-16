import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, rowOf, TEST_USER_A as A, TEST_USER_B as B, type TestDb } from './harness';

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

async function rows(uid: string): Promise<Row[]> {
  await t.asUser(uid);
  return (await t.pg.query<Row>('select * from todos order by rev')).rows;
}

describe('todos: server-managed columns', () => {
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

// The migration grants explicitly and the harness gives nothing by default, so what a role can do
// is exactly what the migration says. TRUNCATE and setval are not covered by RLS, so they are checked here.
describe('privileges', () => {
  const can = async (role: string, priv: string, table: string) =>
    (await t.pg.query<{ ok: boolean }>('select has_table_privilege($1, $2, $3) as ok', [role, `public.${table}`, priv])).rows[0].ok;

  it('authenticated may select, insert and update todos, and nothing else', async () => {
    for (const priv of ['select', 'insert', 'update']) expect(await can('authenticated', priv, 'todos'), priv).toBe(true);
    for (const priv of ['delete', 'truncate', 'references', 'trigger']) expect(await can('authenticated', priv, 'todos'), priv).toBe(false);
  });
  it('anon has no privilege on any table', async () => {
    for (const table of ['todos', 'applied_ops', 'sync_tables'])
      for (const priv of ['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) expect(await can('anon', priv, table), `${table} ${priv}`).toBe(false);
  });
  it('signed-in users cannot truncate todos or applied_ops, and anon cannot truncate todos', async () => {
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
