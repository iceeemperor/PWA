import { openLocalDb } from '../../src/data/local-db';
import { createRepo } from '../../src/data/repo';
import type { Services } from '../../src/app/services';
import type { CloudClient } from '../../src/sync/cloud';
import { createSyncEngine } from '../../src/sync/engine';
import { createFakeAuth, type FakeAuth } from './fake-auth';

let count = 0;

/** A cloud that is never reachable: every call fails like a dropped connection. */
export function offlineCloud(): CloudClient {
  const fail = async (): Promise<never> => {
    throw new TypeError('Failed to fetch');
  };
  return { push: fail, pull: fail, purgeExpired: fail, importBackup: fail };
}

/** Real local db, repo and engine (fake-indexeddb), an offline cloud and a fake auth. */
export async function createTestServices(o: { auth?: FakeAuth; cloud?: CloudClient } = {}): Promise<Services & { auth: FakeAuth }> {
  const auth = o.auth ?? createFakeAuth();
  const db = await openLocalDb(`ui-test-${++count}`);
  const repo = createRepo(db, {
    userId: () => {
      const id = auth.getUserId();
      if (!id) throw new Error('not signed in');
      return id;
    },
  });
  const cloud = o.cloud ?? offlineCloud();
  const engine = createSyncEngine({ db, cloud });
  return { db, repo, cloud, engine, auth };
}
