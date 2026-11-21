import type { AuthApi, SignInResult } from '../../src/auth/auth';

export type FakeAuth = AuthApi & {
  /** Ends the session the way the server would (not through signOut): listeners get `expired: true`. */
  expire(): void;
  /** What the next signIn calls return. A successful sign-in signs in as `fake-user`. */
  setSignInResult(r: SignInResult): void;
};

export const FAKE_USER_ID = '00000000-0000-4000-8000-000000000001';

/** An in-memory AuthApi. Signed in as `FAKE_USER_ID` unless `initialUserId` says otherwise (`null` = signed out). */
export function createFakeAuth(initialUserId: string | null = FAKE_USER_ID): FakeAuth {
  let userId: string | null = initialUserId;
  let next: SignInResult = { ok: true };
  const listeners = new Set<(s: { userId: string | null; expired: boolean }) => void>();
  const emit = (expired: boolean) => {
    for (const fn of [...listeners]) fn({ userId, expired });
  };

  return {
    async signIn() {
      const r = next;
      if (r.ok) {
        userId = initialUserId ?? FAKE_USER_ID;
        emit(false);
      }
      return r;
    },
    async signOut() {
      userId = null;
      emit(false);
    },
    getUserId: () => userId,
    onSessionChange(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    expire() {
      userId = null;
      emit(true);
    },
    setSignInResult(r) {
      next = r;
    },
  };
}
