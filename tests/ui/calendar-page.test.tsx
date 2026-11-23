// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Services } from '../../src/app/services';
import type { EventRecord } from '../../src/domain/types';
import { CalendarPage } from '../../src/ui/CalendarPage';
import { createTestServices } from '../helpers/ui-services';

// 2026-11-23 12:00 in Asia/Shanghai (the device zone fixed in vitest.config.ts).
const NOW = '2026-11-23T04:00:00Z';

let s: Services;
let onDayChange: ReturnType<typeof vi.fn<(d: string) => void>>;
let onNewEvent: ReturnType<typeof vi.fn<(d: string) => void>>;
let onOpenEvent: ReturnType<typeof vi.fn<(e: EventRecord) => void>>;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  s = await createTestServices();
  onDayChange = vi.fn<(d: string) => void>();
  onNewEvent = vi.fn<(d: string) => void>();
  onOpenEvent = vi.fn<(e: EventRecord) => void>();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const page = (day: string) => (
  <CalendarPage services={s} day={day} onDayChange={onDayChange} onNewEvent={onNewEvent} onOpenEvent={onOpenEvent} />
);
const renderPage = (day = '2026-11-23') => render(page(day));

it('shows the month title, weekday header 一…日, and marks today and the selected day', () => {
  renderPage('2026-11-25');
  expect(screen.getByText('2026年11月')).toBeInTheDocument();
  expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['一', '二', '三', '四', '五', '六', '日']);
  expect(screen.getByRole('button', { name: '11月23日' })).toHaveAttribute('aria-current', 'date');
  expect(screen.getByRole('button', { name: '11月25日' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: '11月24日' })).toHaveAttribute('aria-pressed', 'false');
  expect(screen.getByRole('button', { name: '11月24日' })).not.toHaveAttribute('aria-current');
});

it('moves between months with 上个月 / 下个月 and back with 今天', async () => {
  renderPage('2026-11-30');
  await userEvent.click(screen.getByRole('button', { name: '下个月' }));
  expect(onDayChange).toHaveBeenLastCalledWith('2026-12-30');
  await userEvent.click(screen.getByRole('button', { name: '上个月' }));
  expect(onDayChange).toHaveBeenLastCalledWith('2026-10-30');
  await userEvent.click(screen.getByRole('button', { name: '今天' }));
  expect(onDayChange).toHaveBeenLastCalledWith('2026-11-23');
});

it('clamps the day to the length of the target month', async () => {
  renderPage('2026-01-31');
  await userEvent.click(screen.getByRole('button', { name: '下个月' }));
  expect(onDayChange).toHaveBeenLastCalledWith('2026-02-28');
});

it('the shown month follows day', () => {
  const { rerender } = renderPage('2026-11-23');
  rerender(page('2027-01-05'));
  expect(screen.getByText('2027年1月')).toBeInTheDocument();
});

it('a day with events shows a dot and a count in its name; selecting it lists the events with their time', async () => {
  await s.repo.create('events', { title: '会议', all_day: false, starts_at: '2026-11-23T09:00', tz: 'Asia/Shanghai' });
  await s.repo.create('events', { title: '生日', starts_at: '2026-11-23' });
  renderPage('2026-11-23');
  const cell = await screen.findByRole('button', { name: '11月23日，有 2 个事项' });
  expect(within(cell).getAllByTestId('event-dot')).toHaveLength(2);
  const list = screen.getByRole('list', { name: '11月23日的事项' });
  const items = within(list).getAllByRole('listitem');
  expect(items[0]).toHaveTextContent('全天');
  expect(items[0]).toHaveTextContent('生日');
  expect(items[1]).toHaveTextContent('09:00');
  expect(items[1]).toHaveTextContent('会议');
});

it('clicking a day calls onDayChange; clicking an event calls onOpenEvent', async () => {
  const e = await s.repo.create('events', { title: '会议', starts_at: '2026-11-23' });
  renderPage('2026-11-23');
  await userEvent.click(screen.getByRole('button', { name: '11月24日' }));
  expect(onDayChange).toHaveBeenCalledWith('2026-11-24');
  await userEvent.click(await screen.findByRole('button', { name: /会议/ }));
  expect(onOpenEvent).toHaveBeenCalledWith(expect.objectContaining({ id: e.id }));
});

it('an empty day says so', async () => {
  renderPage('2026-11-23');
  expect(await screen.findByText('这一天没有事项')).toBeInTheDocument();
});

it('shows the zone name after the time when the event zone differs from the device zone', async () => {
  await s.repo.create('events', { title: '纽约会', all_day: false, starts_at: '2026-11-22T20:00', tz: 'America/New_York' }); // 09:00 on 11-23 Shanghai
  await s.repo.create('events', { title: '本地会', all_day: false, starts_at: '2026-11-23T10:00', tz: 'Asia/Shanghai' });
  renderPage('2026-11-23');
  const ny = (await screen.findByText('纽约会')).closest('li')!;
  expect(ny).toHaveTextContent('09:00');
  expect(ny.querySelector('.event-tz')).not.toBeNull();
  expect(screen.getByText('本地会').closest('li')!.querySelector('.event-tz')).toBeNull();
});

it('an unknown event zone still shows, with its stored time and the zone id', async () => {
  // The repo refuses an unknown zone, but a synced record from a newer device can carry one.
  const real = await s.repo.create('events', { title: '火星', all_day: false, starts_at: '2026-11-23T09:15', tz: 'Asia/Shanghai' });
  vi.spyOn(s.repo, 'list').mockResolvedValue([{ ...real, tz: 'Mars/Base' }] as never);
  renderPage('2026-11-23');
  const li = (await screen.findByText('火星')).closest('li')!;
  expect(li).toHaveTextContent('09:15');
  expect(li.querySelector('.event-tz')).toHaveTextContent('Mars/Base');
});

it('an important and done event is struck through on the calendar and in the list', async () => {
  await s.repo.create('events', { title: '交报告', starts_at: '2026-11-23', important: true, done: true });
  await s.repo.create('events', { title: '普通', starts_at: '2026-11-23', done: true });
  renderPage('2026-11-23');
  const title = await screen.findByText('交报告');
  expect(title).toHaveClass('done-important');
  expect(screen.getByText('普通')).not.toHaveClass('done-important');
  const dots = within(screen.getByRole('button', { name: '11月23日，有 2 个事项' })).getAllByTestId('event-dot');
  expect(dots.filter((d) => d.classList.contains('done-important'))).toHaveLength(1);
  expect(dots.filter((d) => d.classList.contains('important'))).toHaveLength(1);
});

it('does not show trashed events', async () => {
  const e = await s.repo.create('events', { title: '已删', starts_at: '2026-11-23' });
  await s.repo.remove('events', e.id);
  renderPage('2026-11-23');
  expect(await screen.findByText('这一天没有事项')).toBeInTheDocument();
  expect(screen.queryByText('已删')).toBeNull();
});

it('新建事项 calls onNewEvent with the selected day', async () => {
  renderPage('2026-11-25');
  await userEvent.click(screen.getByRole('button', { name: '新建事项' }));
  expect(onNewEvent).toHaveBeenCalledWith('2026-11-25');
});

it('fits 360px: the grid has no horizontal scroll', () => {
  const css = readFileSync('src/ui/styles.css', 'utf8');
  expect(css).toMatch(/\.month-grid\s*\{[^}]*grid-template-columns:\s*repeat\(7,\s*minmax\(0,\s*1fr\)\)/);
  expect(css).toMatch(/\.day-cell\s*\{[^}]*min-height:\s*44px/);
});
