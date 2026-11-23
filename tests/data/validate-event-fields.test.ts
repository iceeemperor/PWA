import { describe, expect, it } from 'vitest';
import { switchAllDay, validateEventFields } from '../../src/data/validate-event-fields';
import { InvalidRecordError } from '../../src/data/validate-fields';
import { TABLE_DEFAULTS } from '../../src/domain/tables';
import type { EventFields } from '../../src/domain/types';

const ev = (over: Partial<Record<keyof EventFields, unknown>> = {}): EventFields =>
  ({ ...TABLE_DEFAULTS.events, title: '会', starts_at: '2026-11-23', ...over }) as EventFields;

const messageOf = (f: EventFields): string => {
  try {
    validateEventFields(f);
  } catch (e) {
    expect(e).toBeInstanceOf(InvalidRecordError);
    return (e as Error).message;
  }
  throw new Error('accepted');
};

describe('validateEventFields: the values push_change refuses (Task 2) are refused here too', () => {
  it.each([
    ['blank title', { title: ' ' }],
    ['all-day with a time', { all_day: true, starts_at: '2026-11-23T09:00', tz: null }],
    ['all-day with a tz', { all_day: true, starts_at: '2026-11-23', tz: 'Asia/Shanghai' }],
    ['timed without tz', { all_day: false, starts_at: '2026-11-23T09:00', tz: null }],
    ['timed with seconds or offset', { all_day: false, starts_at: '2026-11-23T09:00:00+08:00', tz: 'Asia/Shanghai' }],
    ['end before start', { all_day: true, starts_at: '2026-11-23', ends_at: '2026-11-22' }],
    ['end in the other form', { all_day: true, starts_at: '2026-11-23', ends_at: '2026-11-23T10:00' }],
    ['rrule set', { all_day: true, starts_at: '2026-11-23', rrule: 'FREQ=DAILY' }],
    ['a timed end before start', { all_day: false, starts_at: '2026-11-23T09:00', ends_at: '2026-11-23T08:59', tz: 'UTC' }],
    ['a timed end in the all-day form', { all_day: false, starts_at: '2026-11-23T09:00', ends_at: '2026-11-24', tz: 'UTC' }],
    ['hour 24', { all_day: false, starts_at: '2026-11-23T24:00', tz: 'UTC' }],
    ['minute 60', { all_day: false, starts_at: '2026-11-23T09:60', tz: 'UTC' }],
    ['a timed start without a time', { all_day: false, starts_at: '2026-11-23', tz: 'UTC' }],
    ['an empty start', { all_day: true, starts_at: '' }],
    ['a tz with a space', { all_day: false, starts_at: '2026-11-23T09:00', tz: 'Asia/ Shanghai' }],
    ['a tz starting with a slash', { all_day: false, starts_at: '2026-11-23T09:00', tz: '/Asia' }],
    ['an empty tz', { all_day: false, starts_at: '2026-11-23T09:00', tz: '' }],
    ['a trailing newline in the date', { all_day: true, starts_at: '2026-11-23\n' }],
    ['a full-width blank title', { title: '　' }],
  ])('rejects %s', (_n, over) => {
    expect(() => validateEventFields(ev(over))).toThrow(InvalidRecordError);
  });
});

describe('validateEventFields: the brief', () => {
  it('rejects a timed event whose tz is not a real IANA zone', () => expect(() => validateEventFields(ev({ all_day: false, starts_at: '2026-11-23T09:00', tz: 'Mars/Base' }))).toThrow(InvalidRecordError));
  it('rejects a date that is not on the calendar', () => expect(() => validateEventFields(ev({ starts_at: '2026-02-30' }))).toThrow(InvalidRecordError));
  it('switchAllDay to all-day keeps the dates and clears the zone', () =>
    expect(switchAllDay(ev({ all_day: false, starts_at: '2026-11-23T09:00', ends_at: '2026-11-24T10:00', tz: 'Asia/Shanghai' }), true, 'Asia/Tokyo'))
      .toEqual({ all_day: true, starts_at: '2026-11-23', ends_at: '2026-11-24', tz: null }));
  it('switchAllDay to timed starts at 09:00 in the device zone with no end', () =>
    expect(switchAllDay(ev({ all_day: true, starts_at: '2026-11-23', ends_at: '2026-11-25' }), false, 'Asia/Tokyo'))
      .toEqual({ all_day: false, starts_at: '2026-11-23T09:00', ends_at: null, tz: 'Asia/Tokyo' }));
});

describe('validateEventFields: more', () => {
  it.each([
    ['an all-day event', {}],
    ['a multi-day all-day event', { ends_at: '2026-11-25' }],
    ['an all-day event ending the same day', { ends_at: '2026-11-23' }],
    ['a timed event', { all_day: false, starts_at: '2026-11-23T09:00', tz: 'Asia/Shanghai' }],
    ['a timed event with an end', { all_day: false, starts_at: '2026-11-23T09:00', ends_at: '2026-11-23T09:00', tz: 'UTC' }],
    ['a timed event in a half-hour zone', { all_day: false, starts_at: '2026-11-23T23:59', ends_at: '2026-11-24T00:00', tz: 'Asia/Kolkata' }],
    ['a leap day', { starts_at: '2028-02-29' }],
    ['note, important and done set', { note: 'n', important: true, done: true }],
  ])('accepts %s', (_n, over) => {
    expect(() => validateEventFields(ev(over))).not.toThrow();
  });

  it.each([
    ['a non-string title', { title: 5 }],
    ['a null title', { title: null }],
    ['a lone surrogate in the title', { title: 'a\uD800' }],
    ['a NUL in the note', { note: 'a\u0000' }],
    ['a null note', { note: null }],
    ['a non-boolean all_day', { all_day: 'yes' }],
    ['a non-boolean important', { important: 1 }],
    ['a null done', { done: null }],
    ['a timed date not on the calendar', { all_day: false, starts_at: '2026-02-30T09:00', tz: 'UTC' }],
    ['an end not on the calendar', { ends_at: '2026-11-31' }],
    ['year 0000', { starts_at: '0000-01-01' }],
    ['a non-string start', { starts_at: 20261123 }],
    ['a non-string tz', { all_day: false, starts_at: '2026-11-23T09:00', tz: 5 }],
    ['an offset as the tz (Intl takes it, the server shape does not)', { all_day: false, starts_at: '2026-11-23T09:00', tz: '+08:00' }],
  ])('rejects %s', (_n, over) => {
    expect(() => validateEventFields(ev(over))).toThrow(InvalidRecordError);
  });

  it('uses the stable messages that the UI maps', () => {
    expect(messageOf(ev({ ends_at: '2026-11-22' }))).toContain('ends_at must not be before starts_at');
    expect(messageOf(ev({ all_day: false, starts_at: '2026-11-23T09:00', ends_at: '2026-11-23T08:00', tz: 'UTC' }))).toContain('ends_at must not be before starts_at');
    expect(messageOf(ev({ title: ' ' }))).toContain('title must not be blank');
  });

  it('switchAllDay without a change keeps the fields', () => {
    expect(switchAllDay(ev({ ends_at: '2026-11-24' }), true, 'Asia/Tokyo')).toEqual({ all_day: true, starts_at: '2026-11-23', ends_at: '2026-11-24', tz: null });
    const timed = ev({ all_day: false, starts_at: '2026-11-23T10:00', ends_at: '2026-11-23T11:00', tz: 'Asia/Shanghai' });
    expect(switchAllDay(timed, false, 'Asia/Tokyo')).toEqual({ all_day: false, starts_at: '2026-11-23T10:00', ends_at: '2026-11-23T11:00', tz: 'Asia/Shanghai' });
  });

  it('switchAllDay results pass the rules', () => {
    const timed = ev({ all_day: false, starts_at: '2026-11-23T09:00', ends_at: '2026-11-24T10:00', tz: 'Asia/Shanghai' });
    expect(() => validateEventFields({ ...timed, ...switchAllDay(timed, true, 'UTC') })).not.toThrow();
    const allDay = ev({ ends_at: '2026-11-25' });
    expect(() => validateEventFields({ ...allDay, ...switchAllDay(allDay, false, 'UTC') })).not.toThrow();
  });
});
