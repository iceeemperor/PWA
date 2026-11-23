// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Services } from '../../src/app/services';
import { LocalWriteError } from '../../src/data/repo';
import { EventEditor } from '../../src/ui/EventEditor';
import { createTestServices } from '../helpers/ui-services';

let repo: Services['repo'];
let close: ReturnType<typeof vi.fn<() => void>>;

beforeEach(async () => {
  repo = (await createTestServices()).repo;
  close = vi.fn<() => void>();
});
afterEach(() => vi.restoreAllMocks());

const open = (initial: Parameters<typeof EventEditor>[0]['initial'] = { date: '2026-11-24' }) =>
  render(<EventEditor repo={repo} initial={initial} onClose={close} />);
const save = () => userEvent.click(screen.getByRole('button', { name: '保存' }));
const setValue = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

it('creates an all-day event on the given day by default', async () => {
  open();
  await userEvent.type(screen.getByLabelText('标题'), '体检');
  await save();
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(await repo.list('events')).toMatchObject([{ title: '体检', all_day: true, starts_at: '2026-11-24', tz: null, rrule: null }]);
});

it('focuses the title on open and closes on Escape and 取消 without saving', async () => {
  open();
  expect(screen.getByLabelText('标题')).toHaveFocus();
  await userEvent.type(screen.getByLabelText('标题'), 'x');
  await userEvent.keyboard('{Escape}');
  expect(close).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(close).toHaveBeenCalledTimes(2);
  expect(await repo.list('events')).toEqual([]);
});

it('unticking 全天 asks for times and stores local time plus the device zone', async () => {
  open();
  await userEvent.type(screen.getByLabelText('标题'), '开会');
  await userEvent.click(screen.getByLabelText('全天'));
  expect(screen.getByLabelText('开始时间')).toHaveValue('09:00');
  setValue('开始时间', '09:30');
  setValue('结束时间', '10:30');
  await save();
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(await repo.list('events')).toMatchObject([
    { all_day: false, starts_at: '2026-11-24T09:30', ends_at: '2026-11-24T10:30', tz: 'Asia/Shanghai' },
  ]);
});

it('no end time means no end', async () => {
  open();
  await userEvent.type(screen.getByLabelText('标题'), '开会');
  await userEvent.click(screen.getByLabelText('全天'));
  await save();
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(await repo.list('events')).toMatchObject([{ starts_at: '2026-11-24T09:00', ends_at: null }]);
});

it('ticking 全天 again keeps only the dates', async () => {
  const e = await repo.create('events', { title: 'a', all_day: false, starts_at: '2026-11-24T09:30', ends_at: '2026-11-25T10:00', tz: 'Asia/Shanghai' });
  open(e);
  await userEvent.click(screen.getByLabelText('全天'));
  await save();
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(await repo.list('events')).toMatchObject([{ all_day: true, starts_at: '2026-11-24', ends_at: '2026-11-25', tz: null }]);
});

it('an end before the start is refused with 结束不能早于开始 and nothing is saved', async () => {
  open();
  await userEvent.type(screen.getByLabelText('标题'), '开会');
  await userEvent.click(screen.getByLabelText('全天'));
  setValue('结束时间', '08:00');
  await save();
  expect(await screen.findByRole('alert')).toHaveTextContent('结束不能早于开始');
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByLabelText('标题')).toHaveValue('开会');
  expect(await repo.list('events')).toEqual([]);
});

it('a blank title is refused with 请填写标题', async () => {
  open();
  await save();
  expect(await screen.findByRole('alert')).toHaveTextContent('请填写标题');
  expect(await repo.list('events')).toEqual([]);
});

it('any other invalid content says 填写的内容有误', async () => {
  open();
  await userEvent.type(screen.getByLabelText('标题'), 'x');
  await userEvent.click(screen.getByLabelText('全天'));
  setValue('开始时间', '');
  await save();
  expect(await screen.findByRole('alert')).toHaveTextContent('填写的内容有误');
});

it('a failed write says 保存失败 and keeps the form', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(repo, 'create').mockRejectedValue(new LocalWriteError('disk'));
  open();
  await userEvent.type(screen.getByLabelText('标题'), '体检');
  await save();
  expect(await screen.findByRole('alert')).toHaveTextContent('保存失败');
  expect(screen.getByLabelText('标题')).toHaveValue('体检');
  expect(close).not.toHaveBeenCalled();
});

it("editing keeps the event's own zone and shows it when it differs from the device", async () => {
  const e = await repo.create('events', { title: 'a', all_day: false, starts_at: '2026-11-24T09:30', tz: 'Europe/London' });
  open(e);
  expect(screen.getByLabelText('开始时间')).toHaveValue('09:30');
  expect(screen.getByTestId('event-zone')).toHaveTextContent(/GMT|伦敦|Europe\/London/);
  setValue('开始时间', '10:00');
  await save();
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(await repo.list('events')).toMatchObject([{ starts_at: '2026-11-24T10:00', tz: 'Europe/London' }]);
});

it('shows no zone when the event is in the device zone', async () => {
  const e = await repo.create('events', { title: 'a', all_day: false, starts_at: '2026-11-24T09:30', tz: 'Asia/Shanghai' });
  open(e);
  expect(screen.queryByTestId('event-zone')).toBeNull();
});

it('important and done can be ticked; 删除 moves the event to the trash', async () => {
  const e = await repo.create('events', { title: 'a', starts_at: '2026-11-24' });
  const { unmount } = open(e);
  await userEvent.click(screen.getByLabelText('重要'));
  await userEvent.click(screen.getByLabelText('已完成'));
  await save();
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  expect(await repo.list('events')).toMatchObject([{ important: true, done: true }]);
  unmount();
  open(e);
  await userEvent.click(screen.getByRole('button', { name: '删除' }));
  await waitFor(() => expect(close).toHaveBeenCalledTimes(2));
  expect(await repo.list('events')).toEqual([]);
  expect(await repo.list('events', { trashed: true })).toHaveLength(1);
});

it('a new event has no 删除', () => {
  open();
  expect(screen.queryByRole('button', { name: '删除' })).toBeNull();
});

it('has no repeat option in stage 2', () => {
  open();
  expect(screen.queryByText(/重复/)).toBeNull();
});

it('saving only a title change does not overwrite a done change made underneath', async () => {
  const e = await repo.create('events', { title: 'a', starts_at: '2026-11-24' });
  open(e);
  await repo.update('events', e.id, { done: true });
  const t = screen.getByLabelText('标题');
  await userEvent.clear(t);
  await userEvent.type(t, 'b');
  await save();
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(await repo.list('events')).toMatchObject([{ title: 'b', done: true }]);
});

it('saving with nothing changed writes nothing and closes', async () => {
  const e = await repo.create('events', { title: 'a', starts_at: '2026-11-24' });
  const spy = vi.spyOn(repo, 'update');
  open(e);
  await save();
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(spy).not.toHaveBeenCalled();
});

it('an end date without an end time on a timed event is refused with 请填写结束时间', async () => {
  open();
  await userEvent.type(screen.getByLabelText('标题'), '开会');
  await userEvent.click(screen.getByLabelText('全天'));
  setValue('结束日期', '2026-11-25');
  await save();
  expect(await screen.findByRole('alert')).toHaveTextContent('请填写结束时间');
  expect(close).not.toHaveBeenCalled();
  expect(await repo.list('events')).toEqual([]);
});

it('returns focus to the opener on close and keeps Tab inside the dialog', async () => {
  const opener = document.createElement('button');
  document.body.appendChild(opener);
  opener.focus();
  const { unmount } = open();
  const buttons = screen.getAllByRole('button');
  buttons[buttons.length - 1].focus();
  await userEvent.tab();
  expect(screen.getByLabelText('标题')).toHaveFocus();
  await userEvent.tab({ shift: true });
  expect(screen.getAllByRole('button').at(-1)).toHaveFocus();
  unmount();
  expect(opener).toHaveFocus();
  opener.remove();
});

it('two quick submits create exactly one event', async () => {
  open();
  await userEvent.type(screen.getByLabelText('标题'), '体检');
  const form = screen.getByRole('dialog');
  fireEvent.submit(form);
  fireEvent.submit(form);
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(await repo.list('events')).toHaveLength(1);
});
