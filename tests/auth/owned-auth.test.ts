import { describe, expect, it, vi } from 'vitest';
import { AuthRetryableFetchError, type SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseAuth } from '../../src/auth/auth';
import { createOwnedAuth } from '../../src/auth/owned-auth';
import { openLocalDb, type LocalDb } from '../../src/data/local-db';
import { createOwnerStore, OWNER_SIGNED_IN, OWNER_USER_ID } from '../../src/data/owner';
import { createRepo } from '../../src/data/repo';
import type { QueuedOp } from '../../src/domain/types';
import { createFakeAuth } from '../helpers/fake-auth';

let n = 0;
const A = '00000000-0000-4000-8000-00000000000a';

async function setup(o: { initial?: string | null; db?: LocalDb } = {}) {
  const db = o.db ?? (await openLocalDb(`owned-auth-${++n}`));
  const inner = Object.assign(createFakeAuth(o.initial === undefined ? null : o.initial), { ready: Promise.resolve() });
  const owner = createOwnerStore(db);
  const auth = createOwnedAuth(inner, owner);
  await auth.ready;
  return { db, inner, owner, auth };
}

describe('owner tracking (F1)', () => {
  it('a sign-in records the owner as signed in', async () => {
    const { db, inner, auth } = await setup();
    inner.setSignInUser(A);
    expect(await auth.signIn('a@b.c', 'pw')).toEqual({ ok: true });
    expect(auth.getUserId()).toBe(A);
    expect(await db.getMeta(OWNER_USER_ID)).toBe(A);
    expect(await db.getMeta(OWNER_SIGNED_IN)).toBe(true);
  });

  it('a session found at start is recorded too', async () => {
    const { db, auth } = await setup({ initial: A });
    expect(auth.getUserId()).toBe(A);
    expect(await db.getMeta(OWNER_USER_ID)).toBe(A);
  });

  it('an explicit sign-out keeps the owner id but no longer counts as signed in', async () => {
    const { db, owner, auth } = await setup({ initial: A });
    expect(await owner.signedInOwner()).toBe(A);
    const seen: unknown[] = [];
    auth.onSessionChange((s) => seen.push(s));
    await auth.signOut();
    await vi.waitFor(async () => expect(await db.getMeta(OWNER_SIGNED_IN)).toBe(false));
    expect(await db.getMeta(OWNER_USER_ID)).toBe(A);
    expect(await owner.signedInOwner()).toBeNull();
    expect(seen).toEqual([{ userId: null, expired: false }]);
  });

  it('an expiry keeps the owner signed in (it was not a sign-out), so an offline start can use it', async () => {
    const { owner, inner, auth } = await setup({ initial: A });
    const seen: unknown[] = [];
    auth.onSessionChange((s) => seen.push(s));
    inner.expire();
    expect(seen).toEqual([{ userId: null, expired: true }]);
    expect(await owner.signedInOwner()).toBe(A);
  });

  it('listeners hear about a sign-in only once the owner was recorded', async () => {
    const { db, inner, auth } = await setup();
    inner.setSignInUser(A);
    const seen: string[] = [];
    auth.onSessionChange(async (s) => seen.push(`${s.userId}:${String(await db.getMeta(OWNER_USER_ID))}`));
    await auth.signIn('a@b.c', 'pw');
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toBe(`${A}:${A}`);
  });
});

const B = '00000000-0000-4000-8000-00000000000b';

describe('account switch on one browser (F3)', () => {
  async function asOwnerA() {
    const s = await setup({ initial: A });
    const repo = createRepo(s.db, { userId: () => A });
    return { ...s, repo };
  }

  it('the same user signing in again keeps everything', async () => {
    const { db, inner, auth, repo } = await asOwnerA();
    await repo.create('todos', { title: 'mine' });
    await auth.signOut();
    inner.setSignInUser(A);
    expect(await auth.signIn('a@b.c', 'pw')).toEqual({ ok: true });
    expect(await repo.pendingCount()).toBe(1);
    expect(await db.getMeta(OWNER_USER_ID)).toBe(A);
  });

  it('another user with an empty queue: local records (todos and events), cursor and export date are wiped, db_id kept, new owner set', async () => {
    const { db, inner, auth } = await asOwnerA();
    // A's synced record and cursor (nothing queued).
    await db.raw.put('todos', { id: 'r1', user_id: A, title: 'A private', rev: 5, deleted_at: null, purged_at: null });
    await db.raw.put('events', { id: 'e1', user_id: A, title: 'A meeting', rev: 6, deleted_at: null, purged_at: null });
    await db.setMeta('cursor', 5);
    await db.setMeta('last_export_at', '2026-11-01T00:00:00.000Z');
    const dbId = await db.getMeta('db_id');
    await auth.signOut();
    inner.setSignInUser(B);
    expect(await auth.signIn('b@b.c', 'pw')).toEqual({ ok: true });
    expect(auth.getUserId()).toBe(B);
    expect(await db.raw.getAll('todos')).toEqual([]);
    expect(await db.raw.getAll('events')).toEqual([]);
    expect(await db.raw.getAll('queue')).toEqual([]);
    expect(await db.getMeta('cursor')).toBe(0);
    expect(await db.getMeta('last_export_at')).toBeUndefined();
    expect(await db.getMeta('db_id')).toBe(dbId);
    expect(await db.getMeta(OWNER_USER_ID)).toBe(B);
    expect(await db.getMeta(OWNER_SIGNED_IN)).toBe(true);
  });

  it('another user while the queue holds ops (pending or failed): refused and signed out again, nothing touched', async () => {
    const { db, inner, auth, repo } = await asOwnerA();
    const r = await repo.create('todos', { title: 'unsynced' });
    const [op] = (await db.raw.getAll('queue')) as QueuedOp[];
    const { seq: _seq, ...rest } = op;
    await db.raw.add('queue', { ...rest, op_id: 'failed-one', failed: { reason: 'x' } });
    await auth.signOut();
    const seen: unknown[] = [];
    auth.onSessionChange((s) => seen.push(s));
    inner.setSignInUser(B);
    expect(await auth.signIn('b@b.c', 'pw')).toEqual({ ok: false, reason: 'other_account', pending: 2 });
    expect(auth.getUserId()).toBeNull();
    expect(inner.getUserId()).toBeNull();
    expect(seen).not.toContainEqual(expect.objectContaining({ userId: B }));
    expect(await repo.get('todos', r.id)).toBeDefined();
    expect(await db.raw.getAll('queue')).toHaveLength(2);
    expect(await db.getMeta(OWNER_USER_ID)).toBe(A);
  });

  it('a sign-in with no owner stored adopts the user', async () => {
    const { db, inner, auth } = await setup();
    await db.raw.put('todos', { id: 'legacy', user_id: B, title: 'kept', rev: 1, deleted_at: null, purged_at: null });
    inner.setSignInUser(B);
    expect(await auth.signIn('b@b.c', 'pw')).toEqual({ ok: true });
    expect(await db.raw.getAll('todos')).toHaveLength(1);
    expect(await db.getMeta(OWNER_USER_ID)).toBe(B);
  });
});

describe('sign-out is recorded before the slow auth call (bug: closed during a ~25 s offline sign-out)', () => {
  /** An inner whose signOut hangs until released, like auth-js offline with an expired token. */
  async function withSlowSignOut() {
    const s = await setup({ initial: A });
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const realSignOut = s.inner.signOut.bind(s.inner);
    s.inner.signOut = async () => {
      await slow;
      await realSignOut();
    };
    return { ...s, release };
  }

  it('the flag is false and the app is told before inner.signOut resolves', async () => {
    const { db, owner, auth, release } = await withSlowSignOut();
    const seen: unknown[] = [];
    auth.onSessionChange((x) => seen.push(x));
    const p = auth.signOut();
    await vi.waitFor(async () => expect(await db.getMeta(OWNER_SIGNED_IN)).toBe(false));
    expect(await owner.signedInOwner()).toBeNull();
    expect(auth.getUserId()).toBeNull();
    expect(seen).toEqual([{ userId: null, expired: false }]);
    release();
    await p;
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([{ userId: null, expired: false }]); // the later SIGNED_OUT event adds nothing
  });

  it('a fresh offline boot after that does not open as the owner', async () => {
    const { owner, auth } = await withSlowSignOut();
    void auth.signOut(); // never released: the app is closed during the wait
    await vi.waitFor(async () => expect(await owner.signedInOwner()).toBeNull());
    const offline = {
      auth: {
        getSession: async () => ({ data: { session: null }, error: new AuthRetryableFetchError('Failed to fetch', 0) }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      },
    } as unknown as SupabaseClient;
    const boot = createSupabaseAuth(offline, { offlineUserId: () => owner.signedInOwner(), readyTimeoutMs: 50 });
    await boot.ready;
    expect(boot.getUserId()).toBeNull();
  });

  it('still signs out when recording fails', async () => {
    const { owner, inner, auth } = await setup({ initial: A });
    owner.signedOut = async () => {
      throw new Error('disk full');
    };
    await auth.signOut();
    expect(inner.getUserId()).toBeNull();
    expect(auth.getUserId()).toBeNull();
  });
});

describe('sign-in and sign-out overlapping', () => {
  async function slow() {
    const s = await setup({ initial: A });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const real = s.inner.signOut.bind(s.inner);
    s.inner.signOut = async () => {
      await gate;
      await real();
    };
    return { ...s, release };
  }

  it('a sign-in during a slow sign-out waits for it and ends up signed in', async () => {
    const { inner, auth, release } = await slow();
    const seen: unknown[] = [];
    auth.onSessionChange((x) => seen.push(x));
    const out = auth.signOut();
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    inner.setSignInUser(A);
    const inn = auth.signIn('a@b.c', 'pw');
    release();
    await out;
    expect(await inn).toEqual({ ok: true });
    await vi.waitFor(() => expect(auth.getUserId()).toBe(A));
    expect(seen).toEqual([{ userId: null, expired: false }, { userId: A, expired: false }]);
  });

  it('two concurrent sign-outs emit once', async () => {
    const { auth, release } = await slow();
    const seen: unknown[] = [];
    auth.onSessionChange((x) => seen.push(x));
    const a = auth.signOut();
    const b = auth.signOut();
    release();
    await Promise.all([a, b]);
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([{ userId: null, expired: false }]);
  });
});
