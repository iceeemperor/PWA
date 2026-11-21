import { z } from 'zod';
import { isUuid } from '../domain/ids';
import {
  BACKUP_FORMAT,
  BACKUP_TABLE_KEYS,
  BACKUP_VERSION,
  type BackupFile,
  type BackupTableKey,
} from '../domain/types';

export type ValidationResult = { ok: true; backup: BackupFile } | { ok: false; errors: string[] };

export const MAX_VALIDATION_ERRORS = 20;

/** child table -> { column -> parent table }. Empty in stage 1; stage 3 adds event_overrides. */
export const REFERENCES: Record<string, Record<string, string>> = {};

const SUPPORTED_TABLES: readonly BackupTableKey[] = ['todos'];

function isCalendarDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

const datetime = z.iso.datetime({ offset: true });

const stepSchema = z.strictObject({ id: z.string().min(1), text: z.string(), done: z.boolean() });

// Same rules as supabase core.sql and data/validate-fields.ts. user_id, rev and purged_at are never exported.
const todoSchema = z.strictObject({
  id: z.string().refine(isUuid, 'must be a UUID'),
  kind: z.enum(['todo', 'goal']),
  title: z.string().refine((s) => s.trim() !== '', 'must not be empty'),
  done: z.boolean(),
  priority: z.enum(['high', 'normal', 'low']),
  due_date: z.string().refine(isCalendarDate, 'must be a date in the form YYYY-MM-DD').nullable(),
  note: z.string(),
  steps: z.array(stepSchema),
  created_at: datetime,
  updated_at: datetime,
  deleted_at: datetime.nullable(),
});

const rowSchemas: Partial<Record<BackupTableKey, z.ZodType>> = { todos: todoSchema };

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function fail(errors: string[]): ValidationResult {
  return { ok: false, errors: errors.slice(0, MAX_VALIDATION_ERRORS) };
}

/** Never throws, whatever the input. */
export function validateBackup(input: unknown): ValidationResult {
  try {
    return validate(input);
  } catch {
    return fail(['The file could not be checked.']);
  }
}

function validate(input: unknown): ValidationResult {
  if (!isObject(input)) return fail(['The file must contain a JSON object.']);
  if (input.format !== BACKUP_FORMAT) return fail(['This is not a backup file from this app (wrong format).']);
  if (input.version !== BACKUP_VERSION) {
    return fail([`Unsupported backup version (this app reads version ${BACKUP_VERSION}).`]);
  }
  if (!datetime.safeParse(input.exported_at).success) return fail(['exported_at: must be an ISO 8601 date-time.']);
  if (!isObject(input.tables)) return fail(['tables: must be an object.']);

  const errors: string[] = [];
  // Returns true once the cap is reached, so callers can stop early.
  const push = (msg: string): boolean => {
    if (errors.length < MAX_VALIDATION_ERRORS) errors.push(msg);
    return errors.length >= MAX_VALIDATION_ERRORS;
  };
  const tables = input.tables;
  const known: readonly string[] = BACKUP_TABLE_KEYS;

  for (const key of Object.keys(tables)) {
    if (!known.includes(key) && push(`tables.${key}: unknown table.`)) return fail(errors);
  }

  const clean = {} as Record<BackupTableKey, Record<string, unknown>[]>;
  const ids = {} as Record<string, Set<string>>;
  for (const key of BACKUP_TABLE_KEYS) {
    clean[key] = [];
    ids[key] = new Set();
    const rows = tables[key];
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) {
      if (push(`${key}: must be an array.`)) return fail(errors);
      continue;
    }
    if (!SUPPORTED_TABLES.includes(key)) {
      if (rows.length > 0 && push(`${key}: ${rows.length} row(s) found but this table is not supported yet.`)) {
        return fail(errors);
      }
      continue;
    }
    const schema = rowSchemas[key]!;
    for (let i = 0; i < rows.length; i++) {
      const parsed = schema.safeParse(rows[i]);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          const path = issue.path.map(String).join('.');
          const where = `${key}[${i}]` + (path ? `.${path}` : '');
          const what = issue.code === 'unrecognized_keys' ? `unknown field(s) ${issue.keys.join(', ')}` : issue.message;
          if (push(`${where}: ${what}`)) return fail(errors);
        }
        continue;
      }
      const id = (parsed.data as { id: string }).id;
      if (ids[key].has(id)) {
        if (push(`${key}[${i}].id: duplicate id within the file.`)) return fail(errors);
        continue;
      }
      ids[key].add(id);
      clean[key].push(parsed.data as Record<string, unknown>);
    }
  }

  for (const [child, cols] of Object.entries(REFERENCES)) {
    const rows = clean[child as BackupTableKey] ?? [];
    rows.forEach((row, i) => {
      for (const [col, parent] of Object.entries(cols)) {
        const v = row[col];
        if (typeof v !== 'string' || !ids[parent]?.has(v)) {
          push(`${child}[${i}].${col}: refers to a ${parent} record that is not in the file.`);
        }
      }
    });
  }

  if (errors.length > 0) return fail(errors);
  return {
    ok: true,
    backup: { format: BACKUP_FORMAT, version: BACKUP_VERSION, exported_at: input.exported_at as string, tables: clean },
  };
}

export function parseAndValidateBackup(text: string): ValidationResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return fail(['File is not valid JSON. Choose a backup file exported from this app.']);
  }
  return validateBackup(data);
}
