import type { LocalDb } from '../data/local-db';

export const EXPORT_REMINDER_DAYS = 7;
const META_KEY = 'last_export_at';

/** True when there is no (readable) last export, or it is strictly more than 7 days old. */
export function shouldRemindExport(lastExportAt: string | null, now: Date): boolean {
  if (lastExportAt === null) return true;
  const last = Date.parse(lastExportAt);
  if (Number.isNaN(last)) return true;
  return now.getTime() - last > EXPORT_REMINDER_DAYS * 24 * 60 * 60 * 1000;
}

export async function recordExport(db: LocalDb, now: () => Date = () => new Date()): Promise<void> {
  await db.setMeta(META_KEY, now().toISOString());
}
