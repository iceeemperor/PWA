// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LocalDbUnavailableError } from '../../src/data/local-db';
import { createFakeAuth } from '../helpers/fake-auth';
import { createTestServices } from '../helpers/ui-services';

const sw = vi.hoisted(() => ({
  needRefresh: false,
  setNeedRefresh: vi.fn(),
  updateServiceWorker: vi.fn(async (_reload?: boolean) => {}),
  /** How many times a mounted hook "registered" the worker, as the real hook does once per mount. */
  registrations: 0,
  registration: undefined as undefined | { installing: null; update: () => Promise<void> },
}));

vi.mock('virtual:pwa-register/react', async () => {
  const { useEffect } = await import('react');
  return {
    useRegisterSW: (opts?: { onRegisteredSW?: (url: string, r: unknown) => void }) => {
      useEffect(() => {
        sw.registrations++;
        opts?.onRegisteredSW?.('/sw.js', sw.registration);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return {
        needRefresh: [sw.needRefresh, sw.setNeedRefresh],
        offlineReady: [false, vi.fn()],
        updateServiceWorker: sw.updateServiceWorker,
      };
    },
  };
});

import { Root } from '../../src/ui/App';
import { UpdatePrompt } from '../../src/ui/UpdatePrompt';

function mockSW(o: { needRefresh: boolean }) {
  sw.needRefresh = o.needRefresh;
}

beforeEach(() => {
  sw.setNeedRefresh.mockClear();
  sw.updateServiceWorker.mockClear();
  sw.registrations = 0;
  sw.registration = { installing: null, update: vi.fn(async () => {}) };
});
afterEach(() => {
  vi.restoreAllMocks();
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

it('is on the login screen', async () => {
  mockSW({ needRefresh: true });
  const s = await createTestServices({ auth: createFakeAuth(null) });
  render(<Root create={async () => s} />);
  expect(await screen.findByLabelText('邮箱')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '更新' })).toBeInTheDocument();
});

it('is on the unavailable screen', async () => {
  mockSW({ needRefresh: true });
  render(<Root create={async () => { throw new LocalDbUnavailableError('no idb'); }} />);
  expect(await screen.findByText(/此浏览器无法保存本机数据/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '更新' })).toBeInTheDocument();
});

it('is on the start-up error and boot screens', async () => {
  mockSW({ needRefresh: true });
  let fail!: (e: Error) => void;
  render(<Root create={() => new Promise((_ok, no) => { fail = no; })} />);
  expect(screen.getByText('正在启动…')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '更新' })).toBeInTheDocument();
  fail(new Error('boom'));
  expect(await screen.findByText('启动失败')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '更新' })).toBeInTheDocument();
});

it('sign-in, sign-out and sign-in again registers the worker once, with one interval', async () => {
  mockSW({ needRefresh: false });
  const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
  const s = await createTestServices({ auth: createFakeAuth(null) });
  render(<Root create={async () => s} />);
  const signIn = async () => {
    await userEvent.type(await screen.findByLabelText('邮箱'), 'me@example.com');
    await userEvent.type(screen.getByLabelText('密码'), 'secret');
    await userEvent.click(screen.getByRole('button', { name: '登录' }));
    await screen.findByText('退出登录');
  };
  await signIn();
  await userEvent.click(screen.getByText('退出登录'));
  await signIn();
  expect(sw.registrations).toBe(1);
  expect(setIntervalSpy.mock.calls.filter(([, ms]) => ms === 60 * 60 * 1000)).toHaveLength(1);
});

it('unmount clears the update-check interval and the visibility listener', () => {
  const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
  const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
  const addSpy = vi.spyOn(document, 'addEventListener');
  const removeSpy = vi.spyOn(document, 'removeEventListener');

  const { unmount } = render(<UpdatePrompt />);
  const hourly = setIntervalSpy.mock.results[setIntervalSpy.mock.calls.findIndex(([, ms]) => ms === 60 * 60 * 1000)];
  expect(hourly).toBeDefined();
  const added = addSpy.mock.calls.find(([type]) => type === 'visibilitychange');
  expect(added).toBeDefined();

  unmount();
  expect(clearIntervalSpy).toHaveBeenCalledWith(hourly.value);
  expect(removeSpy).toHaveBeenCalledWith('visibilitychange', added![1]);

  // A visibility change after unmount no longer checks for updates.
  document.dispatchEvent(new Event('visibilitychange'));
  expect(sw.registration!.update).not.toHaveBeenCalled();
});
