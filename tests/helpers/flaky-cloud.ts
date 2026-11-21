import { CloudError, type CloudClient, type CloudErrorKind } from '../../src/sync/cloud';

export type FlakyCloud = CloudClient & {
  /** The next `times` calls (of any method) throw `new CloudError(kind)`. `times = 0` clears it. */
  failNext(kind: CloudErrorKind, times?: number): void;
};

/** Wraps a CloudClient so tests can make the next calls fail. Methods are own properties, so `vi.spyOn` works. */
export function createFlakyCloud(inner: CloudClient): FlakyCloud {
  let kind: CloudErrorKind = 'network';
  let remaining = 0;

  function check(): void {
    if (remaining > 0) {
      remaining--;
      throw new CloudError(kind);
    }
  }

  return {
    failNext(k, times = 1) {
      kind = k;
      remaining = Math.max(0, times);
    },
    async push(op) { check(); return inner.push(op); },
    async pull(since, limit) { check(); return inner.pull(since, limit); },
    async purgeExpired() { check(); return inner.purgeExpired(); },
    async importBackup(payload, restorePurged) { check(); return inner.importBackup(payload, restorePurged); },
  };
}
