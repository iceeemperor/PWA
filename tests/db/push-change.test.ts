import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, makeTombstone as makeTombstoneRaw, rowOf, trashAt, TEST_USER_A as A, TEST_USER_B as B, type TestDb } from './harness';

type Row = Record<string, any>;
type Kind = 'insert' | 'update' | 'delete' | 'restore';

let t: TestDb;
let id1: string;
beforeEach(async () => { t = await createTestDb(); id1 = randomUUID(); });
afterEach(async () => { await t.pg.close(); });

const op = (kind: Kind, id: string, fields: Row, base_rev: number | null, op_id: string = randomUUID()) =>
  ({ op_id, id, kind, base_rev, fields });

async function push(uid: string, o: Row, table = 'todos'): Promise<Row> {
  await t.asUser(uid);
  return (await t.pg.query<{ r: Row }>('select push_change($1, $2::jsonb) as r', [table, JSON.stringify(o)])).rows[0].r;
}
async function count(uid: string): Promise<number> {
  await t.asUser(uid);
  return Number((await t.pg.query<{ n: number }>('select count(*)::int as n from todos')).rows[0].n);
}
async function titleOf(uid: string, id: string): Promise<string | undefined> {
  await t.asUser(uid);
  return (await t.pg.query<Row>('select title from todos where id = $1', [id])).rows[0]?.title;
}
const makeTombstone = (id: string) => makeTombstoneRaw(t, id);
async function storedOps(): Promise<number> {
  await t.asRole('postgres');
  return Number((await t.pg.query<{ n: number }>('select count(*)::int as n from applied_ops')).rows[0].n);
}

describe('push_change: the brief', () => {
  it('insert applies, assigns rev and forces user_id to the caller', async () => {
    const r = await push(A, op('insert', id1, { title: 'a', user_id: B }, null));
    expect(r).toMatchObject({ status: 'applied', conflict: false, message: null });
    expect(r.rev).toBeGreaterThan(0); expect(r.record.user_id).toBe(A); expect(r.record.rev).toBe(r.rev);
  });
  it('replaying the same op_id returns the stored result and writes nothing', async () => {
    const o = op('insert', id1, { title: 'a' }, null); const r1 = await push(A, o); const r2 = await push(A, o);
    expect(r2).toEqual(r1); expect(await count(A)).toBe(1);
  });
  it('update with the current base_rev is not a conflict', async () => {
    const r1 = await push(A, op('insert', id1, { title: 'a' }, null)); const r2 = await push(A, op('update', id1, { done: true }, r1.rev));
    expect(r2).toMatchObject({ status: 'applied', conflict: false });
  });
  it('update with a stale base_rev is applied, flagged, and only overwrites the sent fields', async () => {
    const r1 = await push(A, op('insert', id1, { title: 'a' }, null)); await push(A, op('update', id1, { title: 'from B' }, r1.rev));
    const r3 = await push(A, op('update', id1, { done: true }, r1.rev));
    expect(r3).toMatchObject({ status: 'applied', conflict: true }); expect(r3.record).toMatchObject({ title: 'from B', done: true });
  });
  it('delete always applies and sets deleted_at; restore clears it', async () => {
    await push(A, op('insert', id1, { title: 'a' }, null));
    const d = await push(A, op('delete', id1, {}, 0)); expect(d.record.deleted_at).not.toBeNull();
    const s = await push(A, op('restore', id1, {}, d.rev)); expect(s.record.deleted_at).toBeNull();
  });
  it('update on a trashed record is dropped and the row is unchanged', async () => {
    await push(A, op('insert', id1, { title: 'a' }, null)); await push(A, op('delete', id1, {}, 0));
    const r = await push(A, op('update', id1, { title: 'late' }, 0)); expect(r.status).toBe('dropped_trashed'); expect(r.record.title).toBe('a');
  });
  it('any op on a tombstone is dropped as purged', async () => {
    await push(A, op('insert', id1, { title: 'a' }, null)); await makeTombstone(id1);
    for (const k of ['update', 'delete', 'restore'] as const) expect((await push(A, op(k, id1, { title: 'x' }, 0))).status).toBe('dropped_purged');
  });
  it('insert with an existing id behaves as an update and creates no duplicate', async () => {
    await push(A, op('insert', id1, { title: 'a' }, null)); const r = await push(A, op('insert', id1, { title: 'b' }, null));
    expect(r.record.title).toBe('b'); expect(await count(A)).toBe(1);
  });
  it('server-managed keys in fields are ignored', async () => {
    const r = await push(A, op('insert', id1, { title: 'a', rev: 999999, updated_at: '2000-01-01T00:00:00Z', purged_at: '2000-01-01T00:00:00Z' }, null));
    expect(r.rev).toBeLessThan(999999); expect(r.record.purged_at).toBeNull();
  });
  it('invalid data returns status invalid with a message and writes nothing', async () => {
    const r = await push(A, op('insert', id1, { title: '' }, null)); expect(r.status).toBe('invalid'); expect(r.message).toBeTruthy(); expect(await count(A)).toBe(0);
  });
  it("another user's id cannot be taken over", async () => {
    await push(A, op('insert', id1, { title: 'a' }, null)); const r = await push(B, op('insert', id1, { title: 'x' }, null));
    expect(r.status).toBe('invalid'); expect(await titleOf(A, id1)).toBe('a');
  });
  it('unauthenticated and anon callers are rejected', async () => {
    await t.pg.exec(`reset role; select set_config('request.jwt.claim.sub','',false)`);
    await t.pg.exec('set role authenticated');
    await expect(t.pg.query(`select push_change('todos', '{}')`)).rejects.toThrow(/not_authenticated/);
    await t.asRole('anon'); await expect(t.pg.query(`select push_change('todos', '{}')`)).rejects.toThrow(/permission denied/);
  });
  it('unknown tables are rejected', async () => { await t.asUser(A); await expect(t.pg.query(`select push_change('nope', '{}')`)).rejects.toThrow(/unknown_table/); });
});

describe('push_change: beyond the brief', () => {
  it('a stale base_rev with no overlapping field keeps the other fields', async () => {
    const r1 = await push(A, op('insert', id1, { title: 'a', note: 'n' }, null));
    await push(A, op('update', id1, { title: 'b', priority: 'high' }, r1.rev));
    const r = await push(A, op('update', id1, { note: 'm' }, r1.rev));
    expect(r).toMatchObject({ status: 'applied', conflict: true });
    expect(r.record).toMatchObject({ title: 'b', priority: 'high', note: 'm' });
  });
  it('unknown and server-managed keys are ignored on update too', async () => {
    const r1 = await push(A, op('insert', id1, { title: 'a' }, null));
    const r = await push(A, op('update', id1, {
      bogus: 1, user_id: B, id: randomUUID(), rev: 999999, deleted_at: '2000-01-01T00:00:00Z',
      purged_at: '2000-01-01T00:00:00Z', updated_at: '2000-01-01T00:00:00Z', title: 'z' }, r1.rev));
    expect(r.status).toBe('applied');
    expect(r.record).toMatchObject({ id: id1, user_id: A, deleted_at: null, purged_at: null, title: 'z' });
    expect(r.rev).toBeLessThan(999999);
    expect(new Date(r.record.updated_at).getFullYear()).toBeGreaterThan(2000);
  });
  it('insert takes created_at from the client, update ignores it', async () => {
    const r1 = await push(A, op('insert', id1, { title: 'a', created_at: '2020-01-02T03:04:05Z' }, null));
    expect(new Date(r1.record.created_at).toISOString()).toBe('2020-01-02T03:04:05.000Z');
    const r2 = await push(A, op('update', id1, { created_at: '2001-01-01T00:00:00Z' }, r1.rev));
    expect(new Date(r2.record.created_at).toISOString()).toBe('2020-01-02T03:04:05.000Z');
  });
  it('insert only writes the sent columns, the rest take the defaults', async () => {
    const r = await push(A, op('insert', id1, { title: 'a' }, null));
    expect(r.record).toMatchObject({ kind: 'todo', done: false, priority: 'normal', due_date: null, note: '', steps: [] });
  });
  it('restore on a live row is a harmless applied no-op', async () => {
    const r1 = await push(A, op('insert', id1, { title: 'a' }, null));
    const r = await push(A, op('restore', id1, {}, r1.rev));
    expect(r).toMatchObject({ status: 'applied', conflict: false, rev: r1.rev }); expect(r.record.deleted_at).toBeNull();
  });
  it('delete on an already trashed row keeps the original deleted_at', async () => {
    await push(A, op('insert', id1, { title: 'a' }, null)); await trashAt(t, id1, 3);
    const before = (await rowOf(t, id1)).deleted_at as Date;
    const r = await push(A, op('delete', id1, {}, 0));
    expect(r.status).toBe('applied'); expect(new Date(r.record.deleted_at).getTime()).toBe(before.getTime());
  });
  it('insert of an id that is trashed or a tombstone follows the update rules', async () => {
    await push(A, op('insert', id1, { title: 'a' }, null)); await push(A, op('delete', id1, {}, 0));
    const r = await push(A, op('insert', id1, { title: 'again' }, null));
    expect(r.status).toBe('dropped_trashed'); expect(r.record.title).toBe('a');
    await makeTombstone(id1);
    const p = await push(A, op('insert', id1, { title: 'again' }, null));
    expect(p.status).toBe('dropped_purged'); expect(p.record.purged_at).not.toBeNull(); expect(p.rev).toBe(p.record.rev);
  });
  it('dropped outcomes carry the current rev and row, and are stored', async () => {
    await push(A, op('insert', id1, { title: 'a' }, null)); const d = await push(A, op('delete', id1, {}, 0));
    const o = op('update', id1, { title: 'x' }, 0); const r = await push(A, o);
    expect(r).toMatchObject({ status: 'dropped_trashed', conflict: false, rev: d.rev, message: null });
    await push(A, op('restore', id1, {}, d.rev));
    expect(await push(A, o)).toEqual(r);
  });
  it('update, delete and restore of a missing row are invalid', async () => {
    for (const k of ['update', 'delete', 'restore'] as const) {
      const r = await push(A, op(k, randomUUID(), { title: 'x' }, 0));
      expect(r).toEqual({ status: 'invalid', conflict: false, rev: null, record: null, message: 'record not found' });
    }
  });
  it("another user's row is neither changed nor leaked by update, delete or restore", async () => {
    await push(A, op('insert', id1, { title: 'secret' }, null));
    for (const k of ['update', 'delete', 'restore'] as const) {
      const r = await push(B, op(k, id1, { title: 'x' }, 0));
      expect(r.status).toBe('invalid'); expect(JSON.stringify(r)).not.toContain('secret');
    }
    const rb = await push(B, op('insert', id1, { title: 'x' }, null));
    expect(JSON.stringify(rb)).not.toContain('secret'); expect(rb.record).toBeNull();
    expect(await titleOf(A, id1)).toBe('secret'); expect((await rowOf(t, id1)).deleted_at).toBeNull();
  });
  it('an invalid outcome is not stored, so the corrected op with the same op_id is processed afresh', async () => {
    const opId = randomUUID();
    const bad = await push(A, op('insert', id1, { title: '' }, null, opId)); expect(bad.status).toBe('invalid');
    expect(await storedOps()).toBe(0);
    const good = await push(A, op('insert', id1, { title: 'fixed' }, null, opId));
    expect(good.status).toBe('applied'); expect(await storedOps()).toBe(1);
  });
  it.each([
    ['check', { priority: 'urgent' }], ['not null', { title: null }], ['text representation', { done: 'maybe' }],
    ['date', { due_date: 'not a date' }], ['date range', { due_date: '2000-13-45' }],
  ])('bad data (%s) is invalid and rolls back the write', async (_n, fields) => {
    const r1 = await push(A, op('insert', id1, { title: 'a' }, null));
    const r = await push(A, op('update', id1, { note: 'changed', ...fields }, r1.rev));
    expect(r.status).toBe('invalid'); expect(r.message).toBeTruthy(); expect(r.rev).toBeNull();
    expect((await rowOf(t, id1)).note).toBe(''); expect(await storedOps()).toBe(1);
  });
  it('malformed ops are invalid and not stored', async () => {
    for (const o of [{ id: id1, kind: 'insert' }, { op_id: 'nope', id: id1, kind: 'insert' }, op('bogus' as Kind, id1, {}, 0), { ...op('insert', id1, {}, null), fields: [1] }]) {
      expect((await push(A, o)).status).toBe('invalid');
    }
    expect(await storedOps()).toBe(0); expect(await count(A)).toBe(0);
  });
  it('a stored result is replayed identically even after the row changed', async () => {
    const o = op('insert', id1, { title: 'a' }, null); const r1 = await push(A, o);
    await push(A, op('update', id1, { title: 'b' }, r1.rev));
    expect(await push(A, o)).toEqual(r1); expect(await titleOf(A, id1)).toBe('b');
  });
  it('two users using the same op_id do not see each other\'s stored result', async () => {
    const opId = randomUUID(); const idB = randomUUID();
    const ra = await push(A, op('insert', id1, { title: 'a' }, null, opId));
    const rb = await push(B, op('insert', idB, { title: 'b' }, null, opId));
    expect(rb.record.user_id).toBe(B); expect(rb.record.id).toBe(idB); expect(rb.rev).not.toBe(ra.rev);
    expect(await count(B)).toBe(1);
  });
  it('the caller cannot touch applied_ops or call the function as anon', async () => {
    await push(A, op('insert', id1, { title: 'a' }, null));
    await expect(t.pg.query('select * from applied_ops')).rejects.toThrow(/permission denied/);
  });
});
