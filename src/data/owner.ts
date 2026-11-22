import type { LocalDb } from './local-db';

/** meta keys: the account this device's local data belongs to, and whether it is still signed in (not signed out). */
export const OWNER_USER_ID = 'owner_user_id';
export const OWNER_SIGNED_IN = 'owner_signed_in';

export type AdoptResult = { ok: true } | { ok: false; pending: number };

/** The device's account owner, kept in local meta so an offline start and an account switch can be decided locally. */
export interface OwnerStore {
  /** The owner, if it was signed in and never signed out. */
  signedInOwner(): Promise<string | null>;
  /** A user was signed in: make it the owner (signed in). */
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
      const tx = db.raw.transaction('meta', 'readwrite');
      await tx.store.put(userId, OWNER_USER_ID);
      await tx.store.put(true, OWNER_SIGNED_IN);
      await tx.done;
      return { ok: true };
    },

    async signedOut() {
      await db.setMeta(OWNER_SIGNED_IN, false);
    },
  };
}
