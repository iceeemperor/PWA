// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Services } from '../../src/app/services';
import { Root } from '../../src/ui/App';
import { createFakeAuth } from '../helpers/fake-auth';
import { createTestServices } from '../helpers/ui-services';

afterEach(() => {
  vi.unstubAllGlobals();
});

it('shows the unavailable screen when IndexedDB is not available', async () => {
  vi.stubGlobal('indexedDB', undefined);
  render(<Root />);
  expect(await screen.findByText(/此浏览器无法保存本机数据.*无痕/)).toBeInTheDocument();
});

it('shows a generic start-up error for other failures', async () => {
  render(
    <Root
      create={async () => {
        throw new Error('Missing environment variable VITE_SUPABASE_URL');
      }}
    />,
  );
  expect(await screen.findByText(/启动失败/)).toBeInTheDocument();
  expect(screen.getByText(/VITE_SUPABASE_URL/)).toBeInTheDocument();
});

describe('local database version change', () => {
  it('while another tab holds the old version open, the start screen asks to close it; then the app starts', async () => {
    const services = await createTestServices({ auth: createFakeAuth(null) });
    let finish!: (s: Services) => void;
    render(
      <Root
        create={(o) => {
          o.onBlocked();
          return new Promise<Services>((resolve) => (finish = resolve));
        }}
      />,
    );
    expect(await screen.findByText('请关闭其他打开着本应用的标签页或窗口')).toBeInTheDocument();
    expect(screen.getByText(/正在启动/)).toBeInTheDocument();
    finish(services);
    expect(await screen.findByRole('button', { name: '登录' })).toBeInTheDocument();
    expect(screen.queryByText('请关闭其他打开着本应用的标签页或窗口')).not.toBeInTheDocument();
  });

  it('when another tab upgrades the database, the app is replaced by a prompt to refresh', async () => {
    const services = await createTestServices({ auth: createFakeAuth(null) });
    let signal!: () => void;
    const reload = vi.fn();
    render(
      <Root
        reload={reload}
        create={async (o) => {
          signal = o.onVersionChange;
          return services;
        }}
      />,
    );
    expect(await screen.findByRole('button', { name: '登录' })).toBeInTheDocument();
    act(() => signal());
    expect(await screen.findByText('应用已在另一个标签页更新，请刷新')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '登录' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a version change during boot wins over the boot finishing afterwards', async () => {
    const services = await createTestServices({ auth: createFakeAuth(null) });
    render(
      <Root
        create={async (o) => {
          o.onVersionChange();
          return services;
        }}
      />,
    );
    expect(await screen.findByText('应用已在另一个标签页更新，请刷新')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button', { name: '登录' })).not.toBeInTheDocument();
  });
});
