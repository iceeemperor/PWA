// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Services } from '../../src/app/services';
import { getCache, getCity, saveCache, setCity } from '../../src/weather/store';
import { Settings } from '../../src/ui/Settings';
import { WeatherSettings } from '../../src/ui/WeatherSettings';
import { createTestServices } from '../helpers/ui-services';

let services: Services;
beforeEach(async () => {
  services = await createTestServices();
  vi.spyOn(services.engine, 'sync').mockResolvedValue({ outcome: 'ok', pushed: 0, dropped: 0, failed: 0, pulled: 0, conflicts: 0 });
});
afterEach(() => vi.restoreAllMocks());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const shanghai = { name: '上海', admin1: '上海市', country: '中国', latitude: 31.2, longitude: 121.4 };
const fetchWith = (body: unknown) => vi.fn<typeof fetch>(async () => json(body));

describe('WeatherSettings', () => {
  it('searches, lists up to 5 results as 名字，省/州，国家 and saves the chosen one', async () => {
    const results = [
      shanghai,
      { name: '上海', country: '美国', latitude: 1, longitude: 2 },
      { name: 'X', admin1: 'Y', latitude: 3, longitude: 4 },
      { name: 'Z', latitude: 5, longitude: 6 },
      { name: 'W', admin1: 'V', country: 'U', latitude: 7, longitude: 8 },
    ];
    const fetchFn = fetchWith({ results });
    const user = userEvent.setup();
    render(<WeatherSettings db={services.db} fetchFn={fetchFn} />);
    expect(screen.getByText('天气只保存在这台设备上')).toBeTruthy();
    await user.type(screen.getByLabelText('城市'), '上海');
    await user.click(screen.getByRole('button', { name: '搜索' }));
    const first = await screen.findByRole('button', { name: '上海，上海市，中国' });
    expect(screen.getByRole('button', { name: '上海，美国' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'X，Y' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Z' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'W，V，U' })).toBeTruthy();
    await user.click(first);
    expect(await screen.findByText('当前城市：上海')).toBeTruthy();
    expect(await getCity(services.db)).toEqual({ name: '上海', region: '上海市', country: '中国', latitude: 31.2, longitude: 121.4 });
    expect(screen.queryByRole('button', { name: 'Z' })).toBeNull();
    expect((screen.getByLabelText('城市') as HTMLInputElement).value).toBe('');
  });

  it('Enter in the input searches', async () => {
    const fetchFn = fetchWith({ results: [shanghai] });
    const user = userEvent.setup();
    render(<WeatherSettings db={services.db} fetchFn={fetchFn} />);
    await user.type(screen.getByLabelText('城市'), '上海{Enter}');
    expect(await screen.findByRole('button', { name: '上海，上海市，中国' })).toBeTruthy();
  });

  it('no results says 没有找到这个地方; a failed search says 搜索失败，请稍后再试; a new search clears the message', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json({}, 500))
      .mockResolvedValueOnce(json({ results: [shanghai] }));
    const user = userEvent.setup();
    render(<WeatherSettings db={services.db} fetchFn={fetchFn} />);
    await user.type(screen.getByLabelText('城市'), 'nowhere');
    await user.click(screen.getByRole('button', { name: '搜索' }));
    expect(await screen.findByText('没有找到这个地方')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '搜索' }));
    expect(await screen.findByText('搜索失败，请稍后再试')).toBeTruthy();
    expect(screen.queryByText('没有找到这个地方')).toBeNull();
    await user.click(screen.getByRole('button', { name: '搜索' }));
    await screen.findByRole('button', { name: '上海，上海市，中国' });
    expect(screen.queryByText('搜索失败，请稍后再试')).toBeNull();
  });

  it('清除 removes the city and its cache', async () => {
    const city = { name: '上海', region: null, country: null, latitude: 1, longitude: 2 };
    await setCity(services.db, city);
    await saveCache(services.db, { city, fetchedAt: new Date().toISOString(), forecast: { timezone: 'Asia/Shanghai', days: [{ date: '2026-11-27', code: 0 }] } });
    const user = userEvent.setup();
    render(<WeatherSettings db={services.db} fetchFn={fetchWith({})} />);
    expect(await screen.findByText('当前城市：上海')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '清除' }));
    await waitFor(() => expect(screen.queryByText('当前城市：上海')).toBeNull());
    expect(await getCity(services.db)).toBeNull();
    expect(await getCache(services.db)).toBeNull();
  });

  it('a blank search does nothing', async () => {
    const fetchFn = fetchWith({});
    const user = userEvent.setup();
    render(<WeatherSettings db={services.db} fetchFn={fetchFn} />);
    await user.type(screen.getByLabelText('城市'), '   ');
    await user.click(screen.getByRole('button', { name: '搜索' }));
    expect(fetchFn).not.toHaveBeenCalled();
    expect(screen.queryByText('没有找到这个地方')).toBeNull();
    expect(screen.queryByText('搜索失败，请稍后再试')).toBeNull();
  });

  it('shows the GeoNames credit with its link', () => {
    render(<WeatherSettings db={services.db} fetchFn={fetchWith({})} />);
    const link = screen.getByRole('link', { name: 'GeoNames' });
    expect(link.getAttribute('href')).toBe('https://www.geonames.org');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.parentElement?.textContent).toContain('地点数据来自 GeoNames');
  });

  it('the search button is disabled while searching and a second trigger is ignored', async () => {
    let release!: (r: Response) => void;
    const fetchFn = vi.fn<typeof fetch>(() => new Promise<Response>((r) => (release = r)));
    const user = userEvent.setup();
    render(<WeatherSettings db={services.db} fetchFn={fetchFn} />);
    await user.type(screen.getByLabelText('城市'), '上海');
    await user.click(screen.getByRole('button', { name: '搜索' }));
    const busy = screen.getByRole('button', { name: '搜索中…' }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    await user.type(screen.getByLabelText('城市'), '{Enter}');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    release(json({ results: [shanghai] }));
    await screen.findByRole('button', { name: '上海，上海市，中国' });
  });

  it('sets no state after unmount', async () => {
    let release!: (r: Response) => void;
    const fetchFn = vi.fn<typeof fetch>(() => new Promise<Response>((r) => (release = r)));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    const { unmount } = render(<WeatherSettings db={services.db} fetchFn={fetchFn} />);
    await user.type(screen.getByLabelText('城市'), '上海');
    await user.click(screen.getByRole('button', { name: '搜索' }));
    unmount();
    release(json({ results: [shanghai] }));
    await new Promise((r) => setTimeout(r, 20));
    expect(err).not.toHaveBeenCalled();
  });

  it('renders result names as plain text', async () => {
    const fetchFn = fetchWith({ results: [{ name: '<b>x</b>', latitude: 1, longitude: 2 }] });
    const user = userEvent.setup();
    const { container } = render(<WeatherSettings db={services.db} fetchFn={fetchFn} />);
    await user.type(screen.getByLabelText('城市'), 'x{Enter}');
    await screen.findByRole('button', { name: '<b>x</b>' });
    expect(container.querySelector('b')).toBeNull();
  });
});

describe('Settings placement', () => {
  it('sits after 同步 and before 导出', () => {
    render(<Settings services={services} />);
    const names = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(names.indexOf('同步')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('天气')).toBe(names.indexOf('同步') + 1);
    expect(names.indexOf('导出')).toBe(names.indexOf('天气') + 1);
  });
});
