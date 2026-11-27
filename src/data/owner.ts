import { TABLES } from '../domain/types';
import type { LocalDb } from './local-db';

/** meta keys: the account this device's local data belongs to, and whether it is still signed in (not signed out). */
export const OWNER_USER_ID = 'owner_user_id';
export const OWNER_SIGNED_IN = 'owner_signed_in';

export type AdoptResult = { ok: true } | { ok: false; pending: number };

/** The device's account owner, kept in local meta so an offline start and an account switch can be decided locally. */
export interface OwnerStore {
  /** The owner, if it was signed in and never signed out. */
  signedInOwner(): Promise<string | null>;
  /**
   * A user was signed in. The owner, or no owner yet: it becomes the owner (signed in). Another account: with an
   * empty queue the local copy is wiped (records, queue, cursor, export date, weather city and cache; db_id kept) and it becomes the owner;
   * with ops still queued (pending or failed) it is refused and nothing changes.
   */
  adopt(userId: string): Promise<AdoptResult>;
  /** The user signed out on purpose: the owner id stays, it no longer counts as signed in. */
  signedOut(): Promise<void>;
}

export function createOwnerStore(db: LocalDb): OwnerStore {
  return {
    async signedInOwner() {
      const [id, signedIn] = await Promise.all([db.getMeta<unknown>(OWNER_USER_ID), db.getMeta<unknown>(OWNER_SIGNED_IN)]);
      return typeof id === 'string' && id !== '' && signedIn === true ? id : null;
    },

    async adopt(userId) {
      // One transaction: the queue cannot fill up between the check and the wipe.
      const tx = db.raw.transaction([...TABLES, 'queue', 'meta'], 'readwrite');
      tx.done.catch(() => {});
      const meta = tx.objectStore('meta');
      const current: unknown = await meta.get(OWNER_USER_ID);
      if (typeof current === 'string' && current !== '' && current !== userId) {
        const queued = await tx.objectStore('queue').count();
        if (queued > 0) {
          tx.abort();
          await tx.done.catch(() => {});
          return { ok: false, pending: queued };
        }
        for (const t of TABLES) await tx.objectStore(t).clear();
        await tx.objectStore('queue').clear();
        await meta.put(0, 'cursor');
        await meta.delete('last_export_at');
        // Plan decision 6: the weather city is personal, so it goes with the account (same keys as weather/store.ts).
        await meta.put(null, 'weather_city');
        await meta.put(null, 'weather_cache');
      }
      await meta.put(userId, OWNER_USER_ID);
      await meta.put(true, OWNER_SIGNED_IN);
      await tx.done;
      return { ok: true };
    },

    async signedOut() {
      await db.setMeta(OWNER_SIGNED_IN, false);
    },
  };
}
