// Month grid and the events of one day. Pure functions, no UI.
import { eventSlot } from '../agenda/agenda';
import type { EventRecord } from '../domain/types';
import { addDays } from '../domain/time';

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** 6 rows × 7 columns of `YYYY-MM-DD`, weeks starting on Monday, with the days of the neighbouring months as padding. */
export function monthGrid(year: number, month: number): string[][] {
  const first = `${pad(year, 4)}-${pad(month)}-01`;
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, 1);
  const lead = (d.getUTCDay() + 6) % 7; // Monday 0 … Sunday 6
  const start = addDays(first, -lead);
  return Array.from({ length: 6 }, (_, r) => Array.from({ length: 7 }, (_, c) => addDays(start, r * 7 + c)));
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The events that show on each of `days` in the device zone `tz`: not trashed or purged; an all-day event on every
 * day from its start to its end (inclusive), a timed one only on its start day. Each event's zone work is done once.
 * Every bucket is sorted all-day first, then by start time, then id.
 */
export function eventsByDay(events: EventRecord[], days: string[], tz: string): Map<string, EventRecord[]> {
  const buckets = new Map<string, { e: EventRecord; key: string }[]>(days.map((d) => [d, []]));
  for (const e of events) {
    if (e.deleted_at !== null || e.purged_at !== null) continue;
    if (e.all_day) {
      const start = e.starts_at.slice(0, 10);
      const end = (e.ends_at ?? e.starts_at).slice(0, 10);
      for (const d of days) if (start <= d && d <= (end < start ? start : end)) buckets.get(d)!.push({ e, key: '' });
    } else {
      const { date, time } = eventSlot(e, tz);
      // The prefix keeps timed events after all-day ones.
      buckets.get(date)?.push({ e, key: `1${time ?? ''}` });
    }
  }
  const out = new Map<string, EventRecord[]>();
  for (const [d, list] of buckets) {
    list.sort((a, b) => cmp(a.key, b.key) || cmp(a.e.id, b.e.id));
    out.set(d, list.map((x) => x.e));
  }
  return out;
}

/** The events that show on `date` (see eventsByDay). */
export function eventsOnDay(events: EventRecord[], date: string, tz: string): EventRecord[] {
  return eventsByDay(events, [date], tz).get(date)!;
}
