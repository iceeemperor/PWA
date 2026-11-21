import { useEffect, useRef, useState } from 'react';
import type { Repo } from '../data/repo';
import type { SyncEngine, SyncStatus } from '../sync/engine';

/**
 * The engine's status with the queue counts read from the local database. The engine only recounts during a run,
 * so local writes (Repo.onChange) are recounted here too: the pending count must show right after a write (spec 8.3).
 * `loaded` is false until the first count has been read.
 */
export function useSyncStatus(repo: Pick<Repo, 'pendingCount' | 'failedOps' | 'onChange'>, engine: Pick<SyncEngine, 'status' | 'subscribe'>) {
  const [status, setStatus] = useState<SyncStatus>(() => engine.status());
  const [loaded, setLoaded] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    let live = true;
    const refresh = async () => {
      const mine = ++seq.current;
      try {
        const [pending, failed] = await Promise.all([repo.pendingCount(), repo.failedOps()]);
        // A later refresh already started: its counts are newer.
        if (!live || mine !== seq.current) return;
        setStatus({ ...engine.status(), pending, failed: failed.length });
        setLoaded(true);
      } catch {
        if (live && mine === seq.current) setStatus(engine.status());
      }
    };
    void refresh();
    const offRepo = repo.onChange(() => void refresh());
    const offEngine = engine.subscribe(() => void refresh());
    return () => {
      live = false;
      offRepo();
      offEngine();
    };
  }, [repo, engine]);

  return { status, loaded };
}
