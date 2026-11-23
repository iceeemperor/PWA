import { useEffect, useState } from 'react';
import type { Repo } from '../data/repo';
import type { RecordOf, TableName } from '../domain/types';
import type { SyncEngine } from '../sync/engine';

/**
 * The table's records, read again after every local write (Repo.onChange) and every sync event (engine.subscribe):
 * a sync run writes pulled records without Repo.onChange (stage 1 ruling), so its events are how a list learns of
 * them. Empty until the first read. A read that fails keeps the last list.
 */
export function useLiveRecords<T extends TableName>(
  repo: Pick<Repo, 'list' | 'onChange'>,
  engine: Pick<SyncEngine, 'subscribe'>,
  t: T,
  o?: { trashed?: boolean },
): RecordOf<T>[] {
  const [records, setRecords] = useState<RecordOf<T>[]>([]);
  const trashed = o?.trashed === true;

  useEffect(() => {
    let live = true;
    let seq = 0;
    const reload = async () => {
      const mine = ++seq;
      try {
        const list = await repo.list(t, { trashed });
        // A later read already started: its list is newer.
        if (live && mine === seq) setRecords(list);
      } catch (e) {
        console.error(`Could not read ${t}`, e);
      }
    };
    void reload();
    const offRepo = repo.onChange(() => void reload());
    const offEngine = engine.subscribe(() => void reload());
    return () => {
      live = false;
      offRepo();
      offEngine();
    };
  }, [repo, engine, t, trashed]);

  return records;
}
