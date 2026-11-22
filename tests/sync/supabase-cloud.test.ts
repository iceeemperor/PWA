import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackupFile, PushOp } from '../../src/domain/types';
import { CloudError } from '../../src/sync/cloud';
import { createSupabaseCloud, mapSupabaseError } from '../../src/sync/supabase-cloud';

const op: PushOp = {
  op_id: 'op-1',
  table: 'todos',
  id: 'id-1',
  kind: 'update',
  base_rev: 2,
  fields: { title: 'x' },
};
const backup = {
  format: 'productivity-app-export',
  version: 1,
  exported_at: '2026-01-01T00:00:00Z',
  tables: { events: [], event_overrides: [], todos: [], notes: [], journal: [] },
} as BackupFile;

describe('mapSupabaseError', () => {
  it('maps fetch failures to network', () =>
    expect(mapSupabaseError(new TypeError('Failed to fetch')).kind).toBe('network'));
  it('maps 401 and PGRST301/303 to auth', () => {
    expect(mapSupabaseError({ status: 401 }).kind).toBe('auth');
    expect(mapSupabaseError({ code: 'PGRST301' }).kind).toBe('auth');
    expect(mapSupabaseError({ code: 'PGRST303' }).kind).toBe('auth');
  });
  it('maps not_authenticated (28000) to auth even on a 403', () => {
    expect(mapSupabaseError({ status: 403, code: '28000', message: 'not_authenticated' }).kind).toBe('auth');
    expect(mapSupabaseError({ message: 'not_authenticated' }).kind).toBe('auth');
    expect(mapSupabaseError({ code: '28000' }).kind).toBe('auth');
  });
  it('maps 42501 (anon without a session) to rejected', () =>
    expect(mapSupabaseError({ status: 403, code: '42501', message: 'permission denied' }).kind).toBe('rejected'));
  it('maps 5xx and paused-project responses to unavailable', () => {
    expect(mapSupabaseError({ status: 503 }).kind).toBe('unavailable');
    expect(mapSupabaseError({ status: 500 }).kind).toBe('unavailable');
    expect(mapSupabaseError({ message: 'project is paused' }).kind).toBe('unavailable');
  });
  it('maps Postgres data errors (23xxx) and other 4xx to rejected', () => {
    expect(mapSupabaseError({ code: '23514' }).kind).toBe('rejected');
    expect(mapSupabaseError({ status: 400 }).kind).toBe('rejected');
  });
  it('returns an existing CloudError unchanged', () => {
    const e = new CloudError('network');
    expect(mapSupabaseError(e)).toBe(e);
  });
});

describe('createSupabaseCloud', () => {
  it('push calls the rpc with the table and op and returns the data', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { status: 'applied', conflict: false, rev: 3, record: {}, message: null },
      error: null,
    });
    const r = await createSupabaseCloud({ rpc } as any).push({ ...op, seq: 9, failed: null } as PushOp);
    expect(rpc).toHaveBeenCalledWith('push_change', {
      p_table: 'todos',
      p_op: { op_id: op.op_id, id: op.id, kind: op.kind, base_rev: op.base_rev, fields: op.fields },
    });
    expect(r.rev).toBe(3);
  });
  it('pull, purgeExpired and importBackup use the agreed rpc names and arguments', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { rows: [], has_more: false }, error: null });
    const c = createSupabaseCloud({ rpc } as any);
    await c.pull(5, 10);
    expect(rpc).toHaveBeenLastCalledWith('pull_changes', { p_since: 5, p_limit: 10 });
    await c.purgeExpired();
    expect(rpc).toHaveBeenLastCalledWith('purge_expired');
    await c.importBackup(backup, true);
    expect(rpc).toHaveBeenLastCalledWith('import_backup', { p_payload: backup, p_restore_purged: true });
  });
  it('an rpc error is thrown as a CloudError', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { status: 401, message: 'JWT expired' } });
    await expect(createSupabaseCloud({ rpc } as any).pull(0, 10)).rejects.toMatchObject({ kind: 'auth' });
  });
  it('uses the response status when it is not on the error', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, status: 503, error: { message: 'oops', code: '' } });
    await expect(createSupabaseCloud({ rpc } as any).pull(0, 10)).rejects.toMatchObject({ kind: 'unavailable' });
    const rpc2 = vi.fn().mockResolvedValue({ data: null, status: 403, error: { code: '28000', message: 'not_authenticated' } });
    await expect(createSupabaseCloud({ rpc: rpc2 } as any).purgeExpired()).rejects.toMatchObject({ kind: 'auth' });
  });
  it('a thrown fetch failure becomes a network CloudError', async () => {
    const rpc = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(createSupabaseCloud({ rpc } as any).pull(0, 10)).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('getSupabase', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });
  it('names the missing variable', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'k');
    const { getSupabase } = await import('../../src/supabase');
    expect(() => getSupabase()).toThrow(/VITE_SUPABASE_URL/);
    vi.stubEnv('VITE_SUPABASE_URL', 'http://localhost:54321');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');
    expect(() => getSupabase()).toThrow(/VITE_SUPABASE_ANON_KEY/);
  });
  it('creates the client once', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'http://localhost:54321');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon');
    const { getSupabase } = await import('../../src/supabase');
    expect(getSupabase()).toBe(getSupabase());
  });
});

// What postgrest-js resolves (it does not throw) when fetch itself fails: status 0 and the browser's TypeError text.
function fetchFailure(message: string) {
  return {
    error: { message, details: 'TypeError: ' + message, hint: '', code: '' },
    data: null,
    count: null,
    status: 0,
    statusText: '',
  };
}

describe('createSupabaseCloud: a fetch failure postgrest-js resolves with status 0', () => {
  it.each([
    ['Safari', 'TypeError: Load failed'],
    ['Chrome', 'TypeError: Failed to fetch'],
    ['Firefox', 'TypeError: NetworkError when attempting to fetch resource.'],
  ])('%s: push and pull reject with a network CloudError', async (_browser, message) => {
    const rpc = vi.fn().mockResolvedValue(fetchFailure(message));
    const c = createSupabaseCloud({ rpc } as any);
    const pushed = await c.push(op).then(() => null, (e: unknown) => e);
    expect(pushed).toBeInstanceOf(CloudError);
    expect((pushed as CloudError).kind).toBe('network');
    await expect(c.pull(0, 10)).rejects.toMatchObject({ kind: 'network' });
  });

  it('status 0 is network whatever the message', async () => {
    const rpc = vi.fn().mockResolvedValue({ ...fetchFailure('AbortError: signal is aborted without reason'), status: 0 });
    await expect(createSupabaseCloud({ rpc } as any).push(op)).rejects.toMatchObject({ kind: 'network' });
    expect(mapSupabaseError({ status: 0, message: 'something odd' }).kind).toBe('network');
  });
});

describe('mapSupabaseError: fetch failures without a status', () => {
  it.each([
    'TypeError: Load failed',
    'Load failed',
    'Failed to fetch',
    'NetworkError when attempting to fetch resource.',
    'Network request failed',
    'AbortError: The operation was aborted.',
    'TimeoutError: signal timed out',
  ])('%s is network', (message) => expect(mapSupabaseError({ message, code: '' }).kind).toBe('network'));

  it('an AbortError or TimeoutError by name is network', () => {
    expect(mapSupabaseError(new DOMException('aborted', 'AbortError')).kind).toBe('network');
    expect(mapSupabaseError({ name: 'TimeoutError', message: 'x' }).kind).toBe('network');
  });

  it('a 400 that mentions a fetch word is not network', () =>
    expect(mapSupabaseError({ status: 400, message: 'failed to fetch the row' }).kind).toBe('rejected'));
});
