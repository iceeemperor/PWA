import { isTimeZone } from '../domain/time';
import type { EventFields } from '../domain/types';
import { InvalidRecordError, isCalendarDate, isNonBlank, isStorableText } from './validate-fields';

// The event field rules. The Repo and the backup validator both use this one function, so the two client checks are
// the same. The cloud has the same rules as CHECKs on the events table (supabase/migrations/20261122000100_events.sql),
// except that the cloud checks only the shape of a date and of a zone name: this side also requires a day that is on
// the calendar and a zone that exists. tests/db/field-rules.test.ts keeps the two in agreement.

const DATE_FORM = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const LOCAL_FORM = /^([0-9]{4}-[0-9]{2}-[0-9]{2})T(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
// The cloud's events_timed_form shape for tz.
const ZONE_FORM = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

/** All-day: a real `YYYY-MM-DD`. Timed: `YYYY-MM-DDTHH:mm` whose date part is a real day. */
function isEventTime(v: unknown, allDay: boolean): boolean {
  if (typeof v !== 'string') return false;
  if (allDay) return DATE_FORM.test(v) && isCalendarDate(v);
  const m = LOCAL_FORM.exec(v);
  return m !== null && isCalendarDate(m[1]);
}

/**
 * Checks a whole event (every content field; for an edit, the stored record with the changes applied). Throws
 * InvalidRecordError with a stable English message; the UI maps some of them (by substring) to its own words.
 */
export function validateEventFields(input: EventFields): void {
  const f = input as unknown as Record<keyof EventFields, unknown>;
  if (typeof f.title !== 'string' || !isStorableText(f.title)) throw new InvalidRecordError('title must be text');
  if (!isNonBlank(f.title)) throw new InvalidRecordError('title must not be blank');
  if (typeof f.all_day !== 'boolean') throw new InvalidRecordError('all_day must be true or false');
  const allDay = f.all_day;
  const form = allDay ? 'a date in the form YYYY-MM-DD' : 'a local date-time in the form YYYY-MM-DDTHH:mm';
  if (!isEventTime(f.starts_at, allDay)) throw new InvalidRecordError(`starts_at must be ${form}`);
  if (f.ends_at !== null) {
    if (!isEventTime(f.ends_at, allDay)) throw new InvalidRecordError(`ends_at must be empty or ${form}`);
    // Both are in one fixed form (and, when timed, in one zone), so code-unit order is time order: the same as the
    // cloud's comparison in the "C" collation.
    if ((f.ends_at as string) < (f.starts_at as string)) throw new InvalidRecordError('ends_at must not be before starts_at');
  }
  if (allDay) {
    if (f.tz !== null) throw new InvalidRecordError('tz must be empty for an all-day event');
  } else if (typeof f.tz !== 'string' || !ZONE_FORM.test(f.tz) || !isTimeZone(f.tz)) {
    throw new InvalidRecordError('tz must be a time zone such as Asia/Shanghai for a timed event');
  }
  if (typeof f.note !== 'string' || !isStorableText(f.note)) throw new InvalidRecordError('note must be text');
  if (typeof f.important !== 'boolean') throw new InvalidRecordError('important must be true or false');
  if (typeof f.done !== 'boolean') throw new InvalidRecordError('done must be true or false');
  if (f.rrule !== null) throw new InvalidRecordError('rrule must be empty (repeating events are not available yet)');
}

type Timing = Pick<EventFields, 'all_day' | 'starts_at' | 'ends_at' | 'tz'>;

/**
 * The timing fields after switching an event between all-day and timed. To all-day: the date parts stay and the
 * zone goes. To timed: 09:00 on the start date in the device zone, with no end. Already in the wanted form: unchanged.
 */
export function switchAllDay(f: EventFields, toAllDay: boolean, deviceTz: string): Timing {
  if (f.all_day === toAllDay) return { all_day: f.all_day, starts_at: f.starts_at, ends_at: f.ends_at, tz: f.tz };
  const startDate = f.starts_at.slice(0, 10);
  if (toAllDay) return { all_day: true, starts_at: startDate, ends_at: f.ends_at === null ? null : f.ends_at.slice(0, 10), tz: null };
  return { all_day: false, starts_at: `${startDate}T09:00`, ends_at: null, tz: deviceTz };
}
