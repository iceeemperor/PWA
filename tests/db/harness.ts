import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Fixed users so tests can assert on ids.
export const TEST_USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const TEST_USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export interface TestDb {
  pg: PGlite;
  /** Sign in as `uid`: role `authenticated`, auth.uid() = uid. RLS applies. */
  asUser(uid: string): Promise<void>;
  /** `anon`: not signed in, RLS applies. `postgres`: superuser, RLS bypassed. Both have auth.uid() = null. */
  asRole(role: 'anon' | 'postgres'): Promise<void>;
}

/** A row as it comes back from PGlite (timestamps and dates are Date, small bigints are numbers). */
export type TodoRow = Record<string, any>;

const MIGRATIONS_DIR = fileURLToPath(new URL('../../supabase/migrations', import.meta.url));

/**
 * The migrations the harness runs: `.sql` files in file-name order, without `*.cron.sql`
 * (those schedule jobs with pg_cron, which PGlite does not have).
 */
export function migrationFiles(dir: string = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter(f => f.endsWith('.sql') && !f.endsWith('.cron.sql'))
    .sort();
}

// What Supabase provides before any migration runs: the auth schema with auth.users and auth.uid(),
// the two API roles, and default privileges that give both roles everything on new public objects.
// Row-level security, not grants, is then what keeps users apart, exactly as on a real project.
// (ALTER DEFAULT PRIVILEGES takes one object class per statement, hence three statements.)
const SUPABASE_SHIM = `
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema auth to anon, authenticated;
  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on sequences to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;
`;

// Starting PGlite cold costs about 1.5 s (it runs initdb). So the schema is built once per test
// file, as a snapshot of the data directory with the shim, the test users and all migrations applied,
// and every createTestDb() restores its own private in-memory copy of it (about 0.3 s).
// Nothing is shared between tests: each call gets a new database and writes to it stay there.
let template: Promise<Blob> | undefined;

async function buildTemplate(): Promise<Blob> {
  const pg = new PGlite();
  try {
    await pg.exec(SUPABASE_SHIM);
    await pg.query('insert into auth.users (id) values ($1), ($2)', [TEST_USER_A, TEST_USER_B]);
    for (const file of migrationFiles()) await pg.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    return await pg.dumpDataDir('none');
  } finally { await pg.close(); }
}

export async function createTestDb(): Promise<TestDb> {
  template ??= buildTemplate();
  const pg = await PGlite.create({ loadDataDir: await template });

  const setClaim = (sub: string) => pg.query(`select set_config('request.jwt.claim.sub', $1, false)`, [sub]);
  return {
    pg,
    async asUser(uid) {
      await pg.exec('set role authenticated');
      await setClaim(uid);
    },
    async asRole(role) {
      await pg.exec(role === 'anon' ? 'set role anon' : 'reset role');
      await setClaim('');
    },
  };
}

// Superuser helpers. They run as the superuser whatever role the test is currently in and then
// put that role back (the signed-in user is a session setting that they never touch).
async function asSuperuser<T>(t: TestDb, fn: () => Promise<T>): Promise<T> {
  const { role } = (await t.pg.query<{ role: string }>('select current_user as role')).rows[0];
  if (role !== 'postgres' && role !== 'anon' && role !== 'authenticated') throw new Error(`unexpected role ${role}`);
  await t.pg.exec('reset role');
  try { return await fn(); }
  finally { if (role !== 'postgres') await t.pg.exec(`set role ${role}`); }
}

function noRow(id: string): Error { return new Error(`no todos row ${id}`); }

/** The whole row, whoever owns it. Throws if there is none. */
export function rowOf(t: TestDb, id: string): Promise<TodoRow> {
  return asSuperuser(t, async () => {
    const r = await t.pg.query<TodoRow>('select * from todos where id = $1', [id]);
    if (r.rows.length === 0) throw noRow(id);
    return r.rows[0];
  });
}

/** Put the row in the trash `daysAgo` days ago (bumps rev through the trigger, like any write). */
export function trashAt(t: TestDb, id: string, daysAgo: number): Promise<void> {
  return asSuperuser(t, async () => {
    const r = await t.pg.query(
      `update todos set deleted_at = now() - $2::float8 * interval '1 day' where id = $1`, [id, daysAgo]);
    if (r.affectedRows !== 1) throw noRow(id);
  });
}

/** Turn the row into a tombstone the way the purge does: content back to its defaults, purged_at and deleted_at now. */
export function makeTombstone(t: TestDb, id: string): Promise<void> {
  return asSuperuser(t, async () => {
    const r = await t.pg.query(
      `update todos set purged_at = now(), deleted_at = now(),
         kind = default, title = default, done = default, priority = default,
         due_date = default, note = default, steps = default
       where id = $1`, [id]);
    if (r.affectedRows !== 1) throw noRow(id);
  });
}
