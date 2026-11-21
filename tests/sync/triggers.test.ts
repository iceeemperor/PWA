import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextRetryDelay, startSyncTriggers } from '../../src/sync/triggers';
import type { SyncReport } from '../../src/sync/engine';

function report(outcome: SyncReport['outcome']): SyncReport {
  return { outcome, pushed: 0, dropped: 0, failed: 0, pulled: 0, conflicts: 0 };
}

function fakeTarget() {
  const map = new Map<string, Set<() => void>>();
  return {
    addEventListener: (n: string, fn: () => void) => {
      if (!map.has(n)) map.set(n, new Set());
      map.get(n)!.add(fn);
    },
    removeEventListener: (n: string, fn: () => void) => { map.get(n)?.delete(fn); },
    fire: (n: string) => { for (const fn of [...(map.get(n) ?? [])]) fn(); },
    listeners: (n: string) => map.get(n)?.size ?? 0,
  };
}

describe('sync triggers', () => {
  let engine: { sync: ReturnType<typeof vi.fn> };
  let cloud: { purgeExpired: ReturnType<typeof vi.fn> };
  let win: ReturnType<typeof fakeTarget>;
  let doc: ReturnType<typeof fakeTarget> & { visibilityState: string };
  let changeListeners: Set<() => void>;
  let unsubscribed: number;
  const fireChange = () => { for (const fn of [...changeListeners]) fn(); };
  const repo = {
    onChange: (fn: () => void) => {
      changeListeners.add(fn);
      return () => { changeListeners.delete(fn); unsubscribed++; };
    },
  };
  const start = (extra: Record<string, unknown> = {}) =>
    startSyncTriggers({ engine: engine as never, repo, win: win as never, doc: doc as never, ...extra });

  beforeEach(() => {
    vi.useFakeTimers();
    engine = { sync: vi.fn().mockResolvedValue(report('ok')) };
    cloud = { purgeExpired: vi.fn().mockResolvedValue(undefined) };
    win = fakeTarget();
    doc = Object.assign(fakeTarget(), { visibilityState: 'hidden' });
    changeListeners = new Set();
    unsubscribed = 0;
  });
  afterEach(() => { vi.useRealTimers(); });

  it('syncs once at start', () => { start(); expect(engine.sync).toHaveBeenCalledTimes(1); });

  it('debounces writes by 2000 ms into one sync', async () => {
    start(); engine.sync.mockClear(); fireChange(); await vi.advanceTimersByTimeAsync(1000); fireChange(); await vi.advanceTimersByTimeAsync(1999);
    expect(engine.sync).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(1); expect(engine.sync).toHaveBeenCalledTimes(1);
  });

  it('syncs when the page becomes visible and when the network returns', () => {
    start(); engine.sync.mockClear(); doc.visibilityState = 'visible'; doc.fire('visibilitychange'); win.fire('online'); expect(engine.sync).toHaveBeenCalledTimes(2);
  });

  it('does not sync when the page becomes hidden', () => {
    start(); engine.sync.mockClear(); doc.visibilityState = 'hidden'; doc.fire('visibilitychange'); expect(engine.sync).not.toHaveBeenCalled();
  });

  it('retries with growing delays after offline or unavailable runs', async () => {
    engine.sync.mockResolvedValue(report('offline')); start(); await vi.advanceTimersByTimeAsync(0); engine.sync.mockClear();
    await vi.advanceTimersByTimeAsync(2000); expect(engine.sync).toHaveBeenCalledTimes(1); await vi.advanceTimersByTimeAsync(4000); expect(engine.sync).toHaveBeenCalledTimes(2);
  });

  it('retries after unavailable too', async () => {
    engine.sync.mockResolvedValue(report('unavailable')); start(); await vi.advanceTimersByTimeAsync(0); engine.sync.mockClear();
    await vi.advanceTimersByTimeAsync(2000); expect(engine.sync).toHaveBeenCalledTimes(1);
  });

  it('retries after a rejected sync without an unhandled rejection', async () => {
    engine.sync.mockRejectedValue(new Error('idb')); start(); await vi.advanceTimersByTimeAsync(0); engine.sync.mockClear();
    await vi.advanceTimersByTimeAsync(2000); expect(engine.sync).toHaveBeenCalledTimes(1);
  });

  it('does not retry after auth_expired', async () => {
    engine.sync.mockResolvedValue(report('auth_expired')); start(); await vi.advanceTimersByTimeAsync(0); engine.sync.mockClear();
    await vi.advanceTimersByTimeAsync(600000); expect(engine.sync).not.toHaveBeenCalled();
  });

  it('a successful run resets the retry delay', async () => {
    engine.sync.mockResolvedValue(report('offline')); start(); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000); // retry 1 fails again -> next delay would be 4000
    engine.sync.mockResolvedValueOnce(report('ok')); win.fire('online'); await vi.advanceTimersByTimeAsync(0); // ok: counter reset
    engine.sync.mockResolvedValue(report('offline')); win.fire('online'); await vi.advanceTimersByTimeAsync(0); engine.sync.mockClear();
    await vi.advanceTimersByTimeAsync(2000); expect(engine.sync).toHaveBeenCalledTimes(1);
  });

  it('another trigger replaces a pending retry', async () => {
    engine.sync.mockResolvedValue(report('offline')); start(); await vi.advanceTimersByTimeAsync(0);
    win.fire('online'); await vi.advanceTimersByTimeAsync(0); engine.sync.mockClear();
    // failures = 2 now, so one live retry timer at 4000 ms; the old 2000 ms timer must be gone
    await vi.advanceTimersByTimeAsync(3999); expect(engine.sync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(engine.sync).toHaveBeenCalledTimes(1);
  });

  it('nextRetryDelay doubles from 2000 and caps at 300000', () => { expect([0, 1, 2].map(nextRetryDelay)).toEqual([2000, 4000, 8000]); expect(nextRetryDelay(50)).toBe(300000); });

  it('purges once after the first successful sync when purgeOnStart is set, ignoring errors', async () => {
    cloud.purgeExpired.mockRejectedValue(new Error('x')); engine.sync.mockResolvedValue(report('ok')); start({ purgeOnStart: cloud });
    await vi.advanceTimersByTimeAsync(0); win.fire('online'); await vi.advanceTimersByTimeAsync(0);
    expect(cloud.purgeExpired).toHaveBeenCalledTimes(1);
  });

  it('does not purge after a failed sync', async () => {
    engine.sync.mockResolvedValue(report('offline')); start({ purgeOnStart: cloud }); await vi.advanceTimersByTimeAsync(0);
    expect(cloud.purgeExpired).not.toHaveBeenCalled();
  });

  it('stop removes every listener', () => {
    const stop = start(); stop();
    expect(win.listeners('online')).toBe(0); expect(doc.listeners('visibilitychange')).toBe(0); expect(unsubscribed).toBe(1);
  });

  it('stop clears a pending debounce and a pending retry', async () => {
    const stop = start(); await vi.advanceTimersByTimeAsync(0); engine.sync.mockClear();
    fireChange(); stop(); await vi.advanceTimersByTimeAsync(10000); expect(engine.sync).not.toHaveBeenCalled();
    engine.sync.mockResolvedValue(report('offline')); const stop2 = start(); await vi.advanceTimersByTimeAsync(0); engine.sync.mockClear();
    stop2(); await vi.advanceTimersByTimeAsync(10000); expect(engine.sync).not.toHaveBeenCalled();
  });
});
