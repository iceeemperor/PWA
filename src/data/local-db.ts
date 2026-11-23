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

export interface LocalDbOptions {
  /**
   * Another tab opened a newer version of the database. This connection has already been closed so that tab's
   * upgrade can finish; this page must stop using it and ask the user to reload.
   */
  onVersionChange?: () => void;
  /**
   * The upgrade is waiting for another tab that keeps an older version open (a stage 1 tab never closes it by
   * itself). The open finishes on its own once that tab closes.
   */
  onBlocked?: () => void;
}

const DEFAULT_NAME = 'productivity-app';
export const SCHEMA_VERSION = 2;

// Stores: one per table (keyed by `id`), the upload `queue` (auto-increment
// `seq`) and `meta`, a key/value store with out-of-line keys: `db_id`,
// `cursor` (number, starts at 0), `last_export_at` and the owner keys.
// Version history: 1 = todos, queue, meta (stage 1); 2 = + events (stage 2).
const META = 'meta';

export async function openLocalDb(name: string = DEFAULT_NAME, o: LocalDbOptions = {}): Promise<LocalDb> {
  if (typeof indexedDB === 'undefined') {
    throw new LocalDbUnavailableError('IndexedDB is not available in this browser');
  }

  let raw: IDBPDatabase | undefined;
  try {
    raw = await openDB(name, SCHEMA_VERSION, {
      // Additive only: every store is created only if it is missing, so no existing store or record is touched.
      upgrade(db, oldVersion, _newVersion, tx) {
        for (const table of TABLES) {
          if (!db.objectStoreNames.contains(table)) db.createObjectStore(table, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'seq', autoIncrement: true });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
        // Stage 1 pulls skipped rows of tables it did not know but still moved the cursor past them (audit I2):
        // start the download over so the new tables are filled. Same transaction, so it lands with the new stores.
        if (oldVersion >= 1 && oldVersion < 2) void tx.objectStore(META).put(0, 'cursor');
      },
      blocked() {
        o.onBlocked?.();
      },
      blocking(_current, _blocked, event) {
        // Close first, so the other tab's upgrade is not held up by this one, then tell the page.
        (event.target as IDBDatabase).close();
        o.onVersionChange?.();
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
