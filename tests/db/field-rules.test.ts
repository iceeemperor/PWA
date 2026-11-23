// F4: one set of field rules everywhere. The same values go through the Repo's validator, the backup validator and
// push_change (PGlite), and all three must agree on every one of them.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateBackup } from '../../src/backup/validate';
import { validateEventFields } from '../../src/data/validate-event-fields';
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

// Events (stage 2): whole records, one rule broken (or kept) per case against a valid all-day event. The Repo and the
// backup validator share validateEventFields, so the client column is that function; the backup column is added with
// the backup validator itself (stage 2 Task 4).
type EventCase = [name: string, over: Row, ok: boolean];
const TIMED: Row = { all_day: false, starts_at: '2026-11-23T09:00', tz: 'Asia/Shanghai' };
const EVENT_CASES: EventCase[] = [
  ['an all-day event', {}, true],
  ['an all-day event with an end', { ends_at: '2026-11-25' }, true],
  ['an all-day event ending the same day', { ends_at: '2026-11-23' }, true],
  ['a timed event', TIMED, true],
  ['a timed event with an end', { ...TIMED, ends_at: '2026-11-24T08:00' }, true],
  ['a timed event ending at its start', { ...TIMED, ends_at: '2026-11-23T09:00' }, true],
  ['a timed event in UTC', { ...TIMED, tz: 'UTC' }, true],
  ['a zone with a +', { ...TIMED, tz: 'Etc/GMT+5' }, true],
  ['a three-part zone with an underscore', { ...TIMED, tz: 'America/Argentina/Buenos_Aires' }, true],
  ['a leap day', { starts_at: '2028-02-29' }, true],
  ['note, important and done set', { note: 'n', important: true, done: true }, true],
  ['a padded title', { title: '  padded  ' }, true],
  ['blank title', { title: ' ' }, false],
  ['a full-width blank title', { title: '　' }, false],
  ['a tab and newline title', { title: '\t\n' }, false],
  ['a BOM title', { title: '﻿' }, false],
  ['a non-string title', { title: 5 }, false],
  ['a null title', { title: null }, false],
  ['a NUL in the title', { title: `a${NUL}b` }, false],
  ['a lone surrogate in the title', { title: `a${LONE_HI}b` }, false],
  ['a null note', { note: null }, false],
  ['a non-string note', { note: 5 }, false],
  ['a lone surrogate in the note', { note: `a${LONE_LO}` }, false],
  ['a non-boolean all_day', { all_day: 'yes' }, false],
  ['a null all_day', { all_day: null }, false],
  ['a non-boolean important', { important: 1 }, false],
  ['a null done', { done: null }, false],
  ['all-day with a time', { starts_at: '2026-11-23T09:00' }, false],
  ['all-day with a tz', { tz: 'Asia/Shanghai' }, false],
  ['timed without tz', { ...TIMED, tz: null }, false],
  ['timed with seconds or offset', { ...TIMED, starts_at: '2026-11-23T09:00:00+08:00' }, false],
  ['end before start', { ends_at: '2026-11-22' }, false],
  ['end in the other form', { ends_at: '2026-11-23T10:00' }, false],
  ['a timed end before start', { ...TIMED, ends_at: '2026-11-23T08:59' }, false],
  ['a timed end in the all-day form', { ...TIMED, ends_at: '2026-11-24' }, false],
  ['hour 24', { ...TIMED, starts_at: '2026-11-23T24:00' }, false],
  ['minute 60', { ...TIMED, starts_at: '2026-11-23T09:60' }, false],
  ['a timed start without a time', { ...TIMED, starts_at: '2026-11-23' }, false],
  ['an empty start', { starts_at: '' }, false],
  ['a null start', { starts_at: null }, false],
  ['a non-string start', { starts_at: 20261123 }, false],
  ['an unpadded date', { starts_at: '2026-1-5' }, false],
  ['a five-digit year', { starts_at: '10000-01-01' }, false],
  ['a trailing newline in the date', { starts_at: '2026-11-23\n' }, false],
  ['a tz with a space', { ...TIMED, tz: 'Asia/ Shanghai' }, false],
  ['a tz starting with a slash', { ...TIMED, tz: '/Asia' }, false],
  ['an empty tz', { ...TIMED, tz: '' }, false],
  ['an offset as the tz', { ...TIMED, tz: '+08:00' }, false],
  ['a non-string tz', { ...TIMED, tz: 5 }, false],
  ['rrule set', { rrule: 'FREQ=DAILY' }, false],
];
// The only allowed disagreements: values whose shape the server's CHECKs accept but that the client refuses, because
// a CHECK cannot consult a calendar or the time-zone database. The client is the stricter side, never the looser one.
const CLIENT_ONLY_REFUSALS: [name: string, over: Row][] = [
  // Not a day on the calendar: the server checks only the \d{4}-\d{2}-\d{2} shape of these text columns.
  ['an impossible all-day date', { starts_at: '2026-02-30' }],
  ['an impossible end date', { ends_at: '2026-11-31' }],
  ['year 0000', { starts_at: '0000-01-01' }],
  ['an impossible date in a timed start', { ...TIMED, starts_at: '2026-02-30T09:00' }],
  ['an impossible month in a timed end', { ...TIMED, ends_at: '2026-13-01T09:00' }],
  // Shaped like a zone name, but no such zone: the server checks only the name's form.
  ['a zone that does not exist', { ...TIMED, tz: 'Mars/Base' }],
];

const goodEvent = (over: Row): Row => ({
  title: '会', all_day: true, starts_at: '2026-11-23', ends_at: null, tz: null, note: '', important: false, done: false, rrule: null,
  ...over,
});

function eventClientAccepts(over: Row): boolean {
  try {
    validateEventFields(goodEvent(over) as never);
    return true;
  } catch {
    return false;
  }
}

/** Inserts the whole event through push_change. A request the database cannot even parse counts as refused. */
async function eventPushAccepts(over: Row): Promise<boolean> {
  await t.asUser(A);
  const op = { op_id: randomUUID(), id: randomUUID(), kind: 'insert', base_rev: null, fields: goodEvent(over) };
  try {
    const r = (await t.pg.query<{ r: Row }>('select push_change($1, $2::jsonb) as r', ['events', JSON.stringify(op)])).rows[0].r;
    return r.status === 'applied';
  } catch {
    return false;
  }
}

/** The same record as an update of a live all-day event (the CHECKs see the merged row). */
async function eventUpdateAccepts(over: Row): Promise<boolean> {
  await t.asUser(A);
  const id = randomUUID();
  const ins = { op_id: randomUUID(), id, kind: 'insert', base_rev: null, fields: goodEvent({}) };
  const first = (await t.pg.query<{ r: Row }>('select push_change($1, $2::jsonb) as r', ['events', JSON.stringify(ins)])).rows[0].r;
  const upd = { op_id: randomUUID(), id, kind: 'update', base_rev: first.rev, fields: goodEvent(over) };
  try {
    const r = (await t.pg.query<{ r: Row }>('select push_change($1, $2::jsonb) as r', ['events', JSON.stringify(upd)])).rows[0].r;
    return r.status === 'applied';
  } catch {
    return false;
  }
}

describe('event field rules agree: validateEventFields and push_change (stage 2)', () => {
  it.each(EVENT_CASES.map((c) => [`${c[0]} → ${c[2] ? 'ok' : 'refused'}`, c] as const))('%s', async (_n, [, over, ok]) => {
    expect(eventClientAccepts(over), 'validateEventFields').toBe(ok);
    expect(await eventPushAccepts(over), 'push_change insert').toBe(ok);
    expect(await eventUpdateAccepts(over), 'push_change update').toBe(ok);
  });

  it.each(CLIENT_ONLY_REFUSALS)('expected exception: %s is refused by the client, accepted by the server', async (_n, over) => {
    expect(eventClientAccepts(over), 'validateEventFields').toBe(false);
    expect(await eventPushAccepts(over), 'push_change insert').toBe(true);
    expect(await eventUpdateAccepts(over), 'push_change update').toBe(true);
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
