import { openDB } from 'idb';

/** Builds the stage 1 database exactly as stage 1 did (version 1: todos, queue, meta) and fills it. */
export async function seedVersion1(name: string, data: { todos: object[]; queue: object[]; meta: Record<string, unknown> }) {
  const db = await openDB(name, 1, {
    upgrade(d) {
      d.createObjectStore('todos', { keyPath: 'id' });
      d.createObjectStore('queue', { keyPath: 'seq', autoIncrement: true });
      d.createObjectStore('meta');
    },
  });
  for (const t of data.todos) await db.put('todos', t);
  for (const q of data.queue) await db.put('queue', q);
  for (const [k, v] of Object.entries(data.meta)) await db.put('meta', v, k);
  return db;
}
