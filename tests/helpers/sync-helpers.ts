import type { QueuedOp } from '../../src/domain/types';
import type { TestDb, TodoRow } from '../db/harness';
import type { Device } from './device';

/** Creates `n` todos on the device and syncs them up. Returns the created records. */
export async function seedAndSync(d: Device, n: number) {
  const made = [];
  for (let i = 0; i < n; i++) made.push(await d.repo.create('todos', { title: `seed ${i}` }));
  await d.engine.sync();
  return made;
}

/** Every local record (live, trashed and tombstones) sorted by table and id, plus the pending queue size. */
export async function snapshot(d: Device): Promise<{ todos: Record<string, unknown>[]; queued: number }> {
  const todos = ((await d.db.raw.getAll('todos')) as Record<string, unknown>[])
    .sort((x, y) => String(x.id).localeCompare(String(y.id)));
  const queued = ((await d.db.raw.getAll('queue')) as QueuedOp[]).length;
  return { todos, queued };
}

/** All cloud rows of todos, whoever owns them, in rev order. */
export async function cloudRows(t: TestDb): Promise<TodoRow[]> {
  await t.asRole('postgres');
  const r = await t.pg.query<TodoRow>('select * from todos order by rev');
  return r.rows;
}

export async function cloudRowCount(t: TestDb): Promise<number> {
  return (await cloudRows(t)).length;
}
