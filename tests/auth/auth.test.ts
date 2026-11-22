import { AuthApiError, AuthError, AuthRetryableFetchError, type AuthChangeEvent, type Session, type SupabaseClient } from '@supabase/supabase-js';
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
    ['Safari offline retryable fetch error', new AuthRetryableFetchError('Load failed', 0), 'network'],
    ['status-0 auth error', new AuthError('Load failed', 0, undefined), 'network'],
    ['other api error', new AuthApiError('Email not confirmed', 400, 'email_not_confirmed'), 'unknown'],
    ['server error', new AuthApiError('boom', 500, 'unexpected_failure'), 'unknown'],
  ] as const)('maps %s', async (_n, error, reason) => {
    const returned = createSupabaseAuth(fakeClient({ signIn: async () => ({ data: { session: null }, error }) }).client);
    expect(await returned.signIn('a@b.c', 'x')).toMatchObject({ ok: false, reason });
    const thrown = createSupabaseAuth(fakeClient({ signIn: async () => { throw error; } }).client);
    expect(await thrown.signIn('a@b.c', 'x')).toMatchObject({ ok: false, reason });
  });

  it('an unknown failure carries the server message and code as detail; the others carry none', async () => {
    const error = new AuthApiError('Email logins are disabled', 422, 'email_provider_disabled');
    const a = createSupabaseAuth(fakeClient({ signIn: async () => ({ data: { session: null }, error }) }).client);
    expect(await a.signIn('a@b.c', 'x')).toEqual({
      ok: false,
      reason: 'unknown',
      detail: 'Email logins are disabled [email_provider_disabled]',
    });
    const thrown = createSupabaseAuth(fakeClient({ signIn: async () => { throw new Error('boom'); } }).client);
    expect(await thrown.signIn('a@b.c', 'x')).toEqual({ ok: false, reason: 'unknown', detail: 'boom' });
    const bad = new AuthApiError('Invalid login credentials', 400, 'invalid_credentials');
    const b = createSupabaseAuth(fakeClient({ signIn: async () => ({ data: { session: null }, error: bad }) }).client);
    expect(await b.signIn('a@b.c', 'x')).toEqual({ ok: false, reason: 'invalid_credentials' });
    const off = createSupabaseAuth(fakeClient({ signIn: async () => { throw new TypeError('Load failed'); } }).client);
    expect(await off.signIn('a@b.c', 'x')).toEqual({ ok: false, reason: 'network' });
  });

  it('masks the email case-insensitively and URL-encoded; an empty password masks nothing', async () => {
    const echo = new AuthApiError('User me+x@example.com (me%2Bx%40example.com) is banned', 400, 'user_banned');
    const a = createSupabaseAuth(fakeClient({ signIn: async () => ({ data: { session: null }, error: echo }) }).client);
    const r = await a.signIn('Me+X@Example.COM', 'Hunter22');
    const detail = r.ok === false && r.reason === 'unknown' ? r.detail! : '';
    expect(detail).toContain('is banned');
    expect(detail.toLowerCase()).not.toContain('me+x@example.com');
    expect(detail.toLowerCase()).not.toContain('me%2bx%40example.com');

    const pw = new AuthApiError('PASSWORD hunter22 rejected', 400, 'weird');
    const b = createSupabaseAuth(fakeClient({ signIn: async () => ({ data: { session: null }, error: pw }) }).client);
    const r2 = await b.signIn('a@b.c', 'Hunter22');
    expect(r2.ok === false && r2.reason === 'unknown' ? r2.detail : '').not.toMatch(/hunter22/i);

    const plain = new AuthApiError('Email logins are disabled', 422, 'email_provider_disabled');
    const c = createSupabaseAuth(fakeClient({ signIn: async () => ({ data: { session: null }, error: plain }) }).client);
    expect(await c.signIn('', '')).toEqual({ ok: false, reason: 'unknown', detail: 'Email logins are disabled [email_provider_disabled]' });
  });

  it('the detail is capped at 120 characters and never contains the email or password', async () => {
    const long = new AuthApiError('x'.repeat(300), 500, 'unexpected_failure');
    const a = createSupabaseAuth(fakeClient({ signIn: async () => ({ data: { session: null }, error: long }) }).client);
    const r = await a.signIn('a@b.c', 'pw');
    expect(r.ok === false && r.reason === 'unknown' && r.detail!.length).toBe(120);

    const echo = new AuthApiError('User me@example.com with password hunter22 is banned', 400, 'user_banned');
    const b = createSupabaseAuth(fakeClient({ signIn: async () => ({ data: { session: null }, error: echo }) }).client);
    const r2 = await b.signIn('me@example.com', 'hunter22');
    expect(r2).toMatchObject({ ok: false, reason: 'unknown' });
    const detail = r2.ok === false && r2.reason === 'unknown' ? r2.detail! : '';
    expect(detail).toContain('is banned');
    expect(detail).not.toContain('me@example.com');
    expect(detail).not.toContain('hunter22');
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

describe('createSupabaseAuth: offline start (F1)', () => {
  // auth-js, offline with an expired access token: getSession retries the refresh, then gives no session and a
  // retryable fetch error while the session stays in storage.
  function offlineClient(getSession: () => Promise<unknown>) {
    const f = fakeClient();
    f.auth.getSession.mockImplementation(getSession as never);
    return f;
  }
  const remembered = (id: string | null) => ({ offlineUserId: async () => id, readyTimeoutMs: 50 });

  it('a refresh that failed for want of a network keeps the remembered owner signed in', async () => {
    const f = offlineClient(async () => ({ data: { session: null }, error: new AuthRetryableFetchError('Failed to fetch', 0) }));
    const a = createSupabaseAuth(f.client, remembered('u1'));
    await a.ready;
    expect(a.getUserId()).toBe('u1');
    expect(a.expiredAtStart?.()).toBe(false);
  });

  it('a fetch TypeError counts as offline too', async () => {
    const f = offlineClient(async () => { throw new TypeError('Failed to fetch'); });
    const a = createSupabaseAuth(f.client, remembered('u1'));
    await a.ready;
    expect(a.getUserId()).toBe('u1');
  });

  it('without a remembered owner an offline start stays signed out', async () => {
    const f = offlineClient(async () => ({ data: { session: null }, error: new AuthRetryableFetchError('Failed to fetch', 0) }));
    const a = createSupabaseAuth(f.client, remembered(null));
    await a.ready;
    expect(a.getUserId()).toBeNull();
  });

  it('boot does not wait for a slow refresh: ready resolves after the bound with the remembered owner', async () => {
    const f = offlineClient(() => new Promise(() => {}));
    const a = createSupabaseAuth(f.client, remembered('u1'));
    const t0 = Date.now();
    await a.ready;
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(a.getUserId()).toBe('u1');
  });

  it('an auth rejection at start is not offline: signed out, and reported as expired for the owner', async () => {
    const f = offlineClient(async () => ({ data: { session: null }, error: new AuthApiError('Invalid Refresh Token', 400, 'refresh_token_not_found') }));
    const a = createSupabaseAuth(f.client, remembered('u1'));
    await a.ready;
    expect(a.getUserId()).toBeNull();
    expect(a.expiredAtStart?.()).toBe(true);
  });

  it('no stored session and no error: signed out', async () => {
    const f = offlineClient(async () => ({ data: { session: null }, error: null }));
    const a = createSupabaseAuth(f.client, remembered('u1'));
    await a.ready;
    expect(a.getUserId()).toBeNull();
  });

  it('a late refresh result after the bound: an auth error expires the session, a network error does not', async () => {
    let finish!: (v: unknown) => void;
    const f = offlineClient(() => new Promise((r) => (finish = r)));
    const a = createSupabaseAuth(f.client, remembered('u1'));
    await a.ready;
    const seen: unknown[] = [];
    a.onSessionChange((s) => seen.push(s));
    finish({ data: { session: null }, error: new AuthApiError('Invalid Refresh Token', 400, 'refresh_token_not_found') });
    await vi.waitFor(() => expect(seen).toEqual([{ userId: null, expired: true }]));
    expect(a.getUserId()).toBeNull();

    let finish2!: (v: unknown) => void;
    const g = offlineClient(() => new Promise((r) => (finish2 = r)));
    const b = createSupabaseAuth(g.client, remembered('u1'));
    await b.ready;
    const fn = vi.fn();
    b.onSessionChange(fn);
    finish2({ data: { session: null }, error: new AuthRetryableFetchError('Failed to fetch', 0) });
    await new Promise((r) => setTimeout(r, 10));
    expect(fn).not.toHaveBeenCalled();
    expect(b.getUserId()).toBe('u1');
  });

  it('an INITIAL_SESSION without a session does not sign the offline owner out', async () => {
    const f = offlineClient(async () => ({ data: { session: null }, error: new AuthRetryableFetchError('Failed to fetch', 0) }));
    const a = createSupabaseAuth(f.client, remembered('u1'));
    await a.ready;
    const fn = vi.fn();
    a.onSessionChange(fn);
    f.emit('INITIAL_SESSION', null);
    f.emit('TOKEN_REFRESHED', sess('u1'));
    expect(fn).not.toHaveBeenCalled();
    expect(a.getUserId()).toBe('u1');
    f.emit('SIGNED_OUT', null);
    expect(fn).toHaveBeenCalledWith({ userId: null, expired: true });
  });
});
