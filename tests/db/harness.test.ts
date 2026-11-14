import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, makeTombstone, migrationFiles, rowOf, TEST_USER_A, TEST_USER_B, trashAt, type TestDb } from './harness';

// Feasibility gate for the SQL test strategy: before any schema exists, prove that
// PGlite (WASM Postgres, no Docker) enforces what the real tests will rely on.
describe('PGlite capability gate', () => {
  let pg: PGlite;
  const ME = '11111111-1111-4111-8111-111111111111';
  const OTHER = '22222222-2222-4222-8222-222222222222';

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec(`
      create role tester nologin;
      create sequence gate_seq;
      create table gate (
        id int primary key generated always as identity,
        owner uuid not null,
        rev bigint not null default 0
      );
      create function gate_stamp() returns trigger language plpgsql as $$
      begin new.rev := nextval('gate_seq'); return new; end $$;
      create trigger gate_stamp before insert or update on gate
        for each row execute function gate_stamp();
      alter table gate enable row level security;
      create policy gate_select on gate for select
        using (owner = nullif(current_setting('app.uid', true), '')::uuid);
      create policy gate_insert on gate for insert
        with check (owner = nullif(current_setting('app.uid', true), '')::uuid);
      create policy gate_update on gate for update
        using (owner = nullif(current_setting('app.uid', true), '')::uuid)
        with check (owner = nullif(current_setting('app.uid', true), '')::uuid);
      grant select, insert, update on gate to tester;
      grant usage on sequence gate_seq to tester;
    `);
  });
  afterEach(async () => { await pg.close(); });

  it('rejects an insert that violates row-level security after switching role', async () => {
    await pg.exec(`set role tester; select set_config('app.uid', '${ME}', false)`);
    await pg.query('insert into gate(owner) values ($1)', [ME]);
    await expect(pg.query('insert into gate(owner) values ($1)', [OTHER])).rejects.toThrow(/row-level security/);
  });

  it('hides rows from other users, and the superuser sees everything again after reset role', async () => {
    await pg.exec(`set role tester; select set_config('app.uid', '${ME}', false)`);
    await pg.query('insert into gate(owner) values ($1)', [ME]);
    await pg.exec(`select set_config('app.uid', '${OTHER}', false)`);
    expect((await pg.query('select * from gate')).rows).toHaveLength(0);
    await pg.exec('reset role');
    expect((await pg.query('select * from gate')).rows).toHaveLength(1);
  });

  it('fires the trigger and draws from the sequence on every write', async () => {
    await pg.exec(`set role tester; select set_config('app.uid', '${ME}', false)`);
    const a = (await pg.query<{ rev: number }>('insert into gate(owner) values ($1) returning rev', [ME])).rows[0];
    const b = (await pg.query<{ rev: number }>('insert into gate(owner) values ($1) returning rev', [ME])).rows[0];
    expect(b.rev).toBeGreaterThan(a.rev);
    const c = (await pg.query<{ rev: number }>('update gate set rev = 5 where id = 1 returning rev')).rows[0];
    expect(c.rev).toBeGreaterThan(b.rev);
  });

  it('enforces sequence privileges for the switched role', async () => {
    await pg.exec(`revoke usage on sequence gate_seq from tester; set role tester; select set_config('app.uid', '${ME}', false)`);
    await expect(pg.query('insert into gate(owner) values ($1)', [ME])).rejects.toThrow(/permission denied/);
  });
});

describe('createTestDb', () => {
  let t: TestDb;
  beforeEach(async () => { t = await createTestDb(); });
  afterEach(async () => { await t.pg.close(); });

  const whoAmI = async () => (await t.pg.query<{ role: string; uid: string | null }>('select current_user as role, auth.uid() as uid')).rows[0];

  it('exports two distinct fixed test users and seeds them into auth.users', async () => {
    expect(TEST_USER_A).not.toBe(TEST_USER_B);
    const ids = (await t.pg.query<{ id: string }>('select id from auth.users order by id')).rows.map(r => r.id);
    expect(ids).toEqual([TEST_USER_A, TEST_USER_B].sort());
  });

  it('starts as the superuser with no signed-in user', async () => {
    expect(await whoAmI()).toEqual({ role: 'postgres', uid: null });
  });

  it('asUser signs in as the given user under the authenticated role', async () => {
    await t.asUser(TEST_USER_A); expect(await whoAmI()).toEqual({ role: 'authenticated', uid: TEST_USER_A });
    await t.asUser(TEST_USER_B); expect(await whoAmI()).toEqual({ role: 'authenticated', uid: TEST_USER_B });
  });

  it('asRole drops the signed-in user: anon and postgres both see auth.uid() as null', async () => {
    await t.asUser(TEST_USER_A);
    await t.asRole('anon'); expect(await whoAmI()).toEqual({ role: 'anon', uid: null });
    await t.asUser(TEST_USER_A);
    await t.asRole('postgres'); expect(await whoAmI()).toEqual({ role: 'postgres', uid: null });
  });

  it('grants tables, sequences and functions created later to anon and authenticated, like Supabase', async () => {
    await t.pg.exec(`
      create table public.probe (n int);
      create sequence public.probe_seq;
      create function public.probe_fn() returns int language sql as 'select 1';
    `);
    for (const role of ['anon', 'authenticated'] as const) {
      const r = await t.pg.query<{ tbl: boolean; seq: boolean; fn: boolean }>(
        `select has_table_privilege($1, 'public.probe', 'insert') as tbl,
                has_sequence_privilege($1, 'public.probe_seq', 'usage') as seq,
                has_function_privilege($1, 'public.probe_fn()', 'execute') as fn`, [role]);
      expect(r.rows[0]).toEqual({ tbl: true, seq: true, fn: true });
    }
  });

  it('gives every call its own empty in-memory database', async () => {
    await t.pg.exec('create table marker (n int)');
    const other = await createTestDb();
    try {
      const r = await other.pg.query(`select 1 from pg_tables where tablename = 'marker'`);
      expect(r.rows).toHaveLength(0);
    } finally { await other.pg.close(); }
  });
});

describe('migrationFiles', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'migrations-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('lists .sql files in file-name order and skips .cron.sql files and other files', () => {
    for (const f of ['20260102_b.sql', '20260101_a.sql', '20260103_schedule.cron.sql', 'notes.md', '20260104_c.sql']) writeFileSync(join(dir, f), '');
    expect(migrationFiles(dir)).toEqual(['20260101_a.sql', '20260102_b.sql', '20260104_c.sql']);
  });

  it('finds the real migrations directory', () => {
    expect(migrationFiles()).toContain('20261106000100_core.sql');
  });
});

describe('superuser helpers', () => {
  let t: TestDb;
  beforeEach(async () => { t = await createTestDb(); });
  afterEach(async () => { await t.pg.close(); });

  const id = '33333333-3333-4333-8333-333333333333';
  async function seed(owner: string) {
    await t.pg.query(
      `insert into todos (id, user_id, title, note, steps, done, priority, due_date) values ($1, $2, 'secret', 'n', '[{"id":"s"}]', true, 'high', '2026-01-01')`,
      [id, owner]);
  }
  const currentRole = async () => (await t.pg.query<{ r: string }>('select current_user as r')).rows[0].r;

  it('rowOf returns the whole row regardless of owner, and throws for an unknown id', async () => {
    await seed(TEST_USER_A);
    await t.asUser(TEST_USER_B);
    expect(await rowOf(t, id)).toMatchObject({ id, user_id: TEST_USER_A, title: 'secret', rev: expect.any(Number) });
    await expect(rowOf(t, randomUUID())).rejects.toThrow(/no todos row/);
  });

  it('trashAt sets deleted_at that many days ago and bumps rev', async () => {
    await seed(TEST_USER_A); const before = (await rowOf(t, id)).rev;
    await trashAt(t, id, 31);
    const row = await rowOf(t, id);
    const days = (Date.now() - row.deleted_at.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(30.99); expect(days).toBeLessThan(31.01);
    expect(row.purged_at).toBeNull(); expect(row.rev).toBeGreaterThan(before);
  });

  it('makeTombstone purges the row: content back to defaults, purged_at and deleted_at set, rev bumped', async () => {
    await seed(TEST_USER_A); const before = await rowOf(t, id);
    await makeTombstone(t, id);
    const row = await rowOf(t, id);
    expect(row).toMatchObject({ id, user_id: TEST_USER_A, created_at: before.created_at, kind: 'todo', title: '', done: false, priority: 'normal', due_date: null, note: '', steps: [] });
    expect(row.purged_at).toBeInstanceOf(Date); expect(row.deleted_at).toBeInstanceOf(Date); expect(row.rev).toBeGreaterThan(before.rev);
    expect(Math.abs(Date.now() - row.purged_at.getTime())).toBeLessThan(60_000);
  });

  it('helpers work from any role and leave the caller\'s role and user as they were', async () => {
    await seed(TEST_USER_A);
    await t.asUser(TEST_USER_B);
    await trashAt(t, id, 1); await makeTombstone(t, id); await rowOf(t, id);
    expect(await currentRole()).toBe('authenticated');
    expect((await t.pg.query<{ u: string }>('select auth.uid() as u')).rows[0].u).toBe(TEST_USER_B);
    await t.asRole('anon'); await rowOf(t, id); expect(await currentRole()).toBe('anon');
  });
});
