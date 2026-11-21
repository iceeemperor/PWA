import type { LocalDb } from '../data/local-db';
import {
  BACKUP_FORMAT,
  BACKUP_TABLE_KEYS,
  BACKUP_VERSION,
  TABLES,
  type BackupFile,
  type BackupTableKey,
  type TableName,
} from '../domain/types';

const STRIPPED = ['user_id', 'rev', 'purged_at'] as const;

/** Full backup of the local database: trashed records included, tombstones left out. */
export async function buildBackup(db: LocalDb, now: () => Date = () => new Date()): Promise<BackupFile> {
  const tables = {} as Record<BackupTableKey, Record<string, unknown>[]>;
  for (const key of BACKUP_TABLE_KEYS) tables[key] = [];

  for (const table of TABLES as readonly TableName[]) {
    const rows = (await db.raw.getAll(table)) as Record<string, unknown>[];
    tables[table] = rows
      .filter((row) => row.purged_at == null)
      .map((row) => {
        const copy = { ...row };
        for (const field of STRIPPED) delete copy[field];
        return copy;
      });
  }

  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exported_at: now().toISOString(), tables };
}
