import type { TodoFields } from '../domain/types';

/** The fields of a record break a rule (blank title, malformed date, unknown enum value). */
export class InvalidRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRecordError';
  }
}

// One set of field rules (F4). The same rules live in backup/validate.ts (todo rows use these helpers; event rows go to validateEventFields), in push_change
// and in the table CHECKs (supabase/migrations/20261106000600_harden.sql); tests/db/field-rules.test.ts keeps them equal.

export const KINDS: readonly string[] = ['todo', 'goal'];
export const PRIORITIES: readonly string[] = ['high', 'normal', 'low'];
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
// RFC 3339 with seconds and a zone, as zod's z.iso.datetime({ offset: true }) and push_change accept it.
const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

/** No U+0000: Postgres text and jsonb cannot hold it, so such a value could never sync. */
export const hasNoNul = (s: string): boolean => !s.includes('\u0000');

// A lone surrogate half (a high not followed by a low, or a low not after a high). No lookbehind: Safari 16.0-16.3
// would fail to parse this whole module.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Well-formed UTF-16 (no lone surrogate): Postgres refuses such a string as JSON, so it could never sync. Uses
 * String.prototype.isWellFormed where the engine has it (Safari 16.4+), a regex otherwise (Safari 16.0-16.3).
 */
export const isWellFormed = (s: string): boolean =>
  typeof (s as { isWellFormed?: unknown }).isWellFormed === 'function'
    ? (s as string & { isWellFormed(): boolean }).isWellFormed()
    : !LONE_SURROGATE.test(s);

/** Text the cloud can store: no U+0000 and no lone surrogate. */
export const isStorableText = (s: string): boolean => hasNoNul(s) && isWellFormed(s);

/** Not blank after trimming (JS whitespace; the SQL CHECK trims the same characters). */
export const isNonBlank = (s: string): boolean => s.trim() !== '';

function isRealDay(year: number, month: number, day: number): boolean {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/** `YYYY-MM-DD` that names a real calendar day in the years 0001–9999 (the range of the cloud `date` CHECK). */
export function isCalendarDate(s: unknown): boolean {
  if (typeof s !== 'string') return false;
  const m = DATE_PATTERN.exec(s);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return year >= 1 && isRealDay(year, month, day);
}

/** An ISO 8601 timestamp with a zone, on a real day, whose instant lies in the UTC years 2000–9999. */
export function isCreatedAt(s: unknown): boolean {
  if (typeof s !== 'string') return false;
  const m = TIMESTAMP_PATTERN.exec(s);
  if (!m || !isRealDay(Number(m[1]), Number(m[2]), Number(m[3]))) return false;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return false;
  const year = new Date(ms).getUTCFullYear();
  return year >= 2000 && year <= 9999;
}

/** `{ id: non-empty string, text: string, done: boolean }` and no other keys; no U+0000 or lone surrogate in the strings. */
export function isStep(x: unknown): boolean {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const o = x as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== 3 || !keys.every((k) => k === 'id' || k === 'text' || k === 'done')) return false;
  return (
    typeof o.id === 'string' && o.id !== '' && isStorableText(o.id) &&
    typeof o.text === 'string' && isStorableText(o.text) &&
    typeof o.done === 'boolean'
  );
}

type CheckedFields = Partial<TodoFields> & { created_at?: unknown };

/**
 * Checks the fields that are present; absent (`undefined`) ones are skipped, so it also fits partial updates.
 * `created_at` is checked too when given (the Repo sets it itself).
 */
export function validateTodoFields(input: Partial<TodoFields>): void {
  const f = input as Record<keyof CheckedFields, unknown>;
  if (f.title !== undefined && (typeof f.title !== 'string' || !isNonBlank(f.title) || !isStorableText(f.title))) {
    throw new InvalidRecordError('title must be text that is not empty');
  }
  if (f.done !== undefined && typeof f.done !== 'boolean') {
    throw new InvalidRecordError('done must be true or false');
  }
  if (f.kind !== undefined && (typeof f.kind !== 'string' || !KINDS.includes(f.kind))) {
    throw new InvalidRecordError(`kind must be one of: ${KINDS.join(', ')}`);
  }
  if (f.priority !== undefined && (typeof f.priority !== 'string' || !PRIORITIES.includes(f.priority))) {
    throw new InvalidRecordError(`priority must be one of: ${PRIORITIES.join(', ')}`);
  }
  if (f.note !== undefined && (typeof f.note !== 'string' || !isStorableText(f.note))) {
    throw new InvalidRecordError('note must be text');
  }
  if (f.due_date !== undefined && f.due_date !== null && !isCalendarDate(f.due_date)) {
    throw new InvalidRecordError('due_date must be a date in the form YYYY-MM-DD');
  }
  if (f.steps !== undefined && (!Array.isArray(f.steps) || !f.steps.every(isStep))) {
    throw new InvalidRecordError('steps must be a list of { id, text, done }');
  }
  if (f.created_at !== undefined && !isCreatedAt(f.created_at)) {
    throw new InvalidRecordError('created_at must be an ISO 8601 date-time between the years 2000 and 9999');
  }
}
