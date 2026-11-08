import { openDB, type IDBPDatabase } from 'idb';
import { newId, isUuid } from '../domain/ids';
import { TABLES } from '../domain/types';

/** IndexedDB is missing or could not be opened (private mode, blocked storage, ...). */
export class LocalDbUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LocalDbUnavailableError';
  }
}

export interface LocalDb {
  raw: IDBPDatabase;
  /** Identity of this local database; a missing one means a fresh install. */
  dbId: string;
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;
  close(): void;
}

const DEFAULT_NAME = 'productivity-app';
const SCHEMA_VERSION = 1;

// Stores: one per table (keyed by `id`), the upload `queue` (auto-increment
// `seq`) and `meta`, a key/value store with out-of-line keys: `db_id`,
// `cursor` (number, starts at 0) and `last_export_at`.
const META = 'meta';

export async function openLocalDb(name: string = DEFAULT_NAME): Promise<LocalDb> {
  if (typeof indexedDB === 'undefined') {
    throw new LocalDbUnavailableError('IndexedDB is not available in this browser');
  }

  let raw: IDBPDatabase | undefined;
  try {
    raw = await openDB(name, SCHEMA_VERSION, {
      upgrade(db) {
        for (const table of TABLES) db.createObjectStore(table, { keyPath: 'id' });
        db.createObjectStore('queue', { keyPath: 'seq', autoIncrement: true });
        db.createObjectStore(META);
      },
    });

    // Without a db_id this is a fresh install: write the identity and reset the
    // sync cursor together, in one transaction, so a full download follows.
    const tx = raw.transaction(META, 'readwrite');
    const store = tx.objectStore(META);
    let dbId: unknown = await store.get('db_id');
    if (typeof dbId !== 'string' || !isUuid(dbId)) {
      dbId = newId();
      await store.put(dbId, 'db_id');
      await store.put(0, 'cursor');
    }
    await tx.done;

    const opened = raw;
    return {
      raw: opened,
      dbId: dbId as string,
      getMeta: <T>(key: string) => opened.get(META, key) as Promise<T | undefined>,
      setMeta: async (key, value) => {
        await opened.put(META, value, key);
      },
      close: () => opened.close(),
    };
  } catch (cause) {
    raw?.close();
    throw new LocalDbUnavailableError('Could not open the local database', { cause });
  }
}
