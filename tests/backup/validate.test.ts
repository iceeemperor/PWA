import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openLocalDb, type LocalDb } from '../../src/data/local-db';
import { createRepo } from '../../src/data/repo';
import { buildBackup } from '../../src/backup/export-json';
import { MAX_VALIDATION_ERRORS, parseAndValidateBackup, validateBackup } from '../../src/backup/validate';

const ID = '22222222-2222-4222-8222-222222222222';
const todo = (over: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(),
  kind: 'todo',
  title: 'Buy milk',
  done: false,
  priority: 'normal',
  due_date: '2026-11-05',
  note: '',
  steps: [{ id: 's1', text: 'step', done: true }],
  created_at: '2026-11-05T10:00:00.000Z',
  updated_at: '2026-11-05T10:00:00.000Z',
  deleted_at: null,
  ...over,
});
const withTodos = (todos: unknown[]) => ({
  format: 'productivity-app-export',
  version: 1,
  exported_at: '2026-11-05T12:00:00.000Z',
  tables: { events: [], event_overrides: [], todos, notes: [], journal: [] },
});
const event = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: crypto.randomUUID(),
  title: 'Standup',
  all_day: true,
  starts_at: '2026-11-23',
  ends_at: null,
  tz: null,
  note: '',
  important: false,
  done: false,
  rrule: null,
  created_at: '2026-11-05T10:00:00.000Z',
  updated_at: '2026-11-05T10:00:00.000Z',
  deleted_at: null,
  ...over,
});
const timedEvent = (over: Record<string, unknown> = {}) => event({ all_day: false, starts_at: '2026-11-23T09:00', tz: 'Asia/Shanghai', ...over });
const withEvents = (events: unknown[]) => ({ ...withTodos([]), tables: { ...withTodos([]).tables, events } });
const withEvent = (over: Record<string, unknown>) => withEvents([event(over)]);
const valid = () => withTodos([todo()]);
const withTodo = (over: Record<string, unknown>) => withTodos([todo(over)]);
const errorsOf = (r: ReturnType<typeof validateBackup>) => (r.ok ? [] : r.errors);

describe('validateBackup', () => {
  it('accepts a valid file', () => expect(validateBackup(valid())).toMatchObject({ ok: true }));
  it('rejects a wrong format and an unsupported version', () => {
    expect(validateBackup({ ...valid(), format: 'x' })).toMatchObject({ ok: false });
    expect(validateBackup({ ...valid(), version: 2 })).toMatchObject({ ok: false, errors: [expect.stringContaining('version')] });
  });
  it('rejects ids that are not UUIDs, wrong field types, and missing required fields', () => {
    expect(validateBackup(withTodo({ id: '123' }))).toMatchObject({ ok: false });
    expect(validateBackup(withTodo({ done: 'yes' }))).toMatchObject({ ok: false });
    expect(validateBackup(withTodo({ title: '' }))).toMatchObject({ ok: false });
    expect(validateBackup(withTodo({ due_date: '2026/11/05' }))).toMatchObject({ ok: false });
    const { title: _t, ...noTitle } = todo();
    expect(validateBackup(withTodos([noTitle]))).toMatchObject({ ok: false });
  });
  it('names table, row index and field in errors, without row contents', () => {
    const r = validateBackup(withTodos([todo(), todo({ due_date: 'secret-value' })]));
    expect(errorsOf(r)[0]).toMatch(/^todos\[1\]\.due_date: /);
    expect(errorsOf(r).join()).not.toContain('secret-value');
  });
  it('rejects duplicate ids inside one file', () => {
    const t = todo();
    expect(validateBackup(withTodos([t, t]))).toMatchObject({ ok: false, errors: [expect.stringContaining('duplicate')] });
  });
  it('rejects tables that have rows but are not supported yet, and accepts empty ones', () => {
    expect(validateBackup({ ...valid(), tables: { ...valid().tables, event_overrides: [{}] } })).toMatchObject({ ok: false });
    expect(validateBackup({ ...valid(), tables: { ...valid().tables, notes: [{}] } })).toMatchObject({ ok: false });
    expect(validateBackup({ ...valid(), tables: { ...valid().tables, journal: [{}] } })).toMatchObject({ ok: false });
    expect(validateBackup(valid())).toMatchObject({ ok: true });
  });
  it('accepts a file with events, keeping them, and still rejects rows in event_overrides, notes and journal', () => {
    const r = validateBackup(withEvents([event(), timedEvent({ ends_at: '2026-11-23T10:00', deleted_at: '2026-11-06T10:00:00.000Z' })]));
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.backup.tables.events).toHaveLength(2);
    expect(validateBackup({ ...withEvents([event()]), tables: { ...withEvents([event()]).tables, event_overrides: [{}] } })).toMatchObject({ ok: false });
  });
  it('rejects an event with an end before its start, naming the row', () =>
    expect(validateBackup(withEvent({ starts_at: '2026-11-23', ends_at: '2026-11-22' }))).toMatchObject({ ok: false, errors: [expect.stringContaining('events[0]')] }));
  it('rejects an event row with an unknown or server-managed key, or a missing key', () => {
    for (const bad of [event({ extra: 1 }), event({ user_id: ID }), event({ rev: 1 }), event({ purged_at: null })]) {
      expect(validateBackup(withEvents([bad]))).toMatchObject({ ok: false, errors: [expect.stringMatching(/^events\[0\]: unknown field/)] });
    }
    for (const k of ['title', 'all_day', 'starts_at', 'ends_at', 'tz', 'note', 'important', 'done', 'rrule', 'id', 'created_at', 'updated_at', 'deleted_at']) {
      const { [k]: _gone, ...rest } = event();
      expect(validateBackup(withEvents([rest])), k).toMatchObject({ ok: false, errors: [expect.stringMatching(/^events\[0\]/)] });
    }
  });
  it('rejects bad common fields on an event', () => {
    expect(validateBackup(withEvent({ id: '123' }))).toMatchObject({ ok: false });
    expect(validateBackup(withEvent({ created_at: '1999-01-01T00:00:00Z' }))).toMatchObject({ ok: false });
    expect(validateBackup(withEvent({ updated_at: 'x' }))).toMatchObject({ ok: false });
    expect(validateBackup(withEvent({ deleted_at: 5 }))).toMatchObject({ ok: false });
  });
  it('rejects the client-only cases (impossible date, unknown zone, repeat rule) in a backup', () => {
    expect(validateBackup(withEvent({ starts_at: '2026-02-30' }))).toMatchObject({ ok: false });
    expect(validateBackup(withEvents([timedEvent({ tz: 'Mars/Base' })]))).toMatchObject({ ok: false });
    expect(validateBackup(withEvent({ rrule: 'FREQ=DAILY' }))).toMatchObject({ ok: false });
  });
  it('event errors name the row, never the value, and share the error cap and key-name cut', () => {
    const r = validateBackup(withEvents([event(), event({ title: 'secret-value', starts_at: 'secret-start' })]));
    expect(errorsOf(r)[0]).toMatch(/^events\[1\]: /);
    expect(errorsOf(r).join()).not.toContain('secret');
    const many = validateBackup(withEvents(Array.from({ length: 100 }, () => ({ ...event(), id: 'bad' }))));
    expect(errorsOf(many)).toHaveLength(MAX_VALIDATION_ERRORS);
    expect(errorsOf(validateBackup(withEvent({ ['k'.repeat(500)]: 1 }))).join().length).toBeLessThan(200);
  });
  it('rejects duplicate event ids inside one file', () => {
    const e = event();
    expect(validateBackup(withEvents([e, e]))).toMatchObject({ ok: false, errors: [expect.stringContaining('duplicate')] });
  });
  it('rejects text that is not JSON with a readable message', () =>
    expect(parseAndValidateBackup('<html>')).toMatchObject({ ok: false, errors: [expect.stringContaining('JSON')] }));
  it('parses and validates text', () => expect(parseAndValidateBackup(JSON.stringify(valid()))).toMatchObject({ ok: true }));
  it('rejects a non-object top level', () => {
    for (const x of [null, 5, 'a', [], undefined]) expect(validateBackup(x)).toMatchObject({ ok: false });
  });
  it('caps the error list at 20 for a file full of bad rows', () => {
    const r = validateBackup(withTodos(Array.from({ length: 100 }, () => ({ ...todo(), id: 'bad' }))));
    expect(r.ok).toBe(false);
    expect(errorsOf(r)).toHaveLength(MAX_VALIDATION_ERRORS);
  });
  it('one bad row rejects the whole file', () =>
    expect(validateBackup(withTodos([todo(), { ...todo(), priority: 'urgent' }]))).toMatchObject({ ok: false }));
  it('rejects unknown keys on a todo row, including server-managed ones', () => {
    expect(validateBackup(withTodo({ user_id: ID }))).toMatchObject({ ok: false });
    expect(validateBackup(withTodo({ rev: 3 }))).toMatchObject({ ok: false });
    expect(validateBackup(withTodo({ extra: 1 }))).toMatchObject({ ok: false });
  });
  it('rejects an impossible calendar date but accepts null', () => {
    expect(validateBackup(withTodo({ due_date: '2026-02-30' }))).toMatchObject({ ok: false });
    expect(validateBackup(withTodo({ due_date: null }))).toMatchObject({ ok: true });
  });
  it('rejects bad timestamps and unknown table keys', () => {
    expect(validateBackup(withTodo({ created_at: 'yesterday' }))).toMatchObject({ ok: false });
    expect(validateBackup({ ...valid(), exported_at: 'x' })).toMatchObject({ ok: false });
    expect(validateBackup({ ...valid(), tables: { ...valid().tables, widgets: [] } })).toMatchObject({ ok: false });
    expect(validateBackup({ ...valid(), tables: [] })).toMatchObject({ ok: false });
  });
  it('treats missing table keys as empty and returns them filled in', () => {
    const f = { ...valid(), tables: { todos: [todo()] } };
    const r = validateBackup(f);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.backup.tables.notes).toEqual([]);
    expect(validateBackup({ ...valid(), tables: { todos: {} } })).toMatchObject({ ok: false });
  });
});

describe('validateBackup round trip', () => {
  let db: LocalDb;
  beforeEach(async () => {
    db = await openLocalDb('validate-roundtrip');
  });
  afterEach(() => db.close());

  it('accepts what buildBackup produces', async () => {
    const repo = createRepo(db, { userId: () => ID, now: () => new Date('2026-11-05T10:00:00.000Z') });
    await repo.create('todos', {
      kind: 'goal',
      title: 'Everything',
      done: true,
      priority: 'high',
      due_date: '2026-12-31',
      note: 'n',
      steps: [{ id: 'a', text: 'x', done: false }],
    });
    const gone = await repo.create('todos', { title: 'trashed' });
    await repo.remove('todos', gone.id);
    const r = validateBackup(await buildBackup(db));
    expect(errorsOf(r)).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe('validateBackup: file-controlled key names in messages (F4, Task 12 minor 1)', () => {
  it('cuts unknown table and field names to 40 characters', () => {
    const long = 'k'.repeat(500);
    const file = { ...withTodo({ [long]: 1 }), tables: { ...withTodo({ [long]: 1 }).tables, [long]: [] } };
    const errors = errorsOf(validateBackup(file));
    expect(errors.length).toBeGreaterThanOrEqual(2);
    for (const e of errors) expect(e.length).toBeLessThan(120);
    expect(errors.some((e) => e.includes(`${'k'.repeat(40)}…`))).toBe(true);
  });
});
