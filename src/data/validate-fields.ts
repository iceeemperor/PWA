import type { TodoFields } from '../domain/types';

/** The fields of a record break a rule (blank title, malformed date, unknown enum value). */
export class InvalidRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRecordError';
  }
}

const KINDS: readonly string[] = ['todo', 'goal'];
const PRIORITIES: readonly string[] = ['high', 'normal', 'low'];
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` that names a real calendar day (2026-02-30 is not one; the cloud `date` column would refuse it). */
function isCalendarDate(s: unknown): boolean {
  if (typeof s !== 'string') return false;
  const m = DATE_PATTERN.exec(s);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/** Checks the fields that are present; absent (`undefined`) ones are skipped, so it also fits partial updates. */
export function validateTodoFields(f: Partial<TodoFields>): void {
  if (f.title !== undefined && (typeof f.title !== 'string' || f.title.trim() === '')) {
    throw new InvalidRecordError('title must not be empty');
  }
  if (f.due_date !== undefined && f.due_date !== null && !isCalendarDate(f.due_date)) {
    throw new InvalidRecordError('due_date must be a date in the form YYYY-MM-DD');
  }
  if (f.kind !== undefined && !KINDS.includes(f.kind)) {
    throw new InvalidRecordError(`kind must be one of: ${KINDS.join(', ')}`);
  }
  if (f.priority !== undefined && !PRIORITIES.includes(f.priority)) {
    throw new InvalidRecordError(`priority must be one of: ${PRIORITIES.join(', ')}`);
  }
}
