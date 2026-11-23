// Business rules for the 近期 (upcoming) list and the 目标 (goals) list. Pure functions, no UI.
import type { EventRecord, TodoRecord } from '../domain/types';
import { addDays, isTimeZone, localDateOf, localTimeOf, zonedToInstant } from '../domain/time';

export const AGENDA_DAYS = 14;

export type SortMode = 'priority' | 'date';
type Priority = 'high' | 'normal' | 'low';

export interface AgendaItem {
  source: 'todo' | 'event';
  id: string;
  title: string;
  /** Date in the device zone; null only for undated todos. */
  date: string | null;
  /** Wall-clock time in the device zone; null for all-day events and for todos. */
  time: string | null;
  priority: Priority;
  done: boolean;
  overdue: boolean;
  created_at: string;
}

export interface Agenda {
  groups: { priority: Priority | null; items: AgendaItem[] }[];
  done: AgendaItem[];
}

const ORDER: Priority[] = ['high', 'normal', 'low'];

// A zone this device's Intl does not know makes the time helpers throw. An event must still show, so fall back
// to the stored local date and time unchanged.
function eventWhen(e: EventRecord, tz: string): { date: string; time: string | null } {
  const date = e.starts_at.slice(0, 10);
  if (e.all_day) return { date, time: null };
  try {
    if (e.tz === null) throw new RangeError('timed event without a zone');
    const at = zonedToInstant(e.starts_at, e.tz);
    return { date: localDateOf(at, tz), time: localTimeOf(at, tz) };
  } catch {
    return { date, time: e.starts_at.slice(11, 16) || null };
  }
}

/** The date of an event in the device zone `tz`; all-day events keep their own date. Never throws. */
export function eventDate(e: EventRecord, tz: string): string {
  return eventWhen(e, isTimeZone(tz) ? tz : 'UTC').date;
}

/** The wall-clock time of an event in the device zone `tz` (`HH:mm`); null for all-day events. Never throws. */
export function eventTime(e: EventRecord, tz: string): string | null {
  return eventWhen(e, isTimeZone(tz) ? tz : 'UTC').time;
}

const live = (r: { deleted_at: string | null; purged_at: string | null }): boolean => r.deleted_at === null && r.purged_at === null;

const cmp = <T extends string | number>(a: T, b: T): number => (a < b ? -1 : a > b ? 1 : 0);

function toItems(todos: TodoRecord[], events: EventRecord[], tz: string, today: string): AgendaItem[] {
  const items: AgendaItem[] = [];
  for (const t of todos) {
    if (t.kind !== 'todo' || !live(t)) continue;
    items.push({
      source: 'todo', id: t.id, title: t.title, date: t.due_date, time: null, priority: t.priority, done: t.done,
      overdue: !t.done && t.due_date !== null && t.due_date < today, created_at: t.created_at,
    });
  }
  for (const e of events) {
    if (!e.important || !live(e)) continue;
    const { date, time } = eventWhen(e, tz);
    items.push({
      source: 'event', id: e.id, title: e.title, date, time, priority: 'high', done: e.done,
      overdue: !e.done && date < today, created_at: e.created_at,
    });
  }
  return items;
}

// Segment: overdue 0, today and later 1, undated 2. Only todos can be undated.
const segmentOf = (i: AgendaItem, today: string): number => (i.date === null ? 2 : i.date < today ? 0 : 1);

function compare(a: AgendaItem, b: AgendaItem, today: string, byPriority: boolean): number {
  if (byPriority) {
    const g = cmp(ORDER.indexOf(a.priority), ORDER.indexOf(b.priority));
    if (g) return g;
  }
  const sa = segmentOf(a, today);
  const sb = segmentOf(b, today);
  if (sa !== sb) return sa - sb;
  if (sa === 2) {
    const c = cmp(b.created_at, a.created_at);
    if (c) return c;
  } else {
    // Same date: all-day (time null, '' here) before timed, then by time.
    const c = cmp(a.date!, b.date!) || cmp(a.time ?? '', b.time ?? '');
    if (c) return c;
  }
  return cmp(a.id, b.id);
}

function compareDone(a: AgendaItem, b: AgendaItem): number {
  if (a.date !== null && b.date !== null) return cmp(b.date, a.date) || cmp(a.id, b.id);
  if (a.date !== null) return -1;
  if (b.date !== null) return 1;
  return cmp(b.created_at, a.created_at) || cmp(a.id, b.id);
}

export function buildAgenda(
  todos: TodoRecord[],
  events: EventRecord[],
  o: { now: Date; tz: string; mode: SortMode; showDone: boolean },
): Agenda {
  const tz = isTimeZone(o.tz) ? o.tz : 'UTC';
  const today = localDateOf(o.now, tz);
  const end = addDays(today, AGENDA_DAYS);
  const items = toItems(todos, events, tz, today);
  const open = items.filter((i) => !i.done && (i.date === null || i.date <= end));
  const byPriority = o.mode === 'priority';
  open.sort((a, b) => compare(a, b, today, byPriority));
  const groups: Agenda['groups'] = byPriority
    ? ORDER.map((p) => ({ priority: p, items: open.filter((i) => i.priority === p) }))
    : [{ priority: null, items: open }];
  const done = o.showDone ? items.filter((i) => i.done).sort(compareDone) : [];
  return { groups, done };
}

/** Goals that are not trashed: open ones first, then by creation time, newest first. */
export function goalsOf(todos: TodoRecord[]): TodoRecord[] {
  return todos
    .filter((t) => t.kind === 'goal' && live(t))
    .sort((a, b) => Number(a.done) - Number(b.done) || cmp(b.created_at, a.created_at) || cmp(a.id, b.id));
}
