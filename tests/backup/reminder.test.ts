import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openLocalDb, type LocalDb } from '../../src/data/local-db';
import { recordExport, shouldRemindExport } from '../../src/backup/reminder';

const NOW = new Date('2026-11-05T00:00:00Z');
let dbCount = 0;
let db: LocalDb;
beforeEach(async () => {
  db = await openLocalDb(`reminder-test-${++dbCount}`);
});
afterEach(() => db.close());

describe('shouldRemindExport', () => {
  it('reminds when never exported', () => expect(shouldRemindExport(null, NOW)).toBe(true));
  it('does not remind at exactly 7 days but does after', () => {
    expect(shouldRemindExport('2026-10-29T00:00:00Z', new Date('2026-11-05T00:00:00Z'))).toBe(false);
    expect(shouldRemindExport('2026-10-29T00:00:00Z', new Date('2026-11-05T00:00:01Z'))).toBe(true);
  });
  it('does not remind for a recent export', () => {
    expect(shouldRemindExport('2026-11-04T00:00:00Z', NOW)).toBe(false);
  });
  it('treats an unparseable date as never exported', () => {
    expect(shouldRemindExport('not a date', NOW)).toBe(true);
  });
});

describe('recordExport', () => {
  it('stores last_export_at', async () => {
    await recordExport(db, () => new Date('2026-11-05T00:00:00Z'));
    expect(await db.getMeta('last_export_at')).toBe('2026-11-05T00:00:00.000Z');
  });
  it('round-trips with shouldRemindExport', async () => {
    await recordExport(db, () => new Date('2026-10-29T00:00:00Z'));
    const last = (await db.getMeta<string>('last_export_at')) ?? null;
    expect(shouldRemindExport(last, new Date('2026-11-05T00:00:00Z'))).toBe(false);
    expect(shouldRemindExport(last, new Date('2026-11-05T00:00:01Z'))).toBe(true);
  });
});
