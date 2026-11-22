import { describe, expect, it, vi } from 'vitest';
import { createOwnedAuth } from '../../src/auth/owned-auth';
import { openLocalDb, type LocalDb } from '../../src/data/local-db';
import { createOwnerStore, OWNER_SIGNED_IN, OWNER_USER_ID } from '../../src/data/owner';
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
