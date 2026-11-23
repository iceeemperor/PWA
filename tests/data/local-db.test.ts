import { afterEach, describe, expect, it, vi } from 'vitest';
import { isUuid } from '../../src/domain/ids';
import { LocalDbUnavailableError, openLocalDb } from '../../src/data/local-db';

// Every test uses its own database name so they never share state.
describe('local db', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('creates a store per table plus queue and meta, a db_id and cursor 0', async () => {
    const db = await openLocalDb('t1');
    expect([...db.raw.objectStoreNames].sort()).toEqual(['events', 'meta', 'queue', 'todos']);
    expect(isUuid(db.dbId)).toBe(true);
    expect(await db.getMeta('cursor')).toBe(0);
    db.close();
  });

  it('keys todos by id and queue by an auto-increment seq', async () => {
    const db = await openLocalDb('t4');
    const tx = db.raw.transaction(['todos', 'queue'], 'readwrite');
    expect(tx.objectStore('todos').keyPath).toBe('id');
    expect(tx.objectStore('queue').keyPath).toBe('seq');
    const first = await tx.objectStore('queue').add({ op_id: 'a' });
    const second = await tx.objectStore('queue').add({ op_id: 'b' });
    await tx.done;
    expect(second).toBe((first as number) + 1);
    expect(await db.raw.get('queue', first)).toEqual({ op_id: 'a', seq: first });
    db.close();
  });

  it('keeps db_id and meta values after reopening', async () => {
    const a = await openLocalDb('t2');
    await a.setMeta('last_export_at', 'x');
    const id = a.dbId;
    a.close();
    const b = await openLocalDb('t2');
    expect(b.dbId).toBe(id);
    expect(await b.getMeta('last_export_at')).toBe('x');
    b.close();
  });

  it('treats a missing db_id as a fresh install and resets the cursor', async () => {
    const a = await openLocalDb('t5');
    await a.setMeta('cursor', 7);
    await a.raw.delete('meta', 'db_id');
    const oldId = a.dbId;
    a.close();
    const b = await openLocalDb('t5');
    expect(isUuid(b.dbId)).toBe(true);
    expect(b.dbId).not.toBe(oldId);
    expect(await b.getMeta('db_id')).toBe(b.dbId);
    expect(await b.getMeta('cursor')).toBe(0);
    b.close();
  });

  it('throws LocalDbUnavailableError when indexedDB is missing', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await expect(openLocalDb('t3')).rejects.toBeInstanceOf(LocalDbUnavailableError);
  });

  it('wraps a failing open in LocalDbUnavailableError with the cause', async () => {
    const denied = new Error('denied');
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw denied;
      },
    });
    const error = await openLocalDb('t6').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LocalDbUnavailableError);
    expect((error as LocalDbUnavailableError).cause).toBe(denied);
  });
});
