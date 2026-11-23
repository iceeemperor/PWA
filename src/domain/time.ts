// Time-zone helpers for events. Timed events store a local wall-clock time (`YYYY-MM-DDTHH:mm`) plus an IANA zone;
// these turn that into an instant and back, using only Intl (no time-zone library).

const DAY = 86_400_000;

/** The zone this device is set to, such as Asia/Shanghai. */
export function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** A zone name Intl knows (an IANA zone such as Asia/Shanghai, or UTC). */
export function isTimeZone(tz: string): boolean {
  if (typeof tz !== 'string' || tz === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

// hourCycle 'h23': with hour12: false some engines print midnight as "24:00".
function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall clock in `tz` at instant `ms`. */
function wallAt(ms: number, tz: string): Wall {
  const parts: Record<string, number> = {};
  for (const p of formatterFor(tz).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute, second: parts.second };
}

/** A wall clock read as if it were UTC, in ms. setUTCFullYear keeps years 1–99 (Date.UTC would map them to 19xx). */
function wallAsUtc(w: Wall): number {
  const d = new Date(0);
  d.setUTCFullYear(w.year, w.month - 1, w.day);
  d.setUTCHours(w.hour, w.minute, w.second, 0);
  return d.getTime();
}

/** The zone's offset from UTC at instant `ms`, in ms (wall clock minus UTC). Whole seconds, as the zone data has. */
function offsetAt(ms: number, tz: string): number {
  const whole = Math.floor(ms / 1000) * 1000;
  return wallAsUtc(wallAt(whole, tz)) - whole;
}

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The instant at which the wall clock in `tz` shows `local` (`YYYY-MM-DDTHH:mm`). Like Temporal's 'compatible':
 * a time that does not exist (a DST gap) is moved forward by the length of the gap, and a time that happens twice
 * (a DST overlap) takes the earlier instant.
 */
export function zonedToInstant(local: string, tz: string): Date {
  const m = LOCAL.exec(local);
  if (!m) throw new RangeError(`Not a local date-time (YYYY-MM-DDTHH:mm): ${local}`);
  const asUtc = wallAsUtc({ year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5], second: 0 });
  // The offsets a day before and a day after bracket any one transition near this time (zones never change twice
  // within two days); the offset at the guess itself covers the rest.
  const before = offsetAt(asUtc - DAY, tz);
  const after = offsetAt(asUtc + DAY, tz);
  const candidates = [...new Set([before, offsetAt(asUtc, tz), after])]
    .map((offset) => asUtc - offset)
    .filter((ms) => offsetAt(ms, tz) === asUtc - ms)
    .sort((a, b) => a - b);
  if (candidates.length > 0) return new Date(candidates[0]);
  // A gap: read the time with the offset in force before it, which lands as far past the gap's start as `local` is.
  return new Date(asUtc - before);
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** The calendar date (`YYYY-MM-DD`) in `tz` at `instant`. */
export function localDateOf(instant: Date, tz: string): string {
  const w = wallAt(instant.getTime(), tz);
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;
}

/** The wall-clock time (`HH:mm`) in `tz` at `instant`. */
export function localTimeOf(instant: Date, tz: string): string {
  const w = wallAt(instant.getTime(), tz);
  return `${pad(w.hour)}:${pad(w.minute)}`;
}

/** `date` (`YYYY-MM-DD`) moved by `n` calendar days. Pure calendar arithmetic: no zone is involved. */
export function addDays(date: string, n: number): string {
  const m = DATE.exec(date);
  if (!m) throw new RangeError(`Not a date (YYYY-MM-DD): ${date}`);
  const d = new Date(wallAsUtc({ year: +m[1], month: +m[2], day: +m[3], hour: 0, minute: 0, second: 0 }) + n * DAY);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
