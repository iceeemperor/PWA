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
  it('a user can delete only their own rows', async () => {
    const x = await ins(A, {});
    await t.asUser(B); await t.pg.query('delete from todos where id = $1', [x.id]); expect(await rows(A)).toHaveLength(1);
    await t.asUser(A); await t.pg.query('delete from todos where id = $1', [x.id]); expect(await rows(A)).toHaveLength(0);
  });
  it('anon can neither read nor write todos', async () => {
    const x = await ins(A, {}); await t.asRole('anon');
    expect((await t.pg.query('select * from todos')).rows).toHaveLength(0);
    await expect(t.pg.query(`insert into todos (id, title) values ($1, 'x')`, [randomUUID()])).rejects.toThrow();
    await expect(t.pg.query(`insert into todos (id, user_id, title) values ($1, $2, 'x')`, [randomUUID(), A])).rejects.toThrow(/row-level security/);
    expect((await t.pg.query('update todos set done = true where id = $1 returning id', [x.id])).rows).toHaveLength(0);
    await t.pg.query('delete from todos where id = $1', [x.id]);
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
    await expect(ins(A, { title: '' })).rejects.toThrow();
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
  it('applied_ops has RLS on and no policy: signed-in users see and write nothing', async () => {
    await t.pg.query(`insert into applied_ops (user_id, op_id, result) values ($1, $2, '{}')`, [A, randomUUID()]);
    await t.asUser(A);
    expect((await t.pg.query('select * from applied_ops')).rows).toHaveLength(0);
    await expect(t.pg.query(`insert into applied_ops (user_id, op_id, result) values ($1, $2, '{}')`, [A, randomUUID()])).rejects.toThrow();
    await t.asRole('postgres'); expect((await t.pg.query('select * from applied_ops')).rows).toHaveLength(1);
  });
});
