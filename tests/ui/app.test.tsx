// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/ui/App';
import { Shell } from '../../src/ui/Shell';
import { CloudError } from '../../src/sync/cloud';
import { createFakeAuth, type FakeAuth } from '../helpers/fake-auth';
import { createTestServices } from '../helpers/ui-services';
import type { Services } from '../../src/app/services';

let services: Services & { auth: FakeAuth };
let auth: FakeAuth;
let repo: Services['repo'];

beforeEach(async () => {
  services = await createTestServices();
  auth = services.auth;
  repo = services.repo;
});
afterEach(() => {
  vi.restoreAllMocks();
});

function renderShell(p: { confirmFn?: (msg: string) => boolean } = {}) {
  return render(<Shell services={services} confirmFn={p.confirmFn} />);
}

async function submitLogin() {
  const email = screen.getByLabelText('邮箱');
  const password = screen.getByLabelText('密码');
  await userEvent.clear(email);
  await userEvent.type(email, 'me@example.com');
  await userEvent.clear(password);
  await userEvent.type(password, 'secret');
  await userEvent.click(screen.getByRole('button', { name: '登录' }));
}

describe('App: login and session (brief)', () => {
  it('shows the login page when there is no session', async () => {
    render(<App services={{ ...services, auth: createFakeAuth(null) }} />);
    expect(await screen.findByLabelText('邮箱')).toBeInTheDocument();
    expect(screen.getByLabelText('密码')).toBeInTheDocument();
  });

  it('shows distinct messages for wrong credentials, network failure and unknown errors', async () => {
    auth = createFakeAuth(null);
    render(<App services={{ ...services, auth }} />);
    await screen.findByLabelText('邮箱');
    for (const [reason, text] of [
      ['invalid_credentials', '邮箱或密码不对'],
      ['network', '网络连接失败，请检查网络后重试'],
      ['unknown', '登录失败，请稍后再试'],
    ] as const) {
      auth.setSignInResult({ ok: false, reason });
      await submitLogin();
      expect(await screen.findByText(text)).toBeInTheDocument();
    }
  });

  it('an unknown sign-in failure shows the server detail after the generic text', async () => {
    auth = createFakeAuth(null);
    render(<App services={{ ...services, auth }} />);
    await screen.findByLabelText('邮箱');
    auth.setSignInResult({ ok: false, reason: 'unknown', detail: 'Email logins are disabled' });
    await submitLogin();
    expect(await screen.findByText('登录失败，请稍后再试（Email logins are disabled）')).toBeInTheDocument();
  });

  it('session expiry returns to login with a notice and keeps the unsynced queue', async () => {
    render(<App services={services} />);
    await repo.create('todos', { title: 'x' });
    auth.expire();
    expect(await screen.findByText(/登录已过期.*未同步的改动已保留/)).toBeInTheDocument();
    expect(await repo.pendingCount()).toBe(1);
  });

  it('a sign-in refused because another account has unsynced changes here says so (F3)', async () => {
    auth = createFakeAuth(null);
    render(<App services={{ ...services, auth }} />);
    await screen.findByLabelText('邮箱');
    auth.setSignInResult({ ok: false, reason: 'other_account', pending: 3 });
    await submitLogin();
    expect(await screen.findByText('此设备上还有另一个账号的 3 项未同步改动，请先用原账号登录完成同步')).toBeInTheDocument();
    expect(screen.queryByText('退出登录')).not.toBeInTheDocument();
  });

  it('a session refused at start shows the expiry notice on the login page (F1)', async () => {
    const refused = Object.assign(createFakeAuth(null), { expiredAtStart: () => true });
    render(<App services={{ ...services, auth: refused }} />);
    expect(await screen.findByText(/登录已过期.*未同步的改动已保留/)).toBeInTheDocument();
  });

  it('sign-out with pending changes asks first and cancelling keeps the session', async () => {
    await repo.create('todos', { title: 'x' });
    const confirmFn = vi.fn(() => false);
    renderShell({ confirmFn });
    await userEvent.click(screen.getByText('退出登录'));
    expect(confirmFn).toHaveBeenCalledWith(expect.stringContaining('1'));
    expect(auth.getUserId()).not.toBeNull();
  });

  it('sign-out with nothing pending does not ask', async () => {
    const confirmFn = vi.fn();
    renderShell({ confirmFn });
    await userEvent.click(screen.getByText('退出登录'));
    expect(confirmFn).not.toHaveBeenCalled();
    expect(auth.getUserId()).toBeNull();
  });
});

describe('App: edges', () => {
  it('a successful sign-in shows the shell', async () => {
    auth = createFakeAuth(null);
    render(<App services={{ ...services, auth }} />);
    await screen.findByLabelText('邮箱');
    await submitLogin();
    expect(await screen.findByText('退出登录')).toBeInTheDocument();
  });

  it('does not start syncing while signed out, and starts once signed in', async () => {
    auth = createFakeAuth(null);
    const sync = vi.spyOn(services.engine, 'sync');
    render(<App services={{ ...services, auth }} />);
    await screen.findByLabelText('邮箱');
    await new Promise((r) => setTimeout(r, 20));
    expect(sync).not.toHaveBeenCalled();
    await submitLogin();
    await waitFor(() => expect(sync).toHaveBeenCalled());
  });

  it('stops the sync triggers on sign-out, and sign-out keeps the queue', async () => {
    const stop = vi.fn();
    const startSync = vi.fn(() => stop);
    render(<App services={{ ...services, startSync }} />);
    await screen.findByText('退出登录');
    expect(startSync).toHaveBeenCalledTimes(1);
    await repo.create('todos', { title: 'x' });
    // The default confirmFn is window.confirm.
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await userEvent.click(screen.getByText('退出登录'));
    expect(await screen.findByLabelText('邮箱')).toBeInTheDocument();
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(await repo.pendingCount()).toBe(1);
  });

  it('an auth_expired sync run returns to login with the expiry notice', async () => {
    const base = await createTestServices();
    const cloud = { ...base.cloud, push: vi.fn(async () => { throw new CloudError('auth'); }) };
    const s = await createTestServices({ cloud });
    render(<App services={{ ...s, startSync: () => () => {} }} />);
    await screen.findByText('退出登录');
    await s.repo.create('todos', { title: 'x' });
    await s.engine.sync();
    expect(await screen.findByText(/登录已过期.*未同步的改动已保留/)).toBeInTheDocument();
    expect(await s.repo.pendingCount()).toBe(1);
  });

  it('the shell shows the pending count right after a local write', async () => {
    renderShell();
    await repo.create('todos', { title: 'x' });
    expect(await screen.findByText(/未同步 1 项/)).toBeInTheDocument();
  });

  it('has 待办 and 设置 navigation items', async () => {
    renderShell();
    expect(screen.getByRole('button', { name: '待办' })).toBeInTheDocument();
    // 待办 opens on the to-do page's 近期 tab.
    expect(screen.getByRole('tab', { name: '近期' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(await screen.findByRole('button', { name: '导出完整备份' })).toBeInTheDocument();
  });
});
