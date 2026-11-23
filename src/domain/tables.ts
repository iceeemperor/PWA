import type { FieldsOf, TableName } from './types';

/** Deep-freezes plain data so the shared defaults cannot be changed through a reference handed out by mistake. */
function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) frozen(v);
    Object.freeze(value);
  }
  return value;
}

/**
 * Each table's content columns with their SQL column DEFAULT. A new record starts from these, and a purge resets
 * a record's content to them (its tombstone). They must stay equal to the DEFAULTs in the migrations
 * (`todos`: 20261106000100_core.sql; `events`: 20261122000100_events.sql). The keys are the table's content fields.
 */
export const TABLE_DEFAULTS: { readonly [T in TableName]: Readonly<FieldsOf<T>> } = frozen({
  todos: { kind: 'todo', title: '', done: false, priority: 'normal', due_date: null, note: '', steps: [] },
  events: { title: '', all_day: true, starts_at: '', ends_at: null, tz: null, note: '', important: false, done: false, rrule: null },
});

/** A fresh, unfrozen copy of the table's defaults, safe to hand out or change. */
export function defaultsOf<T extends TableName>(t: T): FieldsOf<T> {
  return structuredClone(TABLE_DEFAULTS[t]) as FieldsOf<T>;
}

/** The content fields of a table: the ones the client may write. */
export function contentKeys(t: TableName): string[] {
  return Object.keys(TABLE_DEFAULTS[t]);
}
