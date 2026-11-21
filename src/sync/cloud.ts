import type { BackupFile, ImportSummary, PullPage, PushOp, PushResult } from '../domain/types';

export type CloudErrorKind = 'network' | 'auth' | 'unavailable' | 'rejected';

/**
 * A cloud call that did not produce a result.
 * - `network`: no connection or the request was lost; retry later with the same op.
 * - `auth`: not signed in or the session expired; sign in again, the queue is kept.
 * - `unavailable`: the cloud is reachable but not serving (paused project, 5xx); retry later.
 * - `rejected`: the cloud refused this request as invalid; retrying the same request will not help.
 */
export class CloudError extends Error {
  readonly kind: CloudErrorKind;

  constructor(kind: CloudErrorKind, message: string = `cloud error: ${kind}`, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CloudError';
    this.kind = kind;
  }
}

/** The server side of sync. Every method throws `CloudError` when the call itself fails. */
export interface CloudClient {
  push(op: PushOp): Promise<PushResult>;
  pull(sinceRev: number, limit: number): Promise<PullPage>;
  purgeExpired(): Promise<void>;
  importBackup(payload: BackupFile, restorePurged: boolean): Promise<ImportSummary>;
}
