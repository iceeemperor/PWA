import { createSupabaseAuth, type AuthApi } from '../auth/auth';
import { createOwnedAuth } from '../auth/owned-auth';
import { openLocalDb, type LocalDb } from '../data/local-db';
import { createOwnerStore } from '../data/owner';
import { createRepo, type Repo } from '../data/repo';
import { getSupabase } from '../supabase';
import type { CloudClient } from '../sync/cloud';
import { createSyncEngine, type SyncDeps, type SyncEngine } from '../sync/engine';
import { createSupabaseCloud } from '../sync/supabase-cloud';
import { startSyncTriggers } from '../sync/triggers';

export interface Services {
  db: LocalDb;
  repo: Repo;
  cloud: CloudClient;
  engine: SyncEngine;
  auth: AuthApi;
  /**
   * Starts the sync triggers and returns the stop function. The app calls it once a user is signed in and stops it on
   * sign-out or expiry. Missing (test services): the app starts the triggers with their defaults.
   */
  startSync?: () => () => void;
}

/** Thrown by the Repo when a write is attempted with nobody signed in. */
export class NotSignedInError extends Error {
  constructor() {
    super('Not signed in');
    this.name = 'NotSignedInError';
  }
}

/** Requeues failed ops whose reason reads like a lost connection. Never throws: boot must not depend on it. */
export async function requeueNetworkFailures(repo: Pick<Repo, 'retryFailed'>): Promise<number> {
  try {
    return await repo.retryFailed({ onlyNetworkLike: true });
  } catch (e) {
    console.error('Could not requeue failed ops', e);
    return 0;
  }
}

/** Builds the app's services. `openLocalDb`'s LocalDbUnavailableError propagates unchanged. */
export async function createServices(env: ImportMetaEnv): Promise<Services> {
  const db = await openLocalDb();
  const supabase = getSupabase();
  const owner = createOwnerStore(db);
  // Offline with an expired token, the remembered owner keeps the app usable; boot never waits on the refresh.
  const auth = createOwnedAuth(createSupabaseAuth(supabase, { offlineUserId: () => owner.signedInOwner() }), owner);
  await auth.ready;

  // One local database per browser profile; records carry the signed-in user's id at write time.
  const repo = createRepo(db, {
    userId: () => {
      const id = auth.getUserId();
      if (!id) throw new NotSignedInError();
      return id;
    },
  });
  // Ops an earlier build marked failed on a lost connection (status-0 fetch errors) go back in the queue, before the
  // engine counts it. Ops the server really refused stay failed for the user.
  // The queue is device-wide, not per account. Requeueing every network-failed op is safe only because the F3 owner
  // guard (owned-auth) refuses to sign in another account while this device's owner still has ops queued, so the
  // ops pushed here are always the signed-in owner's.
  await requeueNetworkFailures(repo);

  const cloud = createSupabaseCloud(supabase);
  const deps: SyncDeps = { db, cloud };
  if (typeof navigator !== 'undefined' && navigator.locks) deps.locks = navigator.locks;
  const engine = createSyncEngine(deps);

  const purge = env.VITE_PURGE_ON_START === 'true';
  const startSync = () => startSyncTriggers({ engine, repo, ...(purge ? { purgeOnStart: cloud } : {}) });

  return { db, repo, cloud, engine, auth, startSync };
}
