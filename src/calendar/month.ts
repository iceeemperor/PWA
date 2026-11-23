// Month grid and the events of one day. Pure functions, no UI.
import { eventDate, eventTime } from '../agenda/agenda';
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
 * The events that show on `date` in the device zone `tz`: not trashed or purged; an all-day event on every day from
 * its start to its end (inclusive), a timed one only on its start day. All-day first, then by start time, then id.
 */
export function eventsOnDay(events: EventRecord[], date: string, tz: string): EventRecord[] {
  return events
    .filter((e) => {
      if (e.deleted_at !== null || e.purged_at !== null) return false;
      if (!e.all_day) return eventDate(e, tz) === date;
      const start = e.starts_at.slice(0, 10);
      const end = (e.ends_at ?? e.starts_at).slice(0, 10);
      return start <= date && date <= (end < start ? start : end);
    })
    .sort((a, b) => Number(!a.all_day) - Number(!b.all_day) || cmp(eventTime(a, tz) ?? '', eventTime(b, tz) ?? '') || cmp(a.id, b.id));
}
