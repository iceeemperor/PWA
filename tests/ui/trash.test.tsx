// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Services } from '../../src/app/services';
import { PurgedRecordError } from '../../src/data/repo';
import { Settings } from '../../src/ui/Settings';
import { TrashSection, daysUntilPurge } from '../../src/ui/TrashSection';
import { createTestServices } from '../helpers/ui-services';

let services: Services;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-11-23T04:00:00Z');
  services = await createTestServices();
  vi.spyOn(services.engine, 'sync').mockResolvedValue({ outcome: 'ok', pushed: 0, dropped: 0, failed: 0, pulled: 0, conflicts: 0 });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Creates a record and puts it in the trash with a chosen deleted_at. */
async function trash(t: 'todos' | 'events', fields: Record<string, unknown>, deletedAt: string, extra: Record<string, unknown> = {}) {
  const rec = await services.repo.create(t, fields as never);
  const stored = await services.db.raw.get(t, rec.id);
  await services.db.raw.put(t, { ...stored!, deleted_at: deletedAt, ...extra });
  return rec;
}

describe('daysUntilPurge', () => {
  it('never goes below 0', () => expect(daysUntilPurge('2026-10-01T00:00:00Z', new Date('2026-11-23T04:00:00Z'))).toBe(0));
  it('is 30 on the day of deletion', () => expect(daysUntilPurge('2026-11-23T01:00:00Z', new Date('2026-11-23T04:00:00Z'))).toBe(30));
  it('clamps a future deleted_at to 30', () => expect(daysUntilPurge('2026-12-25T00:00:00Z', new Date('2026-11-23T04:00:00Z'))).toBe(30));
  it('returns 30 for an invalid date', () => expect(daysUntilPurge('not a date', new Date('2026-11-23T04:00:00Z'))).toBe(30));
  it('counts whole days', () => expect(daysUntilPurge('2026-11-13T04:00:01Z', new Date('2026-11-23T04:00:00Z'))).toBe(21));
});

describe('TrashSection', () => {
  it('lists trashed todos and events under 待办 and 日历, with days left, newest first', async () => {
    await trash('todos', { title: '旧待办' }, '2026-11-13T04:00:00Z');
    await trash('todos', { title: '新待办' }, '2026-11-20T04:00:00Z');
    await trash('todos', { title: '一个目标', kind: 'goal' }, '2026-11-18T04:00:00Z');
    await trash('events', { title: '会议', starts_at: '2026-12-01' }, '2026-11-23T01:00:00Z');
    render(<TrashSection services={services} />);
    await screen.findByText('旧待办');
    expect(screen.getByText('待办')).toBeTruthy();
    expect(screen.getByText('日历')).toBeTruthy();
    expect(screen.getByText('还剩 20 天')).toBeTruthy();
    expect(screen.getByText('还剩 30 天')).toBeTruthy();
    expect(screen.getByText('11月13日')).toBeTruthy();
    const todoTitles = screen.getAllByTestId('trash-todo-title').map((n) => n.textContent);
    expect(todoTitles).toEqual(['新待办', '一个目标', '旧待办']);
    expect(screen.getByText('目标')).toBeTruthy();
    expect(screen.getByText('删除的内容在这里保留 30 天，之后永久清除')).toBeTruthy();
  });

  it('shows 还剩 30 天 for a future deleted_at', async () => {
    await trash('todos', { title: '未来' }, '2026-12-25T00:00:00Z');
    render(<TrashSection services={services} />);
    await screen.findByText('未来');
    expect(screen.getByText('还剩 30 天')).toBeTruthy();
  });

  it('keeps an invalid deleted_at listed and restorable, with no NaN', async () => {
    const rec = await trash('todos', { title: '坏日期' }, 'garbage');
    const { container } = render(<TrashSection services={services} />);
    await screen.findByText('坏日期');
    expect(container.textContent).not.toContain('NaN');
    await userEvent.click(screen.getByRole('button', { name: '恢复' }));
    await waitFor(() => expect(screen.queryByText('坏日期')).toBeNull());
    expect((await services.repo.get('todos', rec.id))!.deleted_at).toBeNull();
  });

  it('shows 无标题 and 即将清除', async () => {
    await trash('todos', { title: 'x' }, '2026-10-24T03:00:00Z', { title: '' });
    render(<TrashSection services={services} />);
    expect(await screen.findByText('无标题')).toBeTruthy();
    expect(screen.getByText('即将清除')).toBeTruthy();
  });

  it('恢复 brings a record back and it leaves the list', async () => {
    const rec = await trash('todos', { title: '要恢复' }, '2026-11-13T04:00:00Z');
    render(<TrashSection services={services} />);
    await screen.findByText('要恢复');
    const btn = screen.getByRole('button', { name: '恢复' });
    expect(btn.className).toContain('restore');
    await userEvent.click(btn);
    await waitFor(() => expect(screen.queryByText('要恢复')).toBeNull());
    expect((await services.repo.get('todos', rec.id))!.deleted_at).toBeNull();
    expect(await screen.findByText('回收站是空的')).toBeTruthy();
  });

  it('tombstones are not listed; an empty trash says 回收站是空的', async () => {
    await trash('todos', { title: '已清除' }, '2026-11-13T04:00:00Z', { purged_at: '2026-11-20T00:00:00Z' });
    render(<TrashSection services={services} />);
    expect(await screen.findByText('回收站是空的')).toBeTruthy();
    expect(screen.queryByText('已清除')).toBeNull();
  });

  it('says 已被永久清除 when the record was purged meanwhile, and does not crash', async () => {
    await trash('todos', { title: '快没了' }, '2026-11-13T04:00:00Z');
    vi.spyOn(services.repo, 'restore').mockRejectedValue(new PurgedRecordError('gone'));
    render(<TrashSection services={services} />);
    await userEvent.click(await screen.findByRole('button', { name: '恢复' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('已被永久清除')).toBeTruthy();
  });

  it('shows the generic text for other failures', async () => {
    await trash('todos', { title: 'x' }, '2026-11-13T04:00:00Z');
    vi.spyOn(services.repo, 'restore').mockRejectedValue(new Error('boom'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<TrashSection services={services} />);
    await userEvent.click(await screen.findByRole('button', { name: '恢复' }));
    expect(await screen.findByText('操作失败，请重试')).toBeTruthy();
  });

  it('appears in Settings before 同步失败', async () => {
    render(<Settings services={services} />);
    const trashH = await screen.findByRole('heading', { name: '回收站' });
    const failedH = await screen.findByRole('heading', { name: '同步失败' });
    expect(trashH.compareDocumentPosition(failedH) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
