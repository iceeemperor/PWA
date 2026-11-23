import { describe, expect, it } from 'vitest';
import { eventsOnDay, monthGrid } from '../../src/calendar/month';
import type { EventRecord } from '../../src/domain/types';

const TZ = 'Asia/Shanghai';
let seq = 0;
const event = (p: Partial<EventRecord> = {}): EventRecord => ({
  id: `e${String(++seq).padStart(4, '0')}`, user_id: 'u', created_at: '2026-11-10T00:00:00Z', updated_at: '2026-11-10T00:00:00Z', rev: 1,
  deleted_at: null, purged_at: null, title: 'event', all_day: true, starts_at: '2026-11-23', ends_at: null, tz: null, note: '',
  important: false, done: false, rrule: null, ...p,
});
const timed = (p: Partial<EventRecord>) => event({ all_day: false, starts_at: '2026-11-23T09:00', tz: TZ, ...p });

describe('monthGrid', () => {
  it('November 2026 starts on Monday 10-26 and has 6 rows of 7', () => {
    const g = monthGrid(2026, 11);
    expect(g).toHaveLength(6);
    expect(g.every((r) => r.length === 7)).toBe(true);
    expect(g[0][0]).toBe('2026-10-26');
    expect(g[0][6]).toBe('2026-11-01');
    expect(g[5][6]).toBe('2026-12-06');
  });
  it('a month starting on Monday has no lead-in; one starting on Sunday has six days', () => {
    expect(monthGrid(2026, 6)[0][0]).toBe('2026-06-01'); // 2026-06-01 is a Monday
    expect(monthGrid(2026, 2)[0][0]).toBe('2026-01-26'); // 2026-02-01 is a Sunday
  });
  it('handles December and January across the year', () => {
    expect(monthGrid(2026, 12).flat()).toContain('2026-12-31');
    expect(monthGrid(2027, 1)[0][0]).toBe('2026-12-28');
  });
});

describe('eventsOnDay', () => {
  it('a multi-day all-day event shows on every day it covers', () => {
    const e = event({ starts_at: '2026-11-23', ends_at: '2026-11-25' });
    expect(['2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26'].map((d) => eventsOnDay([e], d, TZ).length)).toEqual([0, 1, 1, 1, 0]);
  });
  it('an all-day event without an end is on its own day only', () => {
    const e = event({ starts_at: '2026-11-23' });
    expect(['2026-11-22', '2026-11-23', '2026-11-24'].map((d) => eventsOnDay([e], d, TZ).length)).toEqual([0, 1, 0]);
  });
  it('a timed event shows on its start day in the device zone only', () => {
    const e = timed({ starts_at: '2026-11-24T23:30', ends_at: '2026-11-25T01:00', tz: 'Asia/Shanghai' });
    // 23:30 Shanghai is 00:30 on 11-25 in Tokyo.
    expect(['2026-11-24', '2026-11-25'].map((d) => eventsOnDay([e], d, 'Asia/Tokyo').length)).toEqual([0, 1]);
    expect(['2026-11-24', '2026-11-25'].map((d) => eventsOnDay([e], d, 'Asia/Shanghai').length)).toEqual([1, 0]);
  });
  it('ignores trashed and purged events', () => {
    const list = [event({ deleted_at: '2026-11-22T00:00:00Z' }), event({ purged_at: '2026-11-22T00:00:00Z' }), event({ title: 'kept' })];
    expect(eventsOnDay(list, '2026-11-23', TZ).map((e) => e.title)).toEqual(['kept']);
  });
  it('orders all-day first, then by device-zone start time, then by id', () => {
    const a = timed({ id: 'b', title: 'late', starts_at: '2026-11-23T15:00' });
    const b = timed({ id: 'z', title: 'early-z', starts_at: '2026-11-23T08:00' });
    const c = timed({ id: 'a', title: 'early-a', starts_at: '2026-11-23T08:00' });
    const d = event({ id: 'q', title: 'allday' });
    expect(eventsOnDay([a, b, c, d], '2026-11-23', TZ).map((e) => e.title)).toEqual(['allday', 'early-a', 'early-z', 'late']);
  });
  it('orders by the device-zone time, not the event-zone time', () => {
    const ny = timed({ id: 'n', title: 'ny', starts_at: '2026-11-23T01:00', tz: 'America/New_York' }); // 14:00 Shanghai
    const sh = timed({ id: 's', title: 'sh', starts_at: '2026-11-23T10:00', tz: TZ });
    expect(eventsOnDay([ny, sh], '2026-11-23', TZ).map((e) => e.title)).toEqual(['sh', 'ny']);
  });
  it('an event zone this device does not know falls back to the stored date and time', () => {
    const e = timed({ starts_at: '2026-11-23T09:15', tz: 'Mars/Base' });
    expect(eventsOnDay([e], '2026-11-23', TZ)).toHaveLength(1);
  });
  it('an invalid device zone falls back to UTC and never throws', () => {
    const e = timed({ starts_at: '2026-11-23T23:30', tz: 'Asia/Shanghai' }); // 15:30 UTC the same day
    expect(eventsOnDay([e], '2026-11-23', 'Not/AZone')).toHaveLength(1);
    const f = timed({ starts_at: '2026-11-23T03:00', tz: 'Asia/Shanghai' }); // 19:00 UTC on 11-22
    expect(eventsOnDay([f], '2026-11-22', 'Not/AZone')).toHaveLength(1);
  });
});
