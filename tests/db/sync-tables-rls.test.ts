// Every synced table is closed by row-level security with one policy per command, whichever migration added it.
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

let t: TestDb;
beforeEach(async () => { t = await createTestDb(); });
afterEach(async () => { await t.pg.close(); });

it('every table in sync_tables has RLS enabled and one policy per command', async () => {
  await t.asRole('postgres');
  const names = (await t.pg.query<{ name: string }>('select name from sync_tables order by name')).rows.map(r => r.name);
  expect(names).toEqual(['events', 'todos']);
  for (const name of names) {
    const rls = (await t.pg.query<{ on: boolean }>(
      `select c.relrowsecurity as on from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = $1 and c.relkind = 'r'`, [name])).rows;
    expect(rls, name).toEqual([{ on: true }]);
    const policies = (await t.pg.query<{ cmd: string; roles: string[]; qual: string | null }>(
      `select cmd, roles, qual from pg_policies where schemaname = 'public' and tablename = $1 order by cmd`, [name])).rows;
    expect(policies.map(p => p.cmd), name).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    for (const p of policies) expect(p.roles, `${name} ${p.cmd}`).toEqual(['authenticated']);
    // Tombstones are kept forever: the DELETE policy matches nothing.
    expect(policies[0].qual, `${name} DELETE`).toBe('false');
  }
});

it('every table in sync_tables gives authenticated SELECT only and anon nothing (writes go through the functions)', async () => {
  await t.asRole('postgres');
  const names = (await t.pg.query<{ name: string }>('select name from sync_tables order by name')).rows.map(r => r.name);
  const privs = ['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'];
  for (const name of names) {
    for (const [role, want] of [['authenticated', ['select']], ['anon', []]] as const) {
      const got: string[] = [];
      for (const p of privs) {
        const ok = (await t.pg.query<{ ok: boolean }>('select has_table_privilege($1, $2, $3) as ok', [role, `public.${name}`, p])).rows[0].ok;
        if (ok) got.push(p);
      }
      expect(got, `${name} ${role}`).toEqual(want);
    }
  }
});
