import { describe, expect, it } from 'vitest';
import { addDays, deviceTimeZone, isTimeZone, localDateOf, localTimeOf, zonedToInstant } from '../../src/domain/time';

describe('time-zone helpers (the brief)', () => {
  it('converts a local time in its own zone to the instant', () => expect(zonedToInstant('2026-11-23T09:00', 'Asia/Shanghai').toISOString()).toBe('2026-11-23T01:00:00.000Z'));
  it('a local time in a DST gap moves forward', () => expect(zonedToInstant('2026-03-08T02:30', 'America/New_York').toISOString()).toBe('2026-03-08T07:30:00.000Z'));
  it('an ambiguous local time takes the earlier instant', () => expect(zonedToInstant('2026-11-01T01:30', 'America/New_York').toISOString()).toBe('2026-11-01T05:30:00.000Z'));
  it('the device date of an event can differ from its own date', () => {
    const at = zonedToInstant('2026-11-23T23:30', 'Asia/Shanghai'); expect(localDateOf(at, 'Asia/Tokyo')).toBe('2026-11-24'); expect(localTimeOf(at, 'Asia/Tokyo')).toBe('00:30');
  });
  it('addDays crosses month and year ends', () => { expect(addDays('2026-12-31', 1)).toBe('2027-01-01'); expect(addDays('2026-03-01', -1)).toBe('2026-02-28'); });
  it('isTimeZone', () => { expect(isTimeZone('Asia/Shanghai')).toBe(true); expect(isTimeZone('Mars/Base')).toBe(false); });
});

describe('time-zone helpers (more)', () => {
  it('works with a half-hour zone', () => {
    expect(zonedToInstant('2026-11-23T09:00', 'Asia/Kolkata').toISOString()).toBe('2026-11-23T03:30:00.000Z');
    expect(localTimeOf(new Date('2026-11-23T03:30:00Z'), 'Asia/Kolkata')).toBe('09:00');
  });

  it('Lord Howe: a 30-minute DST gap moves forward by 30 minutes, a 30-minute overlap takes the earlier instant', () => {
    // 2026-10-04 02:00–02:30 does not exist (+10:30 → +11:00).
    const gap = zonedToInstant('2026-10-04T02:15', 'Australia/Lord_Howe');
    expect(gap.toISOString()).toBe('2026-10-03T15:45:00.000Z');
    expect(localTimeOf(gap, 'Australia/Lord_Howe')).toBe('02:45');
    // 2026-04-05 01:30–02:00 happens twice (+11:00 → +10:30); the first time is at +11:00.
    expect(zonedToInstant('2026-04-05T01:45', 'Australia/Lord_Howe').toISOString()).toBe('2026-04-04T14:45:00.000Z');
  });

  it('round-trips every 15 minutes of a DST-change day (outside the gap)', () => {
    for (let m = 0; m < 24 * 60; m += 15) {
      const local = `2026-03-08T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      if (local >= '2026-03-08T02:00' && local < '2026-03-08T03:00') continue;
      const at = zonedToInstant(local, 'America/New_York');
      expect(`${localDateOf(at, 'America/New_York')}T${localTimeOf(at, 'America/New_York')}`).toBe(local);
    }
  });

  it('midnight is 00:00, never 24:00', () => {
    expect(localTimeOf(new Date('2026-11-23T16:00:00Z'), 'Asia/Shanghai')).toBe('00:00');
    expect(localDateOf(new Date('2026-11-23T16:00:00Z'), 'Asia/Shanghai')).toBe('2026-11-24');
  });

  it('addDays handles leap days and long jumps', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-11-23', 0)).toBe('2026-11-23');
    expect(addDays('2026-11-23', 365)).toBe('2027-11-23');
  });

  it('isTimeZone refuses non-zones', () => {
    expect(isTimeZone('UTC')).toBe(true);
    expect(isTimeZone('Australia/Lord_Howe')).toBe(true);
    expect(isTimeZone('')).toBe(false);
    expect(isTimeZone(5 as never)).toBe(false);
  });

  it('deviceTimeZone is a real zone', () => expect(isTimeZone(deviceTimeZone())).toBe(true));
});
