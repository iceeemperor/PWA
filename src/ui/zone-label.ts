import { isTimeZone, zonedToInstant } from '../domain/time';

/** A short zone name (GMT-5) for the zone `tz` at the local time `startsAt`, or the IANA id when Intl cannot name it. */
export function zoneLabel(tz: string, startsAt: string): string {
  if (!isTimeZone(tz)) return tz;
  try {
    const at = zonedToInstant(startsAt, tz);
    const part = new Intl.DateTimeFormat('zh-CN', { timeZone: tz, timeZoneName: 'short' }).formatToParts(at).find((p) => p.type === 'timeZoneName');
    return part?.value ?? tz;
  } catch {
    return tz;
  }
}
