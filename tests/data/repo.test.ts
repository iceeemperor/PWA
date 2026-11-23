import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openLocalDb, type LocalDb } from '../../src/data/local-db';
import {
  InvalidRecordError,
  LocalWriteError,
  PurgedRecordError,
  RecordNotFoundError,
  TrashedRecordError,
  createRepo,
  type Repo,
} from '../../src/data/repo';
import { validateTodoFields } from '../../src/data/validate-fields';
import { TABLE_DEFAULTS } from '../../src/domain/tables';
import type { QueuedOp, TodoRecord } from '../../src/domain/types';

const U = '11111111-1111-4111-8111-111111111111';
const T0 = Date.parse('2026-11-05T10:00:00.000Z');

// fake-indexeddb is global in this repo's test setup, so every test gets its own database.
let dbCount = 0;
let db: LocalDb;
let repo: Repo;
let clock: number;

beforeEach(async () => {
  db = await openLocalDb(`repo-test-${++dbCount}`);
  clock = T0;
  let n = 0;
  repo = createRepo(db, {
    userId: () => U,
    now: () => new Date(clock),
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

const ops = (): Promise<QueuedOp[]> => db.raw.getAll('queue');
const rawTodo = (id: string): Promise<TodoRecord> => db.raw.get('todos', id);

async function setRev(id: string, rev: number) {
  await db.raw.put('todos', { ...(await rawTodo(id)), rev });
}

// What a pulled tombstone looks like: content cleared, purged_at and deleted_at set.
async function makeTombstone(id: string) {
  const at = new Date(clock).toISOString();
  await db.raw.put('todos', {
    ...(await rawTodo(id)),
    title: '',
    note: '',
    steps: [],
    deleted_at: at,
    purged_at: at,
  });
}

async function markFailed(seq: number, reason: string) {
  await db.raw.put('queue', { ...(await db.raw.get('queue', seq)), failed: { reason } });
}

describe('repo', () => {
  it('create fills defaults and queues one insert op', async () => {
    const r = await repo.create('todos', { title: 'a' });
    expect(r).toMatchObject({ kind: 'todo', done: false, priority: 'normal', due_date: null, note: '', steps: [], rev: 0, user_id: U, deleted_at: null, purged_at: null });
    expect(r.created_at).toBe(r.updated_at);
    expect(await ops()).toMatchObject([{ kind: 'insert', id: r.id, base_rev: null, failed: null, fields: { title: 'a', created_at: r.created_at } }]);
  });

  it('create stores the record and queues every content field, with a table, a uuid op_id and a seq', async () => {
    const r = await repo.create('todos', { title: 'a', kind: 'goal', priority: 'high', due_date: '2026-11-30', note: 'n' });
    expect(await rawTodo(r.id)).toEqual(r);
    const [op] = await ops();
    expect(op).toEqual({
      seq: 1,
      op_id: '00000000-0000-4000-8000-000000000002',
      table: 'todos',
      id: r.id,
      kind: 'insert',
      base_rev: null,
      failed: null,
      fields: { kind: 'goal', title: 'a', done: false, priority: 'high', due_date: '2026-11-30', note: 'n', steps: [], created_at: r.created_at },
    });
  });

  it('create ignores undefined values and unknown keys instead of storing them', async () => {
    const r = await repo.create('todos', { title: 'a', priority: undefined, rev: 99, user_id: 'x' } as never);
    expect(r).toMatchObject({ priority: 'normal', rev: 0, user_id: U });
    expect((await ops())[0].fields).not.toHaveProperty('rev');
  });

  it('update changes the record and queues only the changed fields with the last seen rev', async () => {
    const r = await repo.create('todos', { title: 'a' });
    await setRev(r.id, 7);
    const u = await repo.update('todos', r.id, { done: true });
    expect(u.done).toBe(true);
    expect((await ops()).at(-1)).toMatchObject({ kind: 'update', base_rev: 7, fields: { done: true } });
  });

  it('update queues exactly the given fields, keeps rev and created_at, and bumps updated_at locally', async () => {
    const r = await repo.create('todos', { title: 'a', note: 'keep' });
    await setRev(r.id, 3);
    clock += 60_000;
    const u = await repo.update('todos', r.id, { title: 'b', due_date: '2026-12-01' });
    expect(u).toMatchObject({ title: 'b', due_date: '2026-12-01', note: 'keep', rev: 3, created_at: r.created_at, updated_at: new Date(clock).toISOString() });
    expect(await rawTodo(r.id)).toEqual(u);
    expect((await ops()).at(-1)?.fields).toEqual({ title: 'b', due_date: '2026-12-01' });
  });

  it('update with no changes writes and queues nothing', async () => {
    const r = await repo.create('todos', { title: 'a' });
    const fn = vi.fn();
    repo.onChange(fn);
    expect(await repo.update('todos', r.id, {})).toEqual(r);
    expect(await repo.update('todos', r.id, { done: undefined })).toEqual(r);
    expect(await ops()).toHaveLength(1);
    expect(fn).not.toHaveBeenCalled();
  });

  it('update on a trashed record throws TrashedRecordError', async () => {
    const r = await repo.create('todos', { title: 'a' });
    await repo.remove('todos', r.id);
    await expect(repo.update('todos', r.id, { done: true })).rejects.toBeInstanceOf(TrashedRecordError);
    expect(await ops()).toHaveLength(2);
  });

  it('update on a tombstone throws PurgedRecordError and on an unknown id RecordNotFoundError', async () => {
    const r = await repo.create('todos', { title: 'a' });
    await makeTombstone(r.id);
    await expect(repo.update('todos', r.id, { done: true })).rejects.toBeInstanceOf(PurgedRecordError);
    await expect(repo.update('todos', 'nope', { done: true })).rejects.toBeInstanceOf(RecordNotFoundError);
    expect(await ops()).toHaveLength(1);
  });

  it('update validates the changes it is given', async () => {
    const r = await repo.create('todos', { title: 'a' });
    await expect(repo.update('todos', r.id, { title: ' ' })).rejects.toBeInstanceOf(InvalidRecordError);
    await expect(repo.update('todos', r.id, { due_date: 'tomorrow' })).rejects.toBeInstanceOf(InvalidRecordError);
    expect((await rawTodo(r.id)).title).toBe('a');
    expect(await ops()).toHaveLength(1);
  });

  it('remove moves a record to trash and restore brings it back', async () => {
    const r = await repo.create('todos', { title: 'a' });
    await repo.remove('todos', r.id);
    expect(await repo.list('todos')).toHaveLength(0);
    expect(await repo.list('todos', { trashed: true })).toHaveLength(1);
    await repo.restore('todos', r.id);
    expect(await repo.list('todos')).toHaveLength(1);
    expect((await ops()).map((o) => o.kind)).toEqual(['insert', 'delete', 'restore']);
  });

  it('delete and restore ops carry no fields and the last seen rev', async () => {
    const r = await repo.create('todos', { title: 'a' });
    await setRev(r.id, 4);
    clock += 1000;
    await repo.remove('todos', r.id);
    expect(await rawTodo(r.id)).toMatchObject({ deleted_at: new Date(clock).toISOString(), updated_at: new Date(clock).toISOString(), rev: 4 });
    await repo.restore('todos', r.id);
    expect(await rawTodo(r.id)).toMatchObject({ deleted_at: null, rev: 4 });
    expect((await ops()).slice(1)).toMatchObject([
      { kind: 'delete', base_rev: 4, fields: {} },
      { kind: 'restore', base_rev: 4, fields: {} },
    ]);
  });

  it('get returns trashed records; list separates live and trashed ones', async () => {
    const live = await repo.create('todos', { title: 'live' });
    const gone = await repo.create('todos', { title: 'gone' });
    await repo.remove('todos', gone.id);
    expect(await repo.get('todos', gone.id)).toMatchObject({ id: gone.id, deleted_at: expect.any(String) });
    expect((await repo.list('todos')).map((r) => r.id)).toEqual([live.id]);
    expect((await repo.list('todos', { trashed: true })).map((r) => r.id)).toEqual([gone.id]);
    expect(await repo.get('todos', 'nope')).toBeUndefined();
  });

  it('removing a trashed record or restoring a live one is a no-op', async () => {
    const r = await repo.create('todos', { title: 'a' });
    const fn = vi.fn();
    repo.onChange(fn);
    await repo.restore('todos', r.id);
    expect(fn).not.toHaveBeenCalled();
    await repo.remove('todos', r.id);
    const trashedAt = (await rawTodo(r.id)).deleted_at;
    clock += 1000;
    await repo.remove('todos', r.id);
    expect((await rawTodo(r.id)).deleted_at).toBe(trashedAt);
    expect((await ops()).map((o) => o.kind)).toEqual(['insert', 'delete']);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('remove and restore reject unknown ids and tombstones', async () => {
    const r = await repo.create('todos', { title: 'a' });
    await makeTombstone(r.id);
    await expect(repo.remove('todos', r.id)).rejects.toBeInstanceOf(PurgedRecordError);
    await expect(repo.remove('todos', 'nope')).rejects.toBeInstanceOf(RecordNotFoundError);
    await expect(repo.restore('todos', 'nope')).rejects.toBeInstanceOf(RecordNotFoundError);
    expect(await ops()).toHaveLength(1);
  });

  it('tombstones are invisible and cannot be restored', async () => {
    const r = await repo.create('todos', { title: 'a' });
    await makeTombstone(r.id);
    expect(await repo.get('todos', r.id)).toBeUndefined();
    expect(await repo.list('todos')).toHaveLength(0);
    expect(await repo.list('todos', { trashed: true })).toHaveLength(0);
    await expect(repo.restore('todos', r.id)).rejects.toBeInstanceOf(PurgedRecordError);
  });

  it('pendingCount ignores failed ops and failedOps lists them', async () => {
    await repo.create('todos', { title: 'a' });
    await markFailed(1, 'bad');
    expect(await repo.pendingCount()).toBe(0);
    expect(await repo.failedOps()).toHaveLength(1);
  });

  it('pendingCount counts queued ops and failedOps returns the failed ones in seq order', async () => {
    const a = await repo.create('todos', { title: 'a' });
    await repo.update('todos', a.id, { done: true });
    await repo.remove('todos', a.id);
    expect(await repo.pendingCount()).toBe(3);
    expect(await repo.failedOps()).toEqual([]);
    await markFailed(3, 'late');
    await markFailed(1, 'early');
    expect(await repo.pendingCount()).toBe(1);
    expect((await repo.failedOps()).map((o) => [o.seq, o.failed])).toEqual([[1, { reason: 'early' }], [3, { reason: 'late' }]]);
  });

  it('retryFailed clears failed on every failed op, keeps seq order and fields, returns the count', async () => {
    const a = await repo.create('todos', { title: 'a' });
    await repo.update('todos', a.id, { done: true });
    await repo.remove('todos', a.id);
    const before = await ops();
    await markFailed(1, 'TypeError: Load failed');
    await markFailed(3, 'title cannot be empty');
    const fn = vi.fn();
    repo.onChange(fn);
    expect(await repo.retryFailed()).toBe(2);
    expect(await ops()).toEqual(before);
    expect(await repo.failedOps()).toEqual([]);
    expect(await repo.pendingCount()).toBe(3);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retryFailed with nothing failed returns 0 and tells nobody', async () => {
    await repo.create('todos', { title: 'a' });
    const fn = vi.fn();
    repo.onChange(fn);
    expect(await repo.retryFailed()).toBe(0);
    expect(fn).not.toHaveBeenCalled();
  });

  it('retryFailed({ onlyNetworkLike }) requeues only ops that failed on a network-looking reason', async () => {
    for (const title of ['a', 'b', 'c', 'd', 'e']) await repo.create('todos', { title });
    await markFailed(1, 'TypeError: Load failed');
    await markFailed(2, 'TypeError: Failed to fetch');
    await markFailed(3, 'TypeError: NetworkError when attempting to fetch resource.');
    await markFailed(4, 'title cannot be empty');
    await markFailed(5, 'invalid');
    expect(await repo.retryFailed({ onlyNetworkLike: true })).toBe(3);
    expect((await repo.failedOps()).map((o) => [o.seq, o.failed!.reason])).toEqual([
      [4, 'title cannot be empty'],
      [5, 'invalid'],
    ]);
  });

  it('onChange fires once per write and can be unsubscribed', async () => {
    const fn = vi.fn();
    const off = repo.onChange(fn);
    await repo.create('todos', { title: 'a' });
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    await repo.create('todos', { title: 'b' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('onChange fires after the data is readable, for every kind of write, and not for reads or failed writes', async () => {
    const reads: Promise<number>[] = [];
    repo.onChange(() => reads.push(repo.list('todos').then((l) => l.length)));
    const r = await repo.create('todos', { title: 'a' });
    await repo.update('todos', r.id, { done: true });
    await repo.remove('todos', r.id);
    await repo.restore('todos', r.id);
    await repo.list('todos');
    await repo.get('todos', r.id);
    await expect(repo.create('todos', { title: '' })).rejects.toBeInstanceOf(InvalidRecordError);
    await expect(repo.update('todos', 'nope', { done: true })).rejects.toBeInstanceOf(RecordNotFoundError);
    // One notification per write, each already seeing that write's result.
    expect(await Promise.all(reads)).toEqual([1, 1, 0, 1]);
  });

  it('a throwing listener neither fails the write nor silences the other listeners', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const after = vi.fn();
    repo.onChange(() => { throw new Error('boom'); });
    repo.onChange(after);
    await expect(repo.create('todos', { title: 'a' })).resolves.toMatchObject({ title: 'a' });
    expect(after).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(await repo.list('todos')).toHaveLength(1);
  });

  it('rejects text with a lone surrogate (it could never sync) and leaves nothing behind', async () => {
    const bad = 'a\uD800b';
    await expect(repo.create('todos', { title: bad })).rejects.toBeInstanceOf(InvalidRecordError);
    await expect(repo.create('todos', { title: 'a', note: bad })).rejects.toBeInstanceOf(InvalidRecordError);
    await expect(repo.create('todos', { title: 'a', steps: [{ id: 's', text: bad, done: false }] })).rejects.toBeInstanceOf(InvalidRecordError);
    const r = await repo.create('todos', { title: 'a' });
    await expect(repo.update('todos', r.id, { title: bad })).rejects.toBeInstanceOf(InvalidRecordError);
    expect(await repo.list('todos')).toHaveLength(1);
    expect(await ops()).toHaveLength(1);
  });

  it('rejects invalid fields', async () => {
    await expect(repo.create('todos', { title: '  ' })).rejects.toBeInstanceOf(InvalidRecordError);
    await expect(repo.create('todos', { title: 'a', due_date: '2026/11/05' })).rejects.toBeInstanceOf(InvalidRecordError);
    await expect(repo.create('todos', { title: 'a', priority: 'urgent' as any })).rejects.toBeInstanceOf(InvalidRecordError);
    await expect(repo.create('todos', {} as never)).rejects.toBeInstanceOf(InvalidRecordError);
    expect(await repo.list('todos')).toHaveLength(0);
    expect(await ops()).toHaveLength(0);
  });

  it('refuses every events write until events are available, and leaves nothing behind', async () => {
    const e = await repo.create('events', { title: '会', starts_at: '2026-11-23' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(InvalidRecordError);
    expect((e as Error).message).toBe('events are not available yet');
    await db.raw.put('events', { ...TABLE_DEFAULTS.events, id: 'e1', user_id: U, title: 'x', starts_at: '2026-11-23', created_at: 'c', updated_at: 'u', rev: 1, deleted_at: null, purged_at: null });
    await expect(repo.update('events', 'e1', { title: 'y' })).rejects.toBeInstanceOf(InvalidRecordError);
    expect(await db.raw.get('events', 'e1')).toMatchObject({ title: 'x' });
    expect(await ops()).toHaveLength(0);
  });

  it('create takes its defaults from TABLE_DEFAULTS without sharing them', async () => {
    const r = await repo.create('todos', { title: 'a' });
    expect(r).toMatchObject({ ...TABLE_DEFAULTS.todos, title: 'a' });
    expect(r.steps).not.toBe(TABLE_DEFAULTS.todos.steps);
    r.steps.push({ id: 's', text: 't', done: false });
    expect(TABLE_DEFAULTS.todos.steps).toEqual([]);
  });

  it('search has the agreed shape and returns nothing yet', async () => expect(await repo.search('x')).toEqual([]));

  it('a failed local write rejects with LocalWriteError and leaves nothing behind', async () => {
    const spy = vi.spyOn(db.raw, 'transaction').mockImplementation(() => {
      throw new DOMException('disk full', 'QuotaExceededError');
    });
    await expect(repo.create('todos', { title: 'a' })).rejects.toBeInstanceOf(LocalWriteError);
    spy.mockRestore();
    expect(await repo.list('todos')).toHaveLength(0);
    expect(await ops()).toHaveLength(0);
  });

  it('a write that fails half way through rolls the record write back too', async () => {
    // The queue's key generator is exhausted, so adding the op fails after the record was put.
    await db.raw.put('queue', { seq: 2 ** 53, op_id: 'x' });
    const fn = vi.fn();
    repo.onChange(fn);
    const err = await repo.create('todos', { title: 'a' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LocalWriteError);
    expect((err as LocalWriteError).cause).toBeDefined();
    expect(await db.raw.getAll('todos')).toEqual([]);
    expect(await ops()).toHaveLength(1);
    expect(fn).not.toHaveBeenCalled();
  });

  it('a failed update leaves the old record and the queue unchanged', async () => {
    const r = await repo.create('todos', { title: 'a' });
    await db.raw.put('queue', { seq: 2 ** 53, op_id: 'x' });
    await expect(repo.update('todos', r.id, { title: 'b' })).rejects.toBeInstanceOf(LocalWriteError);
    await expect(repo.remove('todos', r.id)).rejects.toBeInstanceOf(LocalWriteError);
    expect(await rawTodo(r.id)).toEqual(r);
    expect(await ops()).toHaveLength(2);
  });
});

describe('validateTodoFields', () => {
  it('accepts valid and partial fields', () => {
    expect(() => validateTodoFields({})).not.toThrow();
    expect(() => validateTodoFields({ title: 'x', kind: 'goal', priority: 'low', due_date: null })).not.toThrow();
    expect(() => validateTodoFields({ due_date: '2024-02-29' })).not.toThrow();
  });

  it.each([
    ['blank title', { title: ' \t\n' }],
    ['non-string title', { title: 5 }],
    ['unknown kind', { kind: 'event' }],
    ['unknown priority', { priority: 'urgent' }],
    ['slashed date', { due_date: '2026/11/05' }],
    ['unpadded date', { due_date: '2026-1-5' }],
    ['date with time', { due_date: '2026-11-05T00:00' }],
    ['impossible month', { due_date: '2026-13-01' }],
    ['impossible day', { due_date: '2026-02-30' }],
    ['leap day in a common year', { due_date: '2026-02-29' }],
    ['empty date', { due_date: '' }],
    ['non-string date', { due_date: 20261105 }],
  ])('rejects %s', (_name, fields) => {
    expect(() => validateTodoFields(fields as never)).toThrow(InvalidRecordError);
  });
});
