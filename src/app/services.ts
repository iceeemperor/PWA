import { createSupabaseAuth, type AuthApi } from '../auth/auth';
import { openLocalDb, type LocalDb } from '../data/local-db';
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

/** Builds the app's services. `openLocalDb`'s LocalDbUnavailableError propagates unchanged. */
export async function createServices(env: ImportMetaEnv): Promise<Services> {
  const db = await openLocalDb();
  const supabase = getSupabase();
  const auth = createSupabaseAuth(supabase);
  await auth.ready;

  // One local database per browser profile; records carry the signed-in user's id at write time.
  const repo = createRepo(db, {
    userId: () => {
      const id = auth.getUserId();
      if (!id) throw new NotSignedInError();
      return id;
    },
  });
  const cloud = createSupabaseCloud(supabase);
  const deps: SyncDeps = { db, cloud };
  if (typeof navigator !== 'undefined' && navigator.locks) deps.locks = navigator.locks;
  const engine = createSyncEngine(deps);

  const purge = env.VITE_PURGE_ON_START === 'true';
  const startSync = () => startSyncTriggers({ engine, repo, ...(purge ? { purgeOnStart: cloud } : {}) });

  return { db, repo, cloud, engine, auth, startSync };
}
