import { deleteDB } from 'idb';
import { openLocalDb, type LocalDb } from '../../src/data/local-db';
import { createRepo, type Repo } from '../../src/data/repo';
import type { CloudClient } from '../../src/sync/cloud';
import { createSyncEngine, type SyncEngine } from '../../src/sync/engine';

export interface DeviceOptions {
  name: string;
  cloud: CloudClient;
  userId: string;
  now?: () => Date;
  locks?: Pick<LockManager, 'request'>;
  pageSize?: number;
}

export interface Device {
  db: LocalDb;
  repo: Repo;
  engine: SyncEngine;
  /** Deletes this device's IndexedDB and opens it again empty, like clearing the browser's site data. */
  reopenFresh(): Promise<Device>;
}

// fake-indexeddb is one global per test file: a counter keeps devices of different tests apart.
let count = 0;

async function open(o: DeviceOptions, dbName: string): Promise<Device> {
  const db = await openLocalDb(dbName);
  const repo = createRepo(db, { userId: () => o.userId, now: o.now });
  const engine = createSyncEngine({ db, cloud: o.cloud, locks: o.locks, pageSize: o.pageSize });
  return {
    db,
    repo,
    engine,
    async reopenFresh() {
      db.close();
      await deleteDB(dbName);
      return open(o, dbName);
    },
  };
}

/** One simulated device: its own local database, repo and sync engine. */
export function createDevice(o: DeviceOptions): Promise<Device> {
  return open(o, `device-${o.name}-${++count}`);
}
