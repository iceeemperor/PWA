// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { SyncStatus } from '../../src/sync/engine';
import { SyncBanner } from '../../src/ui/SyncBanner';

function renderBanner(s: Partial<SyncStatus>): HTMLElement {
  const status: SyncStatus = { state: 'idle', pending: 0, failed: 0, lastSyncedAt: null, conflicts: 0, ...s };
  return render(<SyncBanner status={status} />).container;
}

it('SyncBanner shows pending, offline, unavailable and failed states', () => {
  expect(renderBanner({ state: 'idle', pending: 3, failed: 0 })).toHaveTextContent('未同步 3 项');
  expect(renderBanner({ state: 'offline' })).toHaveTextContent('离线');
  expect(renderBanner({ state: 'unavailable' })).toHaveTextContent('云端暂时无法连接');
  expect(renderBanner({ failed: 2 })).toHaveTextContent('同步失败 2 项');
});

it('shows 已同步 when nothing is pending and the cloud is reachable', () => {
  const el = renderBanner({ state: 'idle', lastSyncedAt: new Date().toISOString() });
  expect(el).toHaveTextContent('已同步');
  expect(el).not.toHaveTextContent('未同步');
});

it('offline with a queue shows both, so the queue is never hidden', () => {
  const el = renderBanner({ state: 'offline', pending: 2 });
  expect(el).toHaveTextContent('离线');
  expect(el).toHaveTextContent('未同步 2 项');
});
