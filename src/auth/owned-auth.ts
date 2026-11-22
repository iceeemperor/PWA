import type { AdoptResult, OwnerStore } from '../data/owner';
import type { SessionChange, SignInResult, SupabaseAuth } from './auth';

/**
 * Wraps the auth so every signed-in user is first checked against the device's owner (local meta). Listeners and
 * `getUserId()` only ever see a user the owner store accepted; an explicit sign-out is recorded so an offline start
 * does not sign back in.
 */
export function createOwnedAuth(inner: SupabaseAuth, owner: OwnerStore): SupabaseAuth {
  let userId: string | null = null;
  // Set while this wrapper signs a refused user out again, so that sign-out is not taken as the user's own.
  let refusing = false;
  // Set while an explicit signOut() already recorded and announced the sign-out, so its SIGNED_OUT event adds nothing.
  let signOutAnnounced = false;
  const listeners = new Set<(s: SessionChange) => void>();
  const inflight = new Map<string, Promise<AdoptResult>>();

  function emit(change: SessionChange): void {
    for (const fn of [...listeners]) {
      try {
        fn(change);
      } catch (e) {
        console.error('AuthApi listener failed', e);
      }
    }
  }

  /** One check per user at a time: the sign-in call and its SIGNED_IN event share it. */
  function vet(id: string): Promise<AdoptResult> {
    let p = inflight.get(id);
    if (!p) {
      p = (async () => {
        const r = await owner.adopt(id);
        if (!r.ok) {
          refusing = true;
          try {
            await inner.signOut();
          } finally {
            refusing = false;
          }
        }
        return r;
      })().finally(() => inflight.delete(id));
      inflight.set(id, p);
    }
    return p;
  }

  inner.onSessionChange((s) => {
    if (s.userId === null) {
      if (refusing) return;
      userId = null;
      if (signOutAnnounced) return;
      if (!s.expired) owner.signedOut().catch((e: unknown) => console.error('Could not record the sign-out', e));
      emit(s);
      return;
    }
    const id = s.userId;
    vet(id).then(
      (r) => {
        // Still the signed-in user once the check is done (no sign-out came in between).
        if (!r.ok || inner.getUserId() !== id) return;
        userId = id;
        emit({ userId: id, expired: false });
      },
      (e: unknown) => console.error('Could not check the account owner', e),
    );
  });

  const ready = inner.ready.then(async () => {
    const id = inner.getUserId();
    if (!id) return;
    const r = await vet(id).catch(() => ({ ok: false, pending: 0 }) as const);
    if (r.ok && inner.getUserId() === id) userId = id;
  });

  return {
    ready,

    async signIn(email, password): Promise<SignInResult> {
      const r = await inner.signIn(email, password);
      if (!r.ok) return r;
      const id = inner.getUserId();
      if (!id) return { ok: false, reason: 'unknown' };
      let v: AdoptResult;
      try {
        v = await vet(id);
      } catch {
        return { ok: false, reason: 'unknown' };
      }
      if (!v.ok) return { ok: false, reason: 'other_account', pending: v.pending };
      userId = id;
      return r;
    },

    async signOut() {
      // Record it first: the auth call can take ~25 s offline with an expired token, and an app closed meanwhile
      // must not reopen as the signed-in owner. The UI leaves at once too, instead of looking dead.
      try {
        await owner.signedOut();
      } catch (e) {
        console.error('Could not record the sign-out', e);
      }
      if (userId !== null) {
        userId = null;
        signOutAnnounced = true;
        emit({ userId: null, expired: false });
      }
      try {
        await inner.signOut();
      } finally {
        signOutAnnounced = false;
      }
    },

    getUserId: () => userId,

    expiredAtStart: () => inner.expiredAtStart?.() ?? false,

    onSessionChange(fn) {
      const listener = (s: SessionChange) => fn(s);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
