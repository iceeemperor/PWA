// F4: one set of field rules everywhere. The same values go through the Repo's validator, the backup validator and
// push_change (PGlite), and all three must agree on every one of them.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateBackup } from '../../src/backup/validate';
import { validateTodoFields } from '../../src/data/validate-fields';
import { createTestDb, TEST_USER_A as A, type TestDb } from './harness';

type Row = Record<string, unknown>;
type Case = [field: string, value: unknown, ok: boolean];

const NUL = '\u0000';
const LONE_HI = '\uD800';
const LONE_LO = '\uDC00';
const step = (over: Row = {}) => ({ id: 's1', text: 'a step', done: false, ...over });

const CASES: Case[] = [
  ['title', 'ok', true],
  ['title', '  padded  ', true],
  ['title', '', false],
  ['title', ' ', false],
  ['title', '\u3000', false],
  ['title', '\t\n', false],
  ['title', 5, false],
  ['title', null, false],
  ['title', `a${NUL}b`, false],
  ['title', `a${LONE_HI}b`, false],
  ['title', `a${LONE_LO}`, false],
  ['title', `${LONE_LO}${LONE_HI}`, false],
  ['title', 'emoji ' + String.fromCodePoint(0x1f600) + ' ok', true],
  ['done', true, true],
  ['done', false, true],
  ['done', 'yes', false],
  ['done', 1, false],
  ['done', null, false],
  ['kind', 'goal', true],
  ['kind', 'event', false],
  ['kind', 1, false],
  ['priority', 'high', true],
  ['priority', 'urgent', false],
  ['priority', true, false],
  ['note', '', true],
  ['note', 'some text', true],
  ['note', { x: 1 }, false],
  ['note', 5, false],
  ['note', `a${NUL}`, false],
  ['note', `a${LONE_HI}b`, false],
  ['note', 'pair ' + String.fromCodePoint(0x1f600), true],
  ['due_date', null, true],
  ['due_date', '2026-02-28', true],
  ['due_date', '2028-02-29', true],
  ['due_date', '0001-01-01', true],
  ['due_date', '9999-12-31', true],
  ['due_date', '2026-02-30', false],
  ['due_date', '0000-01-01', false],
  ['due_date', '10000-01-01', false],
  ['due_date', 'today', false],
  ['due_date', '2026-1-5', false],
  ['due_date', 20260101, false],
  ['steps', [], true],
  ['steps', [step(), step({ id: 's2', text: '', done: true })], true],
  ['steps', 'x', false],
  ['steps', {}, false],
  ['steps', { a: 1 }, false],
  ['steps', null, false],
  ['steps', ['x'], false],
  ['steps', [step({ id: '' })], false],
  ['steps', [step({ id: 5 })], false],
  ['steps', [step({ text: 5 })], false],
  ['steps', [step({ done: 'no' })], false],
  ['steps', [step({ extra: 1 })], false],
  ['steps', [{ id: 's1', text: 'a' }], false],
  ['steps', [step({ text: `a${NUL}` })], false],
  ['steps', [step({ text: `a${LONE_HI}b` })], false],
  ['steps', [step({ id: `s${LONE_LO}` })], false],
  ['created_at', '2026-11-06T10:00:00.000Z', true],
  ['created_at', '2026-11-06T10:00:00.123456+00:00', true],
  ['created_at', '2000-01-01T00:00:00Z', true],
  ['created_at', '9999-12-31T23:59:59Z', true],
  ['created_at', 'infinity', false],
  ['created_at', '-infinity', false],
  ['created_at', 'now', false],
  ['created_at', '1999-12-31T23:59:59Z', false],
  ['created_at', '2000-01-01T00:30:00+01:00', false],
  ['created_at', '10000-01-01T00:00:00Z', false],
  ['created_at', '2026-11-06', false],
  ['created_at', '2026-02-30T00:00:00Z', false],
  ['created_at', 5, false],
  ['created_at', null, false],
];

const label = (c: Case) => `${c[0]} = ${JSON.stringify(c[1])} → ${c[2] ? 'ok' : 'refused'}`;

const goodTodo = (): Row => ({
  id: randomUUID(),
  kind: 'todo',
  title: 'good',
  done: false,
  priority: 'normal',
  due_date: null,
  note: '',
  steps: [],
  created_at: '2026-11-05T10:00:00.000Z',
  updated_at: '2026-11-05T10:00:00.000Z',
  deleted_at: null,
});
const backupWith = (row: Row) => ({
  format: 'productivity-app-export',
  version: 1,
  exported_at: '2026-11-05T12:00:00.000Z',
  tables: { todos: [row] },
});

function repoAccepts(field: string, value: unknown): boolean {
  try {
    validateTodoFields({ [field]: value } as never);
    return true;
  } catch {
    return false;
  }
}

let t: TestDb;
beforeAll(async () => { t = await createTestDb(); });
afterAll(async () => { await t.pg.close(); });

/** Inserts a todo through push_change with the field set. A request the database cannot even parse counts as refused. */
async function pushAccepts(field: string, value: unknown): Promise<boolean> {
  await t.asUser(A);
  const op = { op_id: randomUUID(), id: randomUUID(), kind: 'insert', base_rev: null, fields: { title: 'good', [field]: value } };
  try {
    const r = (await t.pg.query<{ r: Row }>('select push_change($1, $2::jsonb) as r', ['todos', JSON.stringify(op)])).rows[0].r;
    return r.status === 'applied';
  } catch {
    return false;
  }
}

/** The same field through an update of a live row (types are checked on updates too). */
async function updateAccepts(field: string, value: unknown): Promise<boolean> {
  await t.asUser(A);
  const id = randomUUID();
  const ins = { op_id: randomUUID(), id, kind: 'insert', base_rev: null, fields: { title: 'good' } };
  const first = (await t.pg.query<{ r: Row }>('select push_change($1, $2::jsonb) as r', ['todos', JSON.stringify(ins)])).rows[0].r;
  const upd = { op_id: randomUUID(), id, kind: 'update', base_rev: first.rev, fields: { [field]: value } };
  try {
    const r = (await t.pg.query<{ r: Row }>('select push_change($1, $2::jsonb) as r', ['todos', JSON.stringify(upd)])).rows[0].r;
    return r.status === 'applied';
  } catch {
    return false;
  }
}

describe('field rules agree: Repo validator, backup validator, push_change (F4)', () => {
  it.each(CASES.map((c) => [label(c), c] as const))('%s', async (_n, [field, value, ok]) => {
    expect(repoAccepts(field, value), 'validate-fields').toBe(ok);
    expect(validateBackup(backupWith({ ...goodTodo(), [field]: value })).ok, 'validateBackup').toBe(ok);
    expect(await pushAccepts(field, value), 'push_change insert').toBe(ok);
    // created_at is set once on insert; an update ignores it whatever it holds.
    if (field !== 'created_at') expect(await updateAccepts(field, value), 'push_change update').toBe(ok);
  });
});

describe('push_change ignores what it does not write (F4, Task 5 minor)', () => {
  it('garbage in server-managed and unknown keys does not make an op invalid', async () => {
    const id = randomUUID();
    await t.asUser(A);
    const op = {
      op_id: randomUUID(), id, kind: 'insert', base_rev: null,
      fields: { title: 'kept', rev: 'abc', user_id: 'not-a-uuid', purged_at: 'nope', updated_at: 'zzz', deleted_at: 7, id: 5, bogus: { x: 1 } },
    };
    const r = (await t.pg.query<{ r: Row }>('select push_change($1, $2::jsonb) as r', ['todos', JSON.stringify(op)])).rows[0].r;
    expect(r).toMatchObject({ status: 'applied' });
    expect(r.record).toMatchObject({ id, title: 'kept', user_id: A, purged_at: null, deleted_at: null });
    const upd = { op_id: randomUUID(), id, kind: 'update', base_rev: r.rev, fields: { done: true, created_at: 'garbage', rev: [] } };
    const u = (await t.pg.query<{ r: Row }>('select push_change($1, $2::jsonb) as r', ['todos', JSON.stringify(upd)])).rows[0].r;
    expect(u).toMatchObject({ status: 'applied', record: { done: true } });
  });
});

describe('table CHECKs back the rules up for any other write path (F4)', () => {
  const insertRaw = async (over: string) => {
    await t.asRole('postgres');
    return t.pg.query(`insert into todos (id, user_id, title${over ? ', ' + over.split('=')[0] : ''}) values ($1, $2, 'good'${over ? ', ' + over.split('=').slice(1).join('=') : ''})`, [randomUUID(), A]);
  };
  it.each([
    ["steps='\"x\"'::jsonb"],
    ["steps='{}'::jsonb"],
    ["due_date='10000-01-01'"],
    ["created_at='infinity'"],
    ["created_at='1999-12-31T23:59:59Z'"],
    ["created_at='10000-01-01T00:00:00Z'"],
  ])('%s is refused', async (over) => {
    await expect(insertRaw(over)).rejects.toThrow(/check constraint/);
  });
  it('a blank title is refused on a live row, allowed on a tombstone', async () => {
    await t.asRole('postgres');
    await expect(t.pg.query(`insert into todos (id, user_id, title) values ($1, $2, ' ')`, [randomUUID(), A])).rejects.toThrow(/check constraint/);
    await expect(t.pg.query(`insert into todos (id, user_id, title) values ($1, $2, E'\\u3000')`, [randomUUID(), A])).rejects.toThrow(/check constraint/);
    await expect(t.pg.query(`insert into todos (id, user_id, title, purged_at) values ($1, $2, ' ', now())`, [randomUUID(), A])).resolves.toBeDefined();
  });
  it('good values pass', async () => {
    await expect(insertRaw("due_date='9999-12-31'")).resolves.toBeDefined();
    await expect(insertRaw("created_at='2000-01-01T00:00:00Z'")).resolves.toBeDefined();
  });
});

describe('push_fields_problem is internal (F4)', () => {
  it('neither anon nor authenticated may execute it', async () => {
    await t.asRole('postgres');
    for (const role of ['anon', 'authenticated']) {
      const r = await t.pg.query<{ ok: boolean }>(
        `select has_function_privilege($1, 'public.push_fields_problem(text, jsonb, text[])', 'execute') as ok`, [role]);
      expect(r.rows[0].ok, role).toBe(false);
    }
  });
});
