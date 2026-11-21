import { CloudError, type CloudClient, type CloudErrorKind } from '../../src/sync/cloud';
import type { PullPage, PushOp, PushResult } from '../../src/domain/types';
import type { TestDb } from '../db/harness';

// Every call signs in as its user and then runs one SQL function. Several clients (devices) can share
// one TestDb, and "sign in" is a session setting, so calls on the same TestDb are run one at a time:
// otherwise device B could sign in between device A's sign-in and A's query.
const chains = new WeakMap<TestDb, Promise<unknown>>();

function serial<T>(t: TestDb, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(t) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(t, next.catch(() => {}));
  return next;
}

// SQLSTATE classes the SQL functions use, as the kinds a real client would report.
function kindOf(e: unknown): CloudErrorKind {
  const code = (e as { code?: unknown } | null)?.code;
  const message = e instanceof Error ? e.message : String(e);
  if (code === '28000' || code === '42501' || /not_authenticated|permission denied/.test(message)) return 'auth';
  if (typeof code === 'string' && (code.startsWith('22') || code.startsWith('23') || code === '42P01')) return 'rejected';
  return 'unavailable';
}

async function call<T>(t: TestDb, uid: string, sql: string, params: unknown[], pick: (r: any) => T): Promise<T> {
  return serial(t, async () => {
    try {
      await t.asUser(uid);
      const res = await t.pg.query<{ r: unknown }>(sql, params);
      return pick(res.rows[0]?.r);
    } catch (e) {
      if (e instanceof CloudError) throw e;
      throw new CloudError(kindOf(e), e instanceof Error ? e.message : String(e), { cause: e });
    }
  });
}

/** A CloudClient backed by the SQL functions in the in-process test database, signed in as `uid`. */
export function createPgliteCloud(t: TestDb, uid: string): CloudClient {
  return {
    push(op: PushOp) {
      const { table, ...rest } = op;
      return call(t, uid, 'select push_change($1, $2::jsonb) as r', [table, JSON.stringify({ ...rest, table })],
        (r) => r as PushResult);
    },
    pull(sinceRev: number, limit: number) {
      return call(t, uid, 'select pull_changes($1, $2) as r', [sinceRev, limit], (r) => r as PullPage);
    },
    purgeExpired() {
      return call(t, uid, 'select purge_expired() as r', [], () => undefined);
    },
    async importBackup() {
      throw new Error('import_backup not implemented until Task 13');
    },
  };
}
