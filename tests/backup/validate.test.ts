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
    expect(validateBackup({ ...valid(), tables: { ...valid().tables, events: [{}] } })).toMatchObject({ ok: false });
    expect(validateBackup(valid())).toMatchObject({ ok: true });
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
