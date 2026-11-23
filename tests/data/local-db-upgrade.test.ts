import { openDB, type IDBPDatabase } from 'idb';
import { seedVersion1 } from '../helpers/version1-db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openLocalDb, SCHEMA_VERSION, type LocalDb } from '../../src/data/local-db';
import { OWNER_SIGNED_IN, OWNER_USER_ID } from '../../src/data/owner';

// Every test uses its own database name so they never share state.
let n = 0;
const uniqueName = () => `upgrade-${++n}-${Math.random()}`;

const ID = '00000000-0000-4000-8000-0000000000d1';
const OWNER = '00000000-0000-4000-8000-0000000000a1';
const todo1 = {
  id: '00000000-0000-4000-8000-000000000101', user_id: OWNER, created_at: '2026-11-01T00:00:00.000Z',
  updated_at: '2026-11-02T00:00:00.000Z', rev: 812, deleted_at: null, purged_at: null,
  kind: 'todo', title: '买菜', done: false, priority: 'high', due_date: '2026-11-30', note: 'n',
  steps: [{ id: 's1', text: 'a', done: false }],
};
const op1 = {
  seq: 1, op_id: '00000000-0000-4000-8000-000000000201', table: 'todos', id: todo1.id, kind: 'update',
  base_rev: 812, fields: { title: '买菜' }, failed: null,
};
const op2 = { ...op1, seq: 2, op_id: '00000000-0000-4000-8000-000000000202', failed: { reason: 'title cannot be empty' } };

/** A stage 1 tab: version 1, no `blocking` handler, so it never closes its connection by itself. */
async function openVersion1WithoutHandlers(name: string): Promise<IDBPDatabase> {
  const db = await seedVersion1(name, { todos: [todo1], queue: [], meta: { db_id: ID, cursor: 5 } });
  return db;
}

async function bumpVersion(name: string, version: number): Promise<IDBPDatabase> {
  return openDB(name, version);
}

const opened: { close(): void }[] = [];
afterEach(() => {
  for (const d of opened.splice(0)) d.close();
});
const keep = <T extends { close(): void }>(d: T): T => {
  opened.push(d);
  return d;
};

describe('local db version 2', () => {
  it('SCHEMA_VERSION is 2', () => {
    expect(SCHEMA_VERSION).toBe(2);
  });

  it('upgrading a version 1 database keeps todos, the queue, db_id, export date and owner, and resets the cursor', async () => {
    const name = uniqueName();
    const v1 = await seedVersion1(name, {
      todos: [todo1],
      queue: [op1, op2],
      meta: { db_id: ID, cursor: 812, last_export_at: '2026-11-20T00:00:00.000Z', [OWNER_USER_ID]: OWNER, [OWNER_SIGNED_IN]: true },
    });
    v1.close();

    const db = keep(await openLocalDb(name));
    expect(db.raw.version).toBe(2);
    expect(await db.raw.getAll('todos')).toEqual([todo1]);
    expect(await db.raw.getAll('queue')).toEqual([op1, op2]);
    expect(db.raw.objectStoreNames.contains('events')).toBe(true);
    expect(await db.raw.getAll('events')).toEqual([]);
    expect(await db.getMeta('cursor')).toBe(0);
    expect(db.dbId).toBe(ID);
    expect(await db.getMeta('db_id')).toBe(ID);
    expect(await db.getMeta('last_export_at')).toBe('2026-11-20T00:00:00.000Z');
    expect(await db.getMeta(OWNER_USER_ID)).toBe(OWNER);
    expect(await db.getMeta(OWNER_SIGNED_IN)).toBe(true);
    // The queue's auto-increment keeps counting after the existing ops.
    expect(await db.raw.add('queue', { op_id: 'next' })).toBe(3);
  });

  it('a later open at version 2 does not reset the cursor again', async () => {
    const name = uniqueName();
    (await seedVersion1(name, { todos: [], queue: [], meta: { db_id: ID, cursor: 9 } })).close();
    const a = await openLocalDb(name);
    await a.setMeta('cursor', 40);
    a.close();
    const b = keep(await openLocalDb(name));
    expect(await b.getMeta('cursor')).toBe(40);
  });

  it('a fresh install creates every store at version 2', async () => {
    const db = keep(await openLocalDb(uniqueName()));
    expect(db.raw.version).toBe(2);
    expect([...db.raw.objectStoreNames].sort()).toEqual(['events', 'meta', 'queue', 'todos']);
    expect(await db.getMeta('cursor')).toBe(0);
    const tx = db.raw.transaction('events');
    expect(tx.objectStore('events').keyPath).toBe('id');
    await tx.done;
  });

  it('an open connection is told to close when a newer version opens, and it closes', async () => {
    const name = uniqueName();
    const onVersionChange = vi.fn();
    const old: LocalDb = await openLocalDb(name, { onVersionChange }); // stands in for the old tab
    const newer = keep(await bumpVersion(name, 3));
    expect(newer.version).toBe(3);
    expect(onVersionChange).toHaveBeenCalledTimes(1);
    // The connection is closed: it refuses new transactions.
    expect(() => old.raw.transaction('meta')).toThrow();
  });

  it('a stage 1 tab that never closes its connection makes the new version report blocked; it opens once that tab closes', async () => {
    const name = uniqueName();
    const old = await openVersion1WithoutHandlers(name);
    const onBlocked = vi.fn();
    const onVersionChange = vi.fn();
    const opening = openLocalDb(name, { onBlocked, onVersionChange });
    await vi.waitFor(() => expect(onBlocked).toHaveBeenCalledTimes(1));
    old.close();
    const db = keep(await opening);
    expect(db.raw.version).toBe(2);
    expect(db.dbId).toBe(ID);
    expect(await db.raw.getAll('todos')).toEqual([todo1]);
    expect(await db.getMeta('cursor')).toBe(0);
    expect(onVersionChange).not.toHaveBeenCalled();
  });
});
