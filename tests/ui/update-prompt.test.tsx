// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';

const sw = vi.hoisted(() => ({
  needRefresh: false,
  setNeedRefresh: vi.fn(),
  updateServiceWorker: vi.fn(async (_reload?: boolean) => {}),
}));

vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: () => ({
    needRefresh: [sw.needRefresh, sw.setNeedRefresh],
    offlineReady: [false, vi.fn()],
    updateServiceWorker: sw.updateServiceWorker,
  }),
}));

import { UpdatePrompt } from '../../src/ui/UpdatePrompt';

function mockSW(o: { needRefresh: boolean }) {
  sw.needRefresh = o.needRefresh;
}

beforeEach(() => {
  sw.setNeedRefresh.mockClear();
  sw.updateServiceWorker.mockClear();
});

it('UpdatePrompt offers a reload button when a new version is waiting', async () => {
  mockSW({ needRefresh: true });
  render(<UpdatePrompt />);
  expect(screen.getByRole('button', { name: '更新' })).toBeInTheDocument();
});

it('clicking 更新 activates the waiting service worker', async () => {
  mockSW({ needRefresh: true });
  render(<UpdatePrompt />);
  await userEvent.click(screen.getByRole('button', { name: '更新' }));
  expect(sw.updateServiceWorker).toHaveBeenCalledWith(true);
});

it('shows nothing when no new version is waiting', () => {
  mockSW({ needRefresh: false });
  render(<UpdatePrompt />);
  expect(screen.queryByRole('button', { name: '更新' })).toBeNull();
});
