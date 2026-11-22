import { isAuthApiError, isAuthError, isAuthRetryableFetchError, type Session, type SupabaseClient } from '@supabase/supabase-js';

export type SignInResult =
  | { ok: true }
  | { ok: false; reason: 'invalid_credentials' | 'network' | 'unknown' }
  /** The account is not this device's owner and the owner still has `pending` ops queued here (F3). */
  | { ok: false; reason: 'other_account'; pending: number };

type CredentialFailure = 'invalid_credentials' | 'network' | 'unknown';

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
  /** The owner's session had already ended (refused, not just unreachable) when the app started. Optional. */
  expiredAtStart?(): boolean;
}

export interface SupabaseAuthOptions {
  /**
   * The user who was last signed in on this device and did not sign out (local meta). When the stored session cannot
   * be refreshed only because there is no network, the app starts signed in as this user (local first, spec 8.3).
   */
  offlineUserId?: () => Promise<string | null>;
  /** How long `ready` waits for the stored session before going on without it. Default 2000 ms. */
  readyTimeoutMs?: number;
}

export const READY_TIMEOUT_MS = 2000;

export interface SupabaseAuth extends AuthApi {
  /** Resolves once the stored session has been read, so `getUserId()` is meaningful. Never rejects. */
  ready: Promise<void>;
}

function classify(error: unknown): CredentialFailure {
  // Status 0: the request got no response (auth-js reports an offline fetch that way).
  if (isAuthError(error) && error.status === 0) return 'network';
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

/** A failure to reach the auth server, as opposed to the server refusing the session. */
function isNetworkError(error: unknown): boolean {
  return isAuthRetryableFetchError(error) || error instanceof TypeError || (isAuthError(error) && error.status === 0);
}

type StoredSession = { session: Session | null; error: unknown };

export function createSupabaseAuth(client: AuthClient, opts: SupabaseAuthOptions = {}): SupabaseAuth {
  let userId: string | null = null;
  let signingOut = false;
  // Signed in as the remembered owner without a live session: the refresh is still pending or failed offline.
  let provisional = false;
  let expiredAtStart = false;
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
    // The start-up state comes from getSession below; an INITIAL_SESSION without a session (auth-js emits one when
    // the refresh failed offline) must not sign the offline owner out.
    if (event === 'INITIAL_SESSION' && !session) return;
    provisional = false;
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

  const stored: Promise<StoredSession> = client.auth.getSession().then(
    ({ data, error }) => ({ session: data.session, error }),
    (error: unknown) => ({ session: null, error }),
  );

  const ready = (async () => {
    const remembered = opts.offlineUserId ? await opts.offlineUserId().catch(() => null) : null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Boot never waits on a network refresh: offline, auth-js retries it for about 25 s.
    const bound = new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), opts.readyTimeoutMs ?? READY_TIMEOUT_MS)));
    const first = await Promise.race([stored, bound]);
    clearTimeout(timer);

    // An auth event may already have set the user; the stored session only fills a gap.
    if (userId !== null) return;
    if (first !== 'timeout' && first.session) {
      userId = idOf(first.session);
      return;
    }
    const offline = first === 'timeout' || isNetworkError(first.error);
    if (offline && remembered) {
      userId = remembered;
      provisional = true;
      // The refresh may still finish: a session confirms (or changes) the user, a refusal ends the offline start.
      if (first === 'timeout') void stored.then(late);
      return;
    }
    // No session, refused or simply absent: signed out; the owner had not signed out, so it ended on its own.
    if (remembered) expiredAtStart = true;
  })().catch(() => {});

  function late(r: StoredSession): void {
    if (!provisional) return;
    if (r.session) {
      provisional = false;
      const next = idOf(r.session);
      if (next !== userId) {
        userId = next;
        emit({ userId, expired: false });
      }
      return;
    }
    if (isNetworkError(r.error)) return;
    provisional = false;
    userId = null;
    emit({ userId: null, expired: true });
  }

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
      provisional = false;
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

    expiredAtStart: () => expiredAtStart,

    onSessionChange(fn) {
      const listener = (s: SessionChange) => fn(s);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
