import { describe, expect, it } from 'vitest';
import { contentKeys, TABLE_DEFAULTS } from '../../src/domain/tables';
import { TABLES } from '../../src/domain/types';

describe('table defaults', () => {
  it('TABLES lists todos and events', () => {
    expect([...TABLES]).toEqual(['todos', 'events']);
  });

  it('TABLE_DEFAULTS equals the SQL column defaults', () => {
    expect(TABLE_DEFAULTS.todos).toEqual({ kind: 'todo', title: '', done: false, priority: 'normal', due_date: null, note: '', steps: [] });
    expect(TABLE_DEFAULTS.events).toEqual({
      title: '', all_day: true, starts_at: '', ends_at: null, tz: null, note: '', important: false, done: false, rrule: null,
    });
  });

  it('TABLE_DEFAULTS lists exactly the content fields of each record type', () => {
    expect(contentKeys('todos').sort()).toEqual(['done', 'due_date', 'kind', 'note', 'priority', 'steps', 'title']);
    expect(contentKeys('events').sort()).toEqual(['all_day', 'done', 'ends_at', 'important', 'note', 'rrule', 'starts_at', 'title', 'tz']);
  });

  it('the defaults cannot be changed by accident', () => {
    expect(Object.isFrozen(TABLE_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(TABLE_DEFAULTS.todos)).toBe(true);
    expect(Object.isFrozen(TABLE_DEFAULTS.todos.steps)).toBe(true);
    expect(Object.isFrozen(TABLE_DEFAULTS.events)).toBe(true);
  });
});
