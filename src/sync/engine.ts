import type { IDBPTransaction } from 'idb';
import type { LocalDb } from '../data/local-db';
import { defaultsOf } from '../domain/tables';
import { TABLES, type PullPage, type PushOp, type PushResult, type QueuedOp, type TableName } from '../domain/types';
import { CloudError, type CloudClient, type CloudErrorKind } from './cloud';

/** Pull starts this many revs before the cursor (spec 8.1), so commits that landed out of order are not missed. */
export const PULL_REWIND = 100;
/** Rows per pull page. */
export const PULL_PAGE = 500;

export interface SyncReport {
  outcome: 'ok' | 'offline' | 'auth_expired' | 'unavailable';
  pushed: number;
  dropped: number;
  failed: number;
  pulled: number;
  conflicts: number;
}

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'offline' | 'auth_expired' | 'unavailable';
  /** Queued ops waiting to be uploaded (failed ones excluded). */
  pending: number;
  /** Ops the server refused; they wait for the user. */
  failed: number;
  /** When a run last finished with outcome 'ok'. */
  lastSyncedAt: string | null;
  /** Conflicts the last run reported. */
  conflicts: number;
}

export interface SyncDeps {
  db: LocalDb;
  cloud: CloudClient;
  /** Cross-tab lock (navigator.locks in the app). Without one, runs are only single-flight within this engine. */
  locks?: Pick<LockManager, 'request'>;
  pageSize?: number;
}

export interface SyncEngine {
  /**
   * Pushes the queue, then (if the push was not stopped) pulls every page. A call while a run is going gets one
   * follow-up run after it (shared by every call made during that run), so whatever was queued or reached the cloud
   * before the call is covered; it gets the first run's report instead when that run did not end ok.
   */
  sync(): Promise<SyncReport>;
  status(): SyncStatus;
  /** `fn` is called on every status change and after every run. Returns the unsubscribe function. */
  subscribe(fn: (s: SyncStatus) => void): () => void;
}


const QUEUE = 'queue';
const META = 'meta';
const CURSOR = 'cursor';
const LOCK_NAME = 'pa-sync';

type Stored = Record<string, unknown> & { id: string; rev: number; deleted_at: string | null; purged_at: string | null };
type WriteTx = IDBPTransaction<unknown, string[], 'readwrite'>;

// Cloud failures that end the run with the queue untouched.
const STOPS: Record<Exclude<CloudErrorKind, 'rejected'>, SyncReport['outcome']> = {
  network: 'offline',
  auth: 'auth_expired',
  unavailable: 'unavailable',
};

/** A server record as the local copy: deleted_at and purged_at always present (the Repo reads a missing key as set). */
function asLocal(rec: Record<string, unknown>): Stored {
  return { ...rec, rev: Number(rec.rev), deleted_at: (rec.deleted_at ?? null) as string | null, purged_at: (rec.purged_at ?? null) as string | null } as Stored;
}

/**
 * The pulled server record with the record's pending ops laid on top in seq order, so local edits not yet pushed
 * stay visible. Insert/update ops bring their `fields`; delete/restore ops carry no fields (Repo queues `{}`), so
 * the last of them decides deleted_at: restore → null, delete → the user's local trash time (else the server's,
 * else now). That matches settleApplied: while a delete/restore is queued, local deleted_at is the user's intent.
 * rev, purged_at and id always stay the server's.
 */
function overlay(server: Stored, local: Stored | undefined, ops: QueuedOp[]): Stored {
  const merged: Stored = { ...server };
  let trash: 'delete' | 'restore' | undefined;
  for (const op of ops) {
    if (op.kind === 'insert' || op.kind === 'update') Object.assign(merged, op.fields);
    else trash = op.kind;
  }
  if (trash === 'restore') merged.deleted_at = null;
  if (trash === 'delete') merged.deleted_at = local?.deleted_at ?? server.deleted_at ?? new Date().toISOString();
  merged.id = server.id;
  merged.rev = server.rev;
  merged.purged_at = server.purged_at;
  return merged;
}

function toPushOp(op: QueuedOp): PushOp {
  return { op_id: op.op_id, table: op.table, id: op.id, kind: op.kind, base_rev: op.base_rev, fields: op.fields };
}

export function createSyncEngine(deps: SyncDeps): SyncEngine {
  const { db } = deps;
  const listeners = new Set<(s: SyncStatus) => void>();
  let current: SyncStatus = { state: 'idle', pending: 0, failed: 0, lastSyncedAt: null, conflicts: 0 };
  let running: Promise<SyncReport> | null = null;
  // The run promised to the calls that arrived while `running` was going.
  let followUp: Promise<SyncReport> | null = null;

  function setStatus(patch: Partial<SyncStatus>): void {
    current = { ...current, ...patch };
    const snapshot = current;
    for (const fn of [...listeners]) {
      try {
        fn(snapshot);
      } catch (e) {
        console.error('SyncEngine subscriber failed', e);
      }
    }
  }

  async function counts(): Promise<Pick<SyncStatus, 'pending' | 'failed'>> {
    const queued: QueuedOp[] = await db.raw.getAll(QUEUE);
    const failed = queued.filter((op) => op.failed !== null).length;
    return { pending: queued.length - failed, failed };
  }

  // Fill in the queue counts once at start-up; a run that has begun reports its own.
  void counts().then(
    (c) => { if (!running) setStatus(c); },
    () => {},
  );

  /** The first not-failed queued op after `afterSeq`, in seq order. */
  async function nextOp(afterSeq: number): Promise<QueuedOp | undefined> {
    const tx = db.raw.transaction(QUEUE, 'readonly');
    let cursor = await tx.store.openCursor(IDBKeyRange.lowerBound(afterSeq, true));
    while (cursor) {
      const op = cursor.value as QueuedOp;
      if (op.failed === null) return op;
      cursor = await cursor.continue();
    }
    return undefined;
  }

  /** Runs `body` in one transaction over the op's table and the queue. */
  async function inTx(table: TableName, body: (tx: WriteTx) => Promise<void>): Promise<void> {
    const tx = db.raw.transaction([table, QUEUE], 'readwrite');
    tx.done.catch(() => {});
    try {
      await body(tx);
      await tx.done;
    } catch (e) {
      try { tx.abort(); } catch { /* already finished */ }
      await tx.done.catch(() => {});
      throw e;
    }
  }

  /**
   * Removes the pushed op, moves later ops of the same record onto the returned rev, and updates the local copy:
   * the whole server record when nothing else is queued for it, otherwise only the server-owned columns
   * (deleted_at stays local while a queued delete or restore for the record is still to come),
   * so newer local edits stay visible until they are pushed too.
   */
  function settleApplied(op: QueuedOp, res: PushResult): Promise<void> {
    return inTx(op.table, async (tx) => {
      const queue = tx.objectStore(QUEUE);
      await queue.delete(op.seq);
      let othersPending = false;
      // A queued delete or restore still to come decides the trash state locally, not the server.
      let trashStatePending = false;
      let cursor = await queue.openCursor(IDBKeyRange.lowerBound(op.seq, true));
      while (cursor) {
        const later = cursor.value as QueuedOp;
        if (later.table === op.table && later.id === op.id) {
          if (later.failed === null) {
            othersPending = true;
            if (later.kind === 'delete' || later.kind === 'restore') trashStatePending = true;
          }
          // Never lower: a replayed (stale) result can carry an older rev than the op already saw.
          if (later.kind !== 'insert' && res.rev !== null && (later.base_rev === null || later.base_rev < res.rev)) {
            await cursor.update({ ...later, base_rev: res.rev });
          }
        }
        cursor = await cursor.continue();
      }

      const rec = res.record;
      if (!rec) return;
      const store = tx.objectStore(op.table);
      const local = (await store.get(op.id)) as Stored | undefined;
      const server = asLocal(rec);
      // A tombstone stays a tombstone; and a replayed (stale) result never takes the local copy backwards.
      if (local && (local.purged_at !== null || local.rev > server.rev)) return;
      if (!local || !othersPending) {
        await store.put(server);
      } else {
        await store.put({
          ...local,
          rev: server.rev,
          updated_at: server.updated_at,
          deleted_at: trashStatePending ? local.deleted_at : server.deleted_at,
          purged_at: server.purged_at,
        });
      }
    });
  }

  /** Removes the op and turns the local copy into a tombstone: content back to the defaults, purged_at set. */
  function settlePurged(op: QueuedOp, res: PushResult): Promise<void> {
    return inTx(op.table, async (tx) => {
      await tx.objectStore(QUEUE).delete(op.seq);
      const store = tx.objectStore(op.table);
      const local = (await store.get(op.id)) as Stored | undefined;
      const server = res.record ? asLocal(res.record) : undefined;
      const base = server ?? local;
      if (!base) return;
      const at = new Date().toISOString();
      await store.put({
        ...base,
        // What a purge leaves in the content columns: the SQL column defaults.
        ...defaultsOf(op.table),
        rev: Math.max(base.rev, local?.rev ?? 0),
        purged_at: server?.purged_at ?? at,
        deleted_at: server?.deleted_at ?? local?.deleted_at ?? at,
      });
    });
  }

  /** Marks the op failed; it stays in the queue for the user and is skipped by later runs. */
  function settleFailed(op: QueuedOp, reason: string): Promise<void> {
    return inTx(op.table, async (tx) => {
      const queue = tx.objectStore(QUEUE);
      const stored = (await queue.get(op.seq)) as QueuedOp | undefined;
      if (stored) await queue.put({ ...stored, failed: { reason } });
    });
  }

  /**
   * Applies one pull page and moves the cursor, in ONE transaction over every table, the queue and meta, so the
   * cursor never gets ahead of (or behind) the records it stands for. Only IndexedDB requests are awaited inside.
   * Returns how many rows were applied, and how many pending ops a pulled tombstone discarded.
   */
  async function applyPage(page: PullPage, pageMaxRev: number): Promise<{ applied: number; dropped: number }> {
    const tx = db.raw.transaction([...TABLES, QUEUE, META], 'readwrite');
    tx.done.catch(() => {});
    try {
      const queue = tx.objectStore(QUEUE);
      // Pending (not failed) ops per record, in seq order (getAll returns key order).
      const pending = new Map<string, QueuedOp[]>();
      for (const op of (await queue.getAll()) as QueuedOp[]) {
        if (op.failed !== null) continue;
        const key = `${op.table}\u0000${op.id}`;
        const list = pending.get(key);
        if (list) list.push(op);
        else pending.set(key, [op]);
      }

      let applied = 0;
      let dropped = 0;
      for (const { table, row } of page.rows) {
        if (!(TABLES as readonly string[]).includes(table)) continue;
        const store = tx.objectStore(table);
        const server = asLocal(row);
        const local = (await store.get(server.id)) as Stored | undefined;
        if (local && server.rev <= local.rev) continue;
        const key = `${table}\u0000${server.id}`;
        const ops = pending.get(key) ?? [];
        if (server.purged_at !== null) {
          // A tombstone wins over anything still queued for the record.
          for (const op of ops) await queue.delete(op.seq);
          // The user is told these edits were lost to a purge (spec 8.2, 已被永久清除).
          dropped += ops.length;
          pending.delete(key);
          await store.put(server);
        } else if (ops.length > 0) {
          await store.put(overlay(server, local, ops));
        } else {
          await store.put(server);
        }
        applied++;
      }

      const meta = tx.objectStore(META);
      const cursor = Number((await meta.get(CURSOR)) ?? 0);
      if (pageMaxRev > cursor) await meta.put(pageMaxRev, CURSOR);
      await tx.done;
      return { applied, dropped };
    } catch (e) {
      try { tx.abort(); } catch { /* already finished */ }
      await tx.done.catch(() => {});
      throw e;
    }
  }

  /** Pulls every page after the rewound cursor. Returns the stop outcome, or null when it went through. */
  async function pull(report: SyncReport): Promise<SyncReport['outcome'] | null> {
    const limit = deps.pageSize ?? PULL_PAGE;
    const cursor = Number((await db.getMeta<number>(CURSOR)) ?? 0);
    let since = Math.max(0, cursor - PULL_REWIND);
    for (;;) {
      let page: PullPage;
      try {
        page = await deps.cloud.pull(since, limit);
      } catch (e) {
        if (!(e instanceof CloudError)) return 'offline';
        // A pull has nothing the user could fix; a refused one is treated as the cloud not serving.
        return e.kind === 'rejected' ? 'unavailable' : STOPS[e.kind];
      }
      const pageMaxRev = page.rows.reduce((m, r) => Math.max(m, Number(r.row.rev)), since);
      const done = await applyPage(page, pageMaxRev);
      report.pulled += done.applied;
      report.dropped += done.dropped;
      // An empty page cannot move `since`; stop rather than ask for the same page forever.
      if (!page.has_more || page.rows.length === 0) return null;
      since = pageMaxRev;
    }
  }

  async function run(): Promise<SyncReport> {
    const report: SyncReport = { outcome: 'ok', pushed: 0, dropped: 0, failed: 0, pulled: 0, conflicts: 0 };
    setStatus({ state: 'syncing', ...(await counts()) });

    let afterSeq = 0;
    for (let op = await nextOp(afterSeq); op; op = await nextOp(afterSeq)) {
      afterSeq = op.seq;
      let res: PushResult;
      try {
        res = await deps.cloud.push(toPushOp(op));
      } catch (e) {
        if (e instanceof CloudError && e.kind === 'rejected') {
          await settleFailed(op, e.message || 'rejected');
          report.failed++;
          continue;
        }
        // Anything else that is not a CloudError (a fetch TypeError, say) counts as a network problem.
        report.outcome = e instanceof CloudError ? STOPS[e.kind as keyof typeof STOPS] : 'offline';
        break;
      }

      switch (res.status) {
        case 'applied':
          await settleApplied(op, res);
          report.pushed++;
          if (res.conflict) report.conflicts++;
          break;
        case 'dropped_trashed':
          await settleApplied(op, res);
          report.dropped++;
          break;
        case 'dropped_purged':
          await settlePurged(op, res);
          report.dropped++;
          break;
        default:
          await settleFailed(op, res.message ?? 'invalid');
          report.failed++;
      }
    }

    // Pull only after a push run that reached the end of the queue (failed ops do not stop it).
    if (report.outcome === 'ok') {
      const stopped = await pull(report);
      if (stopped) report.outcome = stopped;
    }

    // Engine writes do not go through Repo.onChange: this status update is how listeners learn of them.
    setStatus({
      state: report.outcome === 'ok' ? 'idle' : report.outcome,
      ...(await counts()),
      conflicts: report.conflicts,
      ...(report.outcome === 'ok' ? { lastSyncedAt: new Date().toISOString() } : {}),
    });
    return report;
  }

  async function guarded(): Promise<SyncReport> {
    try {
      if (deps.locks) return (await deps.locks.request(LOCK_NAME, () => run())) as SyncReport;
      return await run();
    } catch (e) {
      // A local failure (IndexedDB) ends the run; the queue is whatever was committed so far.
      setStatus({ state: 'idle', ...(await counts().catch(() => ({}))) });
      throw e;
    } finally {
      running = null;
    }
  }

  return {
    sync() {
      if (!running) return (running = guarded());
      followUp ??= running.then(
        (report) => {
          followUp = null;
          // A stopped run (offline, expired ...) would stop again; the triggers retry it.
          if (report.outcome !== 'ok') return report;
          return (running ??= guarded());
        },
        (e: unknown) => {
          followUp = null;
          throw e;
        },
      );
      return followUp;
    },
    status: () => current,
    subscribe(fn) {
      const listener = (s: SyncStatus) => fn(s);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
