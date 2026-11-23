import type { IDBPTransaction } from 'idb';
import { newId as defaultNewId } from '../domain/ids';
import { isNetworkLikeMessage } from '../domain/network-errors';
import { contentKeys, defaultsOf } from '../domain/tables';
import type {
  CommonFields,
  FieldsOf,
  NewFields,
  OpKind,
  QueuedOp,
  RecordOf,
  TableName,
  TodoFields,
} from '../domain/types';
import type { LocalDb } from './local-db';
import { InvalidRecordError, validateTodoFields } from './validate-fields';

export { InvalidRecordError };

/** The record is in the trash, and trashed records cannot be edited (restore it first). */
export class TrashedRecordError extends Error {
  constructor(message = 'The record is in the trash') {
    super(message);
    this.name = 'TrashedRecordError';
  }
}

/** The record was purged: only a tombstone is left, and it cannot be edited, deleted or restored. */
export class PurgedRecordError extends Error {
  constructor(message = 'The record was purged') {
    super(message);
    this.name = 'PurgedRecordError';
  }
}

/** There is no record with this id in the local database. */
export class RecordNotFoundError extends Error {
  constructor(message = 'No such record') {
    super(message);
    this.name = 'RecordNotFoundError';
  }
}

/** The local storage refused the write (for example, no space left). Nothing was saved or queued. */
export class LocalWriteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LocalWriteError';
  }
}

export interface RepoDeps {
  userId: () => string;
  now?: () => Date;
  newId?: () => string;
}

export interface SearchHit {
  table: TableName;
  id: string;
  snippet: string;
}

export interface SearchOptions {
  limit?: number;
}

export interface Repo {
  create<T extends TableName>(t: T, f: NewFields<T>): Promise<RecordOf<T>>;
  /** Edits the given fields. A trashed record or a tombstone cannot be edited. */
  update<T extends TableName>(t: T, id: string, changes: Partial<FieldsOf<T>>): Promise<RecordOf<T>>;
  /** Moves the record to the trash. Already trashed: nothing happens. */
  remove(t: TableName, id: string): Promise<void>;
  /** Takes the record out of the trash. Not trashed: nothing happens. A tombstone cannot be restored. */
  restore(t: TableName, id: string): Promise<void>;
  /** The record, trashed or not; a tombstone counts as missing. */
  get<T extends TableName>(t: T, id: string): Promise<RecordOf<T> | undefined>;
  /** Live records, or with `trashed: true` the trashed ones. Tombstones are never listed. No particular order. */
  list<T extends TableName>(t: T, o?: { trashed?: boolean }): Promise<RecordOf<T>[]>;
  /** Queued ops still waiting to be uploaded (failed ones excluded). */
  pendingCount(): Promise<number>;
  failedOps(): Promise<QueuedOp[]>;
  /**
   * Puts failed ops back in the queue (clears `failed`), in one transaction; seq order and every other field stay.
   * With `onlyNetworkLike`, only ops whose failure reason reads like a lost connection. Returns how many.
   * Retrying an op the server really refused is harmless: the next sync marks it failed again.
   */
  retryFailed(o?: { onlyNetworkLike?: boolean }): Promise<number>;
  /** Called after every successful write. Returns the unsubscribe function. */
  onChange(fn: () => void): () => void;
  search(q: string, o?: SearchOptions): Promise<SearchHit[]>;
}

const QUEUE = 'queue';

// Per-table rules. Content fields (the keys of TABLE_DEFAULTS) are the ones the client may write; everything
// else on a record (`CommonFields`) is set by the repo or by the server. A later table adds its own entry here.
interface TableSpec {
  defaults(): Record<string, unknown>;
  validate(fields: Record<string, unknown>): void;
}

const SPECS: Record<TableName, TableSpec> = {
  todos: {
    defaults: () => defaultsOf('todos') as unknown as Record<string, unknown>,
    validate: (f) => validateTodoFields(f as Partial<TodoFields>),
  },
  // Placeholder until the event field rules arrive (stage 2 Task 3): no event can be written yet.
  events: {
    defaults: () => defaultsOf('events') as unknown as Record<string, unknown>,
    validate: () => {
      throw new InvalidRecordError('events are not available yet');
    },
  },
};

/** Only the table's content fields, and only the ones that are set. */
function contentOf(t: TableName, input: object): Record<string, unknown> {
  const given = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of contentKeys(t)) {
    if (given[key] !== undefined) out[key] = given[key];
  }
  return out;
}

type StoredRecord = CommonFields & Record<string, unknown>;

// The one place where the table-agnostic stored shape becomes the caller's table-specific type.
// Every record in a table's store was written by this repo (or the sync engine) in that table's shape.
const typed = <T extends TableName>(r: StoredRecord): RecordOf<T> => r as unknown as RecordOf<T>;

type WriteTx = IDBPTransaction<unknown, string[], 'readwrite'>;

// Thrown from inside a write when the record's state forbids it. Not storage failures, so `write` passes them through.
const STATE_ERRORS = [TrashedRecordError, PurgedRecordError, RecordNotFoundError];

export function createRepo(db: LocalDb, deps: RepoDeps): Repo {
  const now = deps.now ?? (() => new Date());
  const makeId = deps.newId ?? defaultNewId;
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const fn of [...listeners]) {
      // The write already succeeded; a broken listener must not turn it into a failure.
      try {
        fn();
      } catch (e) {
        console.error('Repo onChange listener failed', e);
      }
    }
  }

  /**
   * Runs `body` in one transaction over the table and the queue, so a record write
   * and its queue entry are saved together or not at all. `changed: false` marks a
   * no-op: nothing was written, so listeners are not told.
   */
  async function write<R>(t: TableName, body: (tx: WriteTx) => Promise<{ result: R; changed: boolean }>): Promise<R> {
    let tx: WriteTx;
    try {
      tx = db.raw.transaction([t, QUEUE], 'readwrite');
    } catch (cause) {
      throw new LocalWriteError('Could not save to local storage', { cause });
    }
    // Failures are reported through the awaits below; this keeps the same rejection from also being "unhandled".
    tx.done.catch(() => {});

    let out: { result: R; changed: boolean };
    try {
      out = await body(tx);
      await tx.done;
    } catch (e) {
      try {
        tx.abort();
      } catch {
        // already finished or aborted
      }
      await tx.done.catch(() => {});
      if (STATE_ERRORS.some((C) => e instanceof C)) throw e;
      throw new LocalWriteError('Could not save to local storage', { cause: e });
    }
    if (out.changed) notify();
    return out.result;
  }

  /** The stored record behind an edit, or the error that says why it cannot be edited. */
  async function load(tx: WriteTx, t: TableName, id: string): Promise<StoredRecord> {
    const current: StoredRecord | undefined = await tx.objectStore(t).get(id);
    if (!current) throw new RecordNotFoundError(`No ${t} record with id ${id}`);
    if (current.purged_at !== null) throw new PurgedRecordError(`The ${t} record ${id} was purged`);
    return current;
  }

  function enqueue(tx: WriteTx, t: TableName, id: string, kind: OpKind, base_rev: number | null, fields: Record<string, unknown>) {
    const op: Omit<QueuedOp, 'seq'> = { op_id: makeId(), table: t, id, kind, base_rev, fields, failed: null };
    return tx.objectStore(QUEUE).add(op);
  }

  async function setTrashed(t: TableName, id: string, trashed: boolean): Promise<void> {
    return write(t, async (tx) => {
      const current = await load(tx, t, id);
      // Already in the wanted state; the server keeps the original `deleted_at` in that case too.
      if ((current.deleted_at !== null) === trashed) return { result: undefined, changed: false };
      const ts = now().toISOString();
      await tx.objectStore(t).put({ ...current, deleted_at: trashed ? ts : null, updated_at: ts });
      await enqueue(tx, t, id, trashed ? 'delete' : 'restore', current.rev, {});
      return { result: undefined, changed: true };
    });
  }

  return {
    async create<T extends TableName>(t: T, f: NewFields<T>): Promise<RecordOf<T>> {
      const content = { ...SPECS[t].defaults(), ...contentOf(t, f) };
      SPECS[t].validate(content);
      const id = makeId();
      const ts = now().toISOString();
      const record: StoredRecord = {
        ...content,
        id,
        user_id: deps.userId(),
        created_at: ts,
        updated_at: ts,
        rev: 0,
        deleted_at: null,
        purged_at: null,
      };
      return write(t, async (tx) => {
        await tx.objectStore(t).add(record);
        await enqueue(tx, t, id, 'insert', null, { ...content, created_at: ts });
        return { result: typed<T>(record), changed: true };
      });
    },

    async update<T extends TableName>(t: T, id: string, changes: Partial<FieldsOf<T>>): Promise<RecordOf<T>> {
      const patch = contentOf(t, changes);
      SPECS[t].validate(patch);
      return write(t, async (tx) => {
        const current = await load(tx, t, id);
        if (current.deleted_at !== null) throw new TrashedRecordError(`The ${t} record ${id} is in the trash`);
        if (Object.keys(patch).length === 0) return { result: typed<T>(current), changed: false };
        // `rev` stays: it is the server's, and the op's base_rev tells the server which version this edit saw.
        const next: StoredRecord = { ...current, ...patch, updated_at: now().toISOString() };
        await tx.objectStore(t).put(next);
        await enqueue(tx, t, id, 'update', current.rev, patch);
        return { result: typed<T>(next), changed: true };
      });
    },

    remove: (t, id) => setTrashed(t, id, true),
    restore: (t, id) => setTrashed(t, id, false),

    async get<T extends TableName>(t: T, id: string): Promise<RecordOf<T> | undefined> {
      const record: StoredRecord | undefined = await db.raw.get(t, id);
      return record && record.purged_at === null ? typed<T>(record) : undefined;
    },

    async list<T extends TableName>(t: T, o?: { trashed?: boolean }): Promise<RecordOf<T>[]> {
      const trashed = o?.trashed === true;
      const records: StoredRecord[] = await db.raw.getAll(t);
      return records.filter((r) => r.purged_at === null && (r.deleted_at !== null) === trashed).map((r) => typed<T>(r));
    },

    async pendingCount(): Promise<number> {
      const queued: QueuedOp[] = await db.raw.getAll(QUEUE);
      return queued.filter((op) => op.failed === null).length;
    },

    async failedOps(): Promise<QueuedOp[]> {
      const queued: QueuedOp[] = await db.raw.getAll(QUEUE);
      return queued.filter((op) => op.failed !== null);
    },

    async retryFailed(o?: { onlyNetworkLike?: boolean }): Promise<number> {
      const tx = db.raw.transaction(QUEUE, 'readwrite');
      tx.done.catch(() => {});
      let count = 0;
      try {
        let cursor = await tx.store.openCursor();
        while (cursor) {
          const op = cursor.value as QueuedOp;
          if (op.failed !== null && (!o?.onlyNetworkLike || isNetworkLikeMessage(op.failed.reason))) {
            await cursor.update({ ...op, failed: null });
            count++;
          }
          cursor = await cursor.continue();
        }
        await tx.done;
      } catch (e) {
        try {
          tx.abort();
        } catch {
          // already finished or aborted
        }
        await tx.done.catch(() => {});
        throw new LocalWriteError('Could not save to local storage', { cause: e });
      }
      if (count > 0) notify();
      return count;
    },

    onChange(fn) {
      // A fresh wrapper per call, so subscribing the same function twice gives two independent subscriptions.
      const listener = () => fn();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    // The index and the matching rules arrive in a later stage; only the shape is fixed here.
    async search(): Promise<SearchHit[]> {
      return [];
    },
  };
}
