import type { Repo } from '../data/repo';
import type { CloudClient } from './cloud';
import type { SyncEngine } from './engine';

const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 300000;
const DEBOUNCE_MS = 2000;

/** Delay before the retry that follows `failures` earlier retries: 2000, 4000, 8000 ... capped at 300000 ms. */
export function nextRetryDelay(failures: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** failures, RETRY_MAX_MS);
}

export interface SyncTriggerDeps {
  engine: SyncEngine;
  repo: Pick<Repo, 'onChange'>;
  win?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  doc?: Pick<Document, 'addEventListener' | 'removeEventListener'> & { visibilityState: string };
  debounceMs?: number;
  /** When set, `purgeExpired()` is called once after the first successful sync; its errors are swallowed. */
  purgeOnStart?: CloudClient;
}

/** Starts the sync triggers (start-up, local writes, page visible, network back, retry). Returns the stop function. */
export function startSyncTriggers(d: SyncTriggerDeps): () => void {
  const win = d.win ?? (typeof window !== 'undefined' ? window : undefined);
  const doc = d.doc ?? (typeof document !== 'undefined' ? document : undefined);
  const debounceMs = d.debounceMs ?? DEBOUNCE_MS;

  let stopped = false;
  let failures = 0;
  let purged = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  function clearRetry(): void {
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
  }

  function clearDebounce(): void {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = undefined;
  }

  function run(): void {
    // A fresh run supersedes a pending retry, so retries never pile up.
    clearRetry();
    d.engine.sync().then(
      (report) => settle(report.outcome),
      () => settle('offline'), // engine.sync() normally resolves; a local failure is retried like offline
    );
  }

  function settle(outcome: 'ok' | 'offline' | 'auth_expired' | 'unavailable'): void {
    if (stopped) return;
    if (outcome === 'ok') {
      failures = 0;
      if (d.purgeOnStart && !purged) {
        purged = true;
        void Promise.resolve()
          .then(() => d.purgeOnStart!.purgeExpired())
          .catch(() => {});
      }
    } else if (outcome === 'offline' || outcome === 'unavailable') {
      clearRetry();
      retryTimer = setTimeout(run, nextRetryDelay(failures));
      failures++;
    }
  }

  const onChange = (): void => {
    clearDebounce();
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      run();
    }, debounceMs);
  };
  const onVisibility = (): void => {
    if (doc?.visibilityState === 'visible') run();
  };
  const onOnline = (): void => run();

  const unsubscribe = d.repo.onChange(onChange);
  doc?.addEventListener('visibilitychange', onVisibility);
  win?.addEventListener('online', onOnline);
  run();

  return () => {
    stopped = true;
    clearDebounce();
    clearRetry();
    unsubscribe();
    doc?.removeEventListener('visibilitychange', onVisibility);
    win?.removeEventListener('online', onOnline);
  };
}
