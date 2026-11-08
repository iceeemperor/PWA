// Shared domain types. Stage 1 has a single synced table (`todos`); the
// table-keyed helper types below are the extension point for later stages.

export type TableName = 'todos';
export const TABLES: readonly TableName[] = ['todos'];

export interface CommonFields {
  id: string;
  user_id: string;
  created_at: string;
  updated_at: string;
  rev: number;
  deleted_at: string | null;
  purged_at: string | null;
}

export interface Step {
  id: string;
  text: string;
  done: boolean;
}

export interface TodoFields {
  kind: 'todo' | 'goal';
  title: string;
  done: boolean;
  priority: 'high' | 'normal' | 'low';
  due_date: string | null;
  note: string;
  steps: Step[];
}

export type TodoRecord = CommonFields & TodoFields;

interface FieldsByTable {
  todos: TodoFields;
}

interface NewFieldsByTable {
  todos: Pick<TodoFields, 'title'> & Partial<Omit<TodoFields, 'title'>>;
}

export type FieldsOf<T extends TableName> = FieldsByTable[T];
export type RecordOf<T extends TableName> = CommonFields & FieldsOf<T>;
export type NewFields<T extends TableName> = NewFieldsByTable[T];

// Local upload queue and the cloud push/pull contract.
export type OpKind = 'insert' | 'update' | 'delete' | 'restore';

export interface QueuedOp {
  seq: number;
  op_id: string;
  table: TableName;
  id: string;
  kind: OpKind;
  base_rev: number | null;
  fields: Record<string, unknown>;
  failed: { reason: string } | null;
}

export type PushOp = Omit<QueuedOp, 'seq' | 'failed'>;

export type PushStatus = 'applied' | 'dropped_trashed' | 'dropped_purged' | 'invalid';

export interface PushResult {
  status: PushStatus;
  conflict: boolean;
  rev: number | null;
  record: Record<string, unknown> | null;
  message: string | null;
}

export interface PullPage {
  rows: { table: TableName; row: Record<string, unknown> }[];
  has_more: boolean;
}

// Export / import (backup file).
export type BackupTableKey = 'events' | 'event_overrides' | 'todos' | 'notes' | 'journal';

export const BACKUP_FORMAT = 'productivity-app-export' as const;
export const BACKUP_VERSION = 1 as const;
export const BACKUP_TABLE_KEYS: readonly BackupTableKey[] = [
  'events',
  'event_overrides',
  'todos',
  'notes',
  'journal',
];

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  exported_at: string;
  tables: Record<BackupTableKey, Record<string, unknown>[]>;
}

export interface ImportSummary {
  added: number;
  restored: number;
  skipped: Record<string, number>;
}
