import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBackup } from '../../src/backup/export-json';
import { importBackup } from '../../src/backup/import';
import type { LocalDb } from '../../src/data/local-db';
import type { BackupFile, ImportSummary } from '../../src/domain/types';
import { CloudError, type CloudClient } from '../../src/sync/cloud';
import { createTestDb, TEST_USER_A, TEST_USER_B, type TestDb } from '../db/harness';
import { createDevice, type Device } from '../helpers/device';
import { createPgliteCloud } from '../helpers/pglite-cloud';

// Two separate cloud databases: account A where the backup is made, and an empty account B on another
// project (the same ids under another user in one database would be "exists").
let tA: TestDb;
let tB: TestDb;
let cloudA: CloudClient;
let cloudB: CloudClient;
let cloud: CloudClient;
let opened: LocalDb[];

beforeEach(async () => {
  opened = [];
  tA = await createTestDb();
  tB = await createTestDb();
  cloudA = createPgliteCloud(tA, TEST_USER_A);
  cloudB = createPgliteCloud(tB, TEST_USER_B);
  cloud = cloudB;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of opened) db.close();
  await tA.pg.close();
  await tB.pg.close();
});

async function device(name: string, c: CloudClient): Promise<Device> {
  const d = await createDevice({ name, cloud: c, userId: c === cloudA ? TEST_USER_A : TEST_USER_B });
  opened.push(d.db);
  return d;
}

/** What a backup of the device would contain, without exported_at. */
async function exportable(d: Device): Promise<BackupFile['tables']> {
  return (await buildBackup(d.db)).tables;
}

/** Device a with one live todo and one in the trash, synced to account A; resolves to the backup text. */
async function exportFromA(): Promise<{ a: Device; text: string }> {
  const a = await device('a', cloudA); await a.repo.create('todos', { title: 'one' }); const t2 = await a.repo.create('todos', { title: 'two', priority: 'high' }); await a.repo.remove('todos', t2.id); await a.engine.sync();
  return { a, text: JSON.stringify(await buildBackup(a.db)) };
}

describe('importBackup: the brief', () => {
  it('returns validation errors and never calls the cloud for a bad file', async () => {
    const spy = vi.spyOn(cloud, 'importBackup'); expect(await importBackup(cloud, '<html>', { restorePurged: false })).toMatchObject({ ok: false }); expect(spy).not.toHaveBeenCalled();
  });
  it('round trip: export from one device, import into an empty account, sync another device, get identical data', async () => {
    const a = await device('a', cloudA); await a.repo.create('todos', { title: 'one' }); const t2 = await a.repo.create('todos', { title: 'two', priority: 'high' }); await a.repo.remove('todos', t2.id); await a.engine.sync();
    const text = JSON.stringify(await buildBackup(a.db)); const res = await importBackup(cloudB, text, { restorePurged: false });
    expect(res).toMatchObject({ ok: true, summary: { added: 2 } }); const c = await device('c', cloudB); await c.engine.sync();
    expect(await exportable(c)).toEqual(await exportable(a));
  });
  it('round trip with events: export from one device, import into an empty account, sync another device, same data', async () => {
    const a = await device('a', cloudA);
    await a.repo.create('todos', { title: 'one' });
    const ev = await a.repo.create('events', { title: 'call', all_day: false, starts_at: '2026-11-23T09:00', ends_at: '2026-11-23T10:00', tz: 'Asia/Shanghai', important: true });
    const gone = await a.repo.create('events', { title: 'old', starts_at: '2026-11-20' });
    await a.repo.remove('events', gone.id);
    await a.engine.sync();
    const text = JSON.stringify(await buildBackup(a.db));
    const res = await importBackup(cloudB, text, { restorePurged: false });
    expect(res).toMatchObject({ ok: true, summary: { added: 3 } });
    const c = await device('c', cloudB); await c.engine.sync();
    const tables = await exportable(c);
    expect(tables.events.map((r) => r.id).sort()).toEqual([ev.id, gone.id].sort());
    expect(tables).toEqual(await exportable(a));
  });
  it('importing the same file twice skips everything the second time', async () => {
    const { text } = await exportFromA();
    await importBackup(cloudB, text, { restorePurged: false }); const r = await importBackup(cloudB, text, { restorePurged: false });
    expect(r).toMatchObject({ ok: true, summary: { added: 0, skipped: { exists: 2 } } });
  });
});

describe('importBackup: edge cases', () => {
  it('a file that fails validation returns its errors and nothing reaches the cloud', async () => {
    const spy = vi.spyOn(cloud, 'importBackup');
    const bad = JSON.stringify({ format: 'productivity-app-export', version: 1, exported_at: '2026-01-01T00:00:00Z', tables: { todos: [{ id: 'x' }] } });
    const r = await importBackup(cloud, bad, { restorePurged: true });
    expect(r.ok).toBe(false); if (!r.ok) expect(r.errors.length).toBeGreaterThan(0); expect(spy).not.toHaveBeenCalled();
  });
  it('passes the validated backup and the restore flag to the cloud and returns its summary', async () => {
    const { text } = await exportFromA();
    const summary: ImportSummary = { added: 0, restored: 2, skipped: {} };
    const spy = vi.spyOn(cloud, 'importBackup').mockResolvedValue(summary);
    expect(await importBackup(cloud, text, { restorePurged: true })).toEqual({ ok: true, summary });
    expect(spy).toHaveBeenCalledWith(JSON.parse(text), true);
  });
  it('a cloud failure is thrown as the CloudError, not turned into a validation result', async () => {
    const { text } = await exportFromA();
    vi.spyOn(cloud, 'importBackup').mockRejectedValue(new CloudError('network'));
    await expect(importBackup(cloud, text, { restorePurged: false })).rejects.toMatchObject({ name: 'CloudError', kind: 'network' });
  });
  it('the test cloud maps an unauthenticated session to an auth CloudError', async () => {
    const { text } = await exportFromA();
    const noUser = createPgliteCloud(tB, '');
    await expect(importBackup(noUser, text, { restorePurged: false })).rejects.toMatchObject({ kind: 'auth' });
  });
});
