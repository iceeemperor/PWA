import { AuthApiError, AuthRetryableFetchError, type AuthChangeEvent, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { createSupabaseAuth } from '../../src/auth/auth';

type Listener = (event: AuthChangeEvent, session: Session | null) => void;

function fakeClient(o: { session?: Session | null; signIn?: () => Promise<unknown> } = {}) {
  const listeners: Listener[] = [];
  const state = { session: o.session ?? null };
  const emit = (event: AuthChangeEvent, session: Session | null) => {
    state.session = session;
    for (const l of listeners) l(event, session);
  };
  const auth = {
    signInWithPassword: vi.fn(o.signIn ?? (async () => ({ data: { session: sess('u1') }, error: null }))),
    signOut: vi.fn(async (_o?: { scope?: string }) => {
      emit('SIGNED_OUT', null);
      return { error: null };
    }),
    getSession: vi.fn(async () => ({ data: { session: state.session }, error: null })),
    onAuthStateChange: vi.fn((l: Listener) => {
      listeners.push(l);
      return { data: { subscription: { unsubscribe: () => listeners.splice(listeners.indexOf(l), 1) } } };
    }),
  };
  return { client: { auth } as unknown as SupabaseClient, auth, emit };
}

function sess(userId: string): Session {
  return { user: { id: userId } } as unknown as Session;
}

describe('createSupabaseAuth: signIn', () => {
  it('signs in with email and password', async () => {
    const f = fakeClient();
    const a = createSupabaseAuth(f.client);
    expect(await a.signIn('me@example.com', 'pw')).toEqual({ ok: true });
    expect(f.auth.signInWithPassword).toHaveBeenCalledWith({ email: 'me@example.com', password: 'pw' });
  });

  it.each([
    ['invalid_credentials by code', new AuthApiError('whatever', 400, 'invalid_credentials'), 'invalid_credentials'],
    ['invalid_credentials by message', new AuthApiError('Invalid login credentials', 400, undefined), 'invalid_credentials'],
    ['retryable fetch error', new AuthRetryableFetchError('Failed to fetch', 0), 'network'],
    ['TypeError', new TypeError('Failed to fetch'), 'network'],
    ['other api error', new AuthApiError('Email not confirmed', 400, 'email_not_confirmed'), 'unknown'],
    ['server error', new AuthApiError('boom', 500, 'unexpected_failure'), 'unknown'],
  ] as const)('maps %s', async (_n, error, reason) => {
    const returned = createSupabaseAuth(fakeClient({ signIn: async () => ({ data: { session: null }, error }) }).client);
    expect(await returned.signIn('a@b.c', 'x')).toEqual({ ok: false, reason });
    const thrown = createSupabaseAuth(fakeClient({ signIn: async () => { throw error; } }).client);
    expect(await thrown.signIn('a@b.c', 'x')).toEqual({ ok: false, reason });
  });
});

describe('createSupabaseAuth: session', () => {
  it('getUserId reads the cached session once ready', async () => {
    const f = fakeClient({ session: sess('u1') });
    const a = createSupabaseAuth(f.client);
    await a.ready;
    expect(a.getUserId()).toBe('u1');
  });

  it('tracks sign-in and our own sign-out (not expired)', async () => {
    const f = fakeClient();
    const a = createSupabaseAuth(f.client);
    await a.ready;
    const seen: { userId: string | null; expired: boolean }[] = [];
    a.onSessionChange((s) => seen.push(s));
    f.emit('SIGNED_IN', sess('u1'));
    expect(a.getUserId()).toBe('u1');
    await a.signOut();
    expect(f.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(a.getUserId()).toBeNull();
    expect(seen).toEqual([{ userId: 'u1', expired: false }, { userId: null, expired: false }]);
  });

  it('a SIGNED_OUT we did not ask for, or a failed refresh, counts as expired', async () => {
    const f = fakeClient({ session: sess('u1') });
    const a = createSupabaseAuth(f.client);
    await a.ready;
    const seen: { userId: string | null; expired: boolean }[] = [];
    a.onSessionChange((s) => seen.push(s));
    f.emit('SIGNED_OUT', null);
    f.emit('SIGNED_IN', sess('u1'));
    f.emit('TOKEN_REFRESHED', null);
    expect(seen).toEqual([
      { userId: null, expired: true },
      { userId: 'u1', expired: false },
      { userId: null, expired: true },
    ]);
  });

  it('a successful token refresh is not reported as a change', async () => {
    const f = fakeClient({ session: sess('u1') });
    const a = createSupabaseAuth(f.client);
    await a.ready;
    const fn = vi.fn();
    a.onSessionChange(fn);
    f.emit('TOKEN_REFRESHED', sess('u1'));
    expect(fn).not.toHaveBeenCalled();
  });

  it('unsubscribe stops notifications', async () => {
    const f = fakeClient();
    const a = createSupabaseAuth(f.client);
    const fn = vi.fn();
    a.onSessionChange(fn)();
    f.emit('SIGNED_IN', sess('u1'));
    expect(fn).not.toHaveBeenCalled();
  });
});
