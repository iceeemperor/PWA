import { isAuthApiError, isAuthRetryableFetchError, type Session, type SupabaseClient } from '@supabase/supabase-js';

export type SignInResult = { ok: true } | { ok: false; reason: 'invalid_credentials' | 'network' | 'unknown' };

export interface SessionChange {
  userId: string | null;
  /** The session ended without the user signing out (expired, revoked, refresh failed). */
  expired: boolean;
}

/** Email and password sign-in only (spec 3.3): no sign-up, no magic link, no OAuth. */
export interface AuthApi {
  signIn(email: string, password: string): Promise<SignInResult>;
  signOut(): Promise<void>;
  /** The signed-in user's id from the cached session, or null. */
  getUserId(): string | null;
  onSessionChange(fn: (s: SessionChange) => void): () => void;
}

export interface SupabaseAuth extends AuthApi {
  /** Resolves once the stored session has been read, so `getUserId()` is meaningful. Never rejects. */
  ready: Promise<void>;
}

function classify(error: unknown): Exclude<SignInResult, { ok: true }>['reason'] {
  if (isAuthApiError(error)) {
    if ((error.status === 400 && error.code === 'invalid_credentials') || error.message === 'Invalid login credentials') {
      return 'invalid_credentials';
    }
    return 'unknown';
  }
  if (isAuthRetryableFetchError(error) || error instanceof TypeError) return 'network';
  return 'unknown';
}

type AuthClient = Pick<SupabaseClient, 'auth'>;

export function createSupabaseAuth(client: AuthClient): SupabaseAuth {
  let userId: string | null = null;
  let signingOut = false;
  const listeners = new Set<(s: SessionChange) => void>();

  const idOf = (session: Session | null | undefined): string | null => session?.user?.id ?? null;

  function emit(change: SessionChange): void {
    for (const fn of [...listeners]) {
      try {
        fn(change);
      } catch (e) {
        console.error('AuthApi listener failed', e);
      }
    }
  }

  client.auth.onAuthStateChange((event, session) => {
    const next = idOf(session);
    if (event === 'SIGNED_OUT' || (event === 'TOKEN_REFRESHED' && !session)) {
      const expired = !signingOut;
      userId = null;
      emit({ userId: null, expired });
      return;
    }
    // A sign-in is always news (the app may have left the shell on a refused sync while the session looked alive);
    // for INITIAL_SESSION, TOKEN_REFRESHED, USER_UPDATED ... only a change of user is.
    if (event !== 'SIGNED_IN' && next === userId) return;
    userId = next;
    emit({ userId, expired: false });
  });

  const ready = client.auth
    .getSession()
    .then(({ data }) => {
      // An auth event may already have set the user; the stored session only fills a gap.
      if (userId === null) userId = idOf(data.session);
    })
    .catch(() => {});

  return {
    ready,

    async signIn(email, password) {
      try {
        const { error } = await client.auth.signInWithPassword({ email, password });
        if (error) return { ok: false, reason: classify(error) };
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: classify(e) };
      }
    },

    async signOut() {
      // 'local' clears this device's session first (works offline), then revokes the token as a best effort.
      signingOut = true;
      try {
        await client.auth.signOut({ scope: 'local' });
      } finally {
        signingOut = false;
      }
      if (userId !== null) {
        // The SIGNED_OUT event did not arrive (the call failed early): the user still asked to leave.
        userId = null;
        emit({ userId: null, expired: false });
      }
    },

    getUserId: () => userId,

    onSessionChange(fn) {
      const listener = (s: SessionChange) => fn(s);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
