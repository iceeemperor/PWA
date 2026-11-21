import type { ImportSummary } from '../domain/types';
import type { CloudClient } from '../sync/cloud';
import { parseAndValidateBackup } from './validate';

export type ImportResult = { ok: true; summary: ImportSummary } | { ok: false; errors: string[] };

/**
 * Checks the whole file first (spec 7.2): if anything fails, the errors come back and the cloud is never called.
 * Otherwise the server's import_backup writes it in one transaction and its summary is returned.
 * A failed cloud call is not a validation result: its CloudError is thrown for the caller to show.
 */
export async function importBackup(cloud: CloudClient, text: string, o: { restorePurged: boolean }): Promise<ImportResult> {
  const checked = parseAndValidateBackup(text);
  if (!checked.ok) return { ok: false, errors: checked.errors };
  return { ok: true, summary: await cloud.importBackup(checked.backup, o.restorePurged) };
}
