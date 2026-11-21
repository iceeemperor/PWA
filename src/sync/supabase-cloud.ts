import type { SupabaseClient } from '@supabase/supabase-js';
import type { BackupFile, ImportSummary, PullPage, PushOp, PushResult } from '../domain/types';
import { CloudError, type CloudClient } from './cloud';

interface ErrorLike {
  status?: unknown;
  code?: unknown;
  message?: unknown;
}

/**
 * Classifies a Supabase/PostgREST failure.
 * Note: 42501 (anon role without a session) stays `rejected`; it should not occur in-app.
 */
export function mapSupabaseError(e: unknown): CloudError {
  if (e instanceof CloudError) return e;
  const err: ErrorLike = typeof e === 'object' && e !== null ? (e as ErrorLike) : {};
  const status = typeof err.status === 'number' ? err.status : undefined;
  const code = typeof err.code === 'string' ? err.code : '';
  const message = typeof err.message === 'string' ? err.message : e instanceof Error ? e.message : String(e);
  const lower = message.toLowerCase();
  const make = (kind: CloudError['kind']) => new CloudError(kind, message, { cause: e });

  if (e instanceof TypeError || (status === undefined && (lower.includes('fetch') || lower.includes('network')))) {
    return make('network');
  }
  if (
    status === 401 ||
    code === 'PGRST301' ||
    code === 'PGRST303' ||
    code === '28000' ||
    lower.includes('not_authenticated')
  ) {
    return make('auth');
  }
  if ((status !== undefined && status >= 500) || lower.includes('paused')) return make('unavailable');
  return make('rejected');
}

type Rpc = Pick<SupabaseClient, 'rpc'>;

export function createSupabaseCloud(client: Rpc): CloudClient {
  async function call<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
    let res: { data: unknown; error: unknown; status?: number };
    try {
      res = (await (args === undefined ? client.rpc(fn) : client.rpc(fn, args))) as typeof res;
    } catch (e) {
      throw mapSupabaseError(e);
    }
    if (res.error) {
      // supabase-js puts the HTTP status on the response, not on the PostgrestError.
      const err = typeof res.error === 'object' ? (res.error as ErrorLike) : { message: String(res.error) };
      throw mapSupabaseError(err.status === undefined && res.status !== undefined ? { ...err, status: res.status } : err);
    }
    return res.data as T;
  }

  return {
    push: (op: PushOp) =>
      call<PushResult>('push_change', {
        p_table: op.table,
        p_op: { op_id: op.op_id, id: op.id, kind: op.kind, base_rev: op.base_rev, fields: op.fields },
      }),
    pull: (sinceRev, limit) => call<PullPage>('pull_changes', { p_since: sinceRev, p_limit: limit }),
    purgeExpired: async () => {
      await call<unknown>('purge_expired');
    },
    importBackup: (payload: BackupFile, restorePurged: boolean) =>
      call<ImportSummary>('import_backup', { p_payload: payload, p_restore_purged: restorePurged }),
  };
}
