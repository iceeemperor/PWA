import { describe, expect, it } from 'vitest';
import { AGENDA_DAYS, buildAgenda, eventDate, goalsOf, type Agenda } from '../../src/agenda/agenda';
import type { EventRecord, TodoRecord } from '../../src/domain/types';

let seq = 0;
const uid = (p: string) => `${p}${String(++seq).padStart(4, '0')}`;
const todo = (p: Partial<TodoRecord> = {}): TodoRecord => ({
  id: uid('t'), user_id: 'u', created_at: '2026-11-10T00:00:00Z', updated_at: '2026-11-10T00:00:00Z', rev: 1, deleted_at: null, purged_at: null,
  kind: 'todo', title: 'todo', done: false, priority: 'normal', due_date: null, note: '', steps: [], ...p,
});
const goal = (p: Partial<TodoRecord> = {}): TodoRecord => todo({ kind: 'goal', title: 'goal', ...p });
const event = (p: Partial<EventRecord> = {}): EventRecord => ({
  id: uid('e'), user_id: 'u', created_at: '2026-11-10T00:00:00Z', updated_at: '2026-11-10T00:00:00Z', rev: 1, deleted_at: null, purged_at: null,
  title: 'event', all_day: true, starts_at: '2026-11-23', ends_at: null, tz: null, note: '', important: false, done: false, rrule: null, ...p,
});
const o = (p: Partial<{ now: Date; tz: string; mode: 'priority' | 'date'; showDone: boolean }> = {}) =>
  ({ now: new Date('2026-11-23T04:00:00Z'), tz: 'Asia/Shanghai', mode: 'priority' as const, showDone: false, ...p });
const all = (a: Agenda) => [...a.groups.flatMap(g => g.items), ...a.done];
const titles = (a: Agenda) => a.groups.flatMap(g => g.items).map(i => i.title);
const groupOf = (a: Agenda, p: 'high' | 'normal' | 'low') => a.groups.find(g => g.priority === p)!.items;

describe('agenda (the brief)', () => {
  it('merges todos and important events, leaves out unimportant events and goals', () => {
    const a = buildAgenda([todo({ title: 't' }), goal({ title: 'g' })], [event({ title: 'imp', important: true }), event({ title: 'plain' })], o());
    expect(titles(a)).toEqual(expect.arrayContaining(['t', 'imp'])); expect(titles(a)).not.toContain('plain'); expect(titles(a)).not.toContain('g');
  });
  it('keeps items up to today + 14 days and todos without a date, drops later ones', () => {
    const a = buildAgenda([todo({ due_date: '2026-12-07', title: 'in' }), todo({ due_date: '2026-12-08', title: 'out' }), todo({ title: 'nodate' })], [], o());
    expect(titles(a).sort()).toEqual(['in', 'nodate']);
  });
  it('an important event counts as high priority', () => expect(groupOf(buildAgenda([], [event({ important: true, starts_at: '2026-11-24' })], o()), 'high')).toHaveLength(1));
  it('within a group: overdue first by date, then today and later by date, then undated by newest created', () => {
    const a = buildAgenda([
      todo({ title: 'later', due_date: '2026-11-25' }), todo({ title: 'od2', due_date: '2026-11-21' }), todo({ title: 'od1', due_date: '2026-11-20' }),
      todo({ title: 'today', due_date: '2026-11-23' }), todo({ title: 'old', created_at: '2026-11-01T00:00:00Z' }), todo({ title: 'new', created_at: '2026-11-22T00:00:00Z' }),
    ], [], o());
    expect(groupOf(a, 'normal').map(i => i.title)).toEqual(['od1', 'od2', 'today', 'later', 'new', 'old']);
    expect(groupOf(a, 'normal').filter(i => i.overdue).map(i => i.title)).toEqual(['od1', 'od2']);
  });
  it('same date and priority: ordered by id, so the order is stable', () => {
    const a = todo({ id: 'a1', title: 'a', due_date: '2026-11-25' }), b = todo({ id: 'b1', title: 'b', due_date: '2026-11-25' });
    expect(titles(buildAgenda([b, a], [], o()))).toEqual(['a', 'b']);
    expect(titles(buildAgenda([a, b], [], o()))).toEqual(['a', 'b']);
  });
  it('date mode: one group, priority ignored, same rules otherwise', () => {
    const a = buildAgenda([todo({ title: 'high', priority: 'high', due_date: '2026-11-25' }), todo({ title: 'low', priority: 'low', due_date: '2026-11-24' })], [], o({ mode: 'date' }));
    expect(a.groups).toHaveLength(1); expect(a.groups[0].priority).toBeNull(); expect(titles(a)).toEqual(['low', 'high']);
  });
  it('done items are hidden; with showDone they appear in done, newest date first', () => {
    const todos = [todo({ title: 'd1', done: true, due_date: '2026-11-01' }), todo({ title: 'd2', done: true, due_date: '2026-11-20' }), todo({ title: 'open' })];
    expect(titles(buildAgenda(todos, [], o()))).toEqual(['open']);
    expect(buildAgenda(todos, [], o({ showDone: true })).done.map(i => i.title)).toEqual(['d2', 'd1']);
  });
  it('"today" follows the device zone, not UTC', () => {
    const a = buildAgenda([todo({ title: 'due23', due_date: '2026-11-23' })], [], o({ now: new Date('2026-11-23T17:00:00Z') }));
    expect(all(a).find(i => i.title === 'due23')!.overdue).toBe(true);
    const b = buildAgenda([todo({ title: 'due23', due_date: '2026-11-23' })], [], o({ now: new Date('2026-11-23T15:00:00Z') }));
    expect(all(b).find(i => i.title === 'due23')!.overdue).toBe(false);
  });
  it('a timed event is dated in the device zone', () => {
    const e = event({ important: true, all_day: false, starts_at: '2026-11-24T23:30', tz: 'Asia/Shanghai' });
    expect(all(buildAgenda([], [e], o({ tz: 'Asia/Tokyo' })))[0]).toMatchObject({ date: '2026-11-25', time: '00:30' });
  });
  it('trashed items never appear', () => expect(all(buildAgenda([todo({ deleted_at: '2026-11-22T00:00:00Z' })], [event({ important: true, deleted_at: '2026-11-22T00:00:00Z' })], o({ showDone: true })))).toEqual([]));
  it('goalsOf lists goals only, open ones first', () => {
    const g = goalsOf([
      goal({ title: 'doneNew', done: true, created_at: '2026-11-20T00:00:00Z' }), goal({ title: 'openOld', created_at: '2026-11-01T00:00:00Z' }),
      goal({ title: 'openNew', created_at: '2026-11-15T00:00:00Z' }), todo({ title: 'plain' }), goal({ title: 'trashed', deleted_at: '2026-11-21T00:00:00Z' }),
    ]);
    expect(g.map(x => x.title)).toEqual(['openNew', 'openOld', 'doneNew']);
  });
});

describe('agenda (additional)', () => {
  it('an event with a zone this device does not know falls back to its stored date and time, without throwing', () => {
    const e = event({ important: true, all_day: false, starts_at: '2026-11-24T09:15', tz: 'Mars/Base' });
    expect(eventDate(e, 'Asia/Tokyo')).toBe('2026-11-24');
    expect(all(buildAgenda([], [e], o()))[0]).toMatchObject({ date: '2026-11-24', time: '09:15' });
  });
  it('a timed event with no zone also falls back instead of throwing', () => {
    const e = event({ important: true, all_day: false, starts_at: '2026-11-24T09:15', tz: null });
    expect(() => buildAgenda([], [e], o())).not.toThrow();
  });
  it('the window ends inclusively at exactly today + AGENDA_DAYS', () => {
    expect(AGENDA_DAYS).toBe(14);
    const a = buildAgenda([todo({ title: 'edge', due_date: '2026-12-07' }), todo({ title: 'past', due_date: '2026-12-08' })], [event({ title: 'evEdge', important: true, starts_at: '2026-12-07' }), event({ title: 'evPast', important: true, starts_at: '2026-12-08' })], o());
    expect(titles(a).sort()).toEqual(['edge', 'evEdge']);
  });
  it('an event never lands in the undated segment: it sorts among dated items, before undated todos', () => {
    const a = buildAgenda([todo({ title: 'undated', priority: 'high', created_at: '2026-11-22T00:00:00Z' })], [event({ title: 'ev', important: true, starts_at: '2026-12-01' })], o());
    expect(groupOf(a, 'high').map(i => i.title)).toEqual(['ev', 'undated']);
    expect(all(a).filter(i => i.source === 'event').every(i => i.date !== null)).toBe(true);
  });
  it('same date: all-day before timed, timed by time', () => {
    const a = buildAgenda([], [
      event({ title: 'late', important: true, all_day: false, starts_at: '2026-11-24T15:00', tz: 'Asia/Shanghai' }),
      event({ title: 'early', important: true, all_day: false, starts_at: '2026-11-24T08:00', tz: 'Asia/Shanghai' }),
      event({ title: 'allday', important: true, starts_at: '2026-11-24' }),
    ], o());
    expect(titles(a)).toEqual(['allday', 'early', 'late']);
  });
  it('priority mode always has the three groups in order high, normal, low, empty ones included', () => {
    const a = buildAgenda([todo({ priority: 'low' })], [], o());
    expect(a.groups.map(g => g.priority)).toEqual(['high', 'normal', 'low']);
    expect(groupOf(a, 'high')).toEqual([]);
  });
  it('done items are never overdue', () => {
    const a = buildAgenda([todo({ title: 'od', due_date: '2026-11-01', done: true })], [], o({ showDone: true }));
    expect(a.done[0].overdue).toBe(false);
  });
  it('done list holds done todos and done important events, beyond the window, undated last by newest created', () => {
    const a = buildAgenda([
      todo({ title: 'far', done: true, due_date: '2027-03-01' }), todo({ title: 'undOld', done: true, created_at: '2026-11-01T00:00:00Z' }),
      todo({ title: 'undNew', done: true, created_at: '2026-11-09T00:00:00Z' }), goal({ title: 'goalDone', done: true }),
    ], [event({ title: 'evDone', important: true, done: true, starts_at: '2026-11-10' }), event({ title: 'plainDone', done: true })], o({ showDone: true }));
    expect(a.done.map(i => i.title)).toEqual(['far', 'evDone', 'undNew', 'undOld']);
  });
  it('purged records are ignored defensively', () => {
    expect(all(buildAgenda([todo({ purged_at: '2026-11-22T00:00:00Z' })], [], o()))).toEqual([]);
    expect(goalsOf([goal({ purged_at: '2026-11-22T00:00:00Z' })])).toEqual([]);
  });
  it('goalsOf puts a done goal after the open goals', () => {
    expect(goalsOf([goal({ title: 'd', done: true, created_at: '2026-11-25T00:00:00Z' }), goal({ title: 'o', created_at: '2026-11-01T00:00:00Z' })]).map(g => g.title)).toEqual(['o', 'd']);
  });
  it('an event item has source event, priority high and no time when all-day', () => {
    const [i] = all(buildAgenda([], [event({ important: true })], o()));
    expect(i).toMatchObject({ source: 'event', priority: 'high', time: null });
  });
});
