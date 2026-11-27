// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openLocalDb, type LocalDb } from '../../src/data/local-db';
import type { City } from '../../src/weather/api';
import { getCache, saveCache, setCity, type CachedForecast } from '../../src/weather/store';
import { useWeather, type WeatherView } from '../../src/weather/useWeather';
import { WeatherLine } from '../../src/ui/WeatherLine';

// 2026-11-27 09:00 in Asia/Shanghai (the device zone fixed in vitest.config.ts).
const NOW = '2026-11-27T01:00:00Z';
const HOUR = 60 * 60 * 1000;

const SH: City = { name: '上海', region: '上海市', country: '中国', latitude: 31.22, longitude: 121.46 };
const BJ: City = { name: '北京', region: null, country: '中国', latitude: 39.9, longitude: 116.4 };
const TOKYO: City = { name: '东京', region: null, country: '日本', latitude: 35.69, longitude: 139.69 };

const ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();

/** A Shanghai cache: 今天晴，明天和后天有雨 (rain twice is not first, so 明天起连续两天有雨). */
const shCache = (fetchedAt: string, city: City = SH): CachedForecast => ({
  city,
  fetchedAt,
  forecast: {
    timezone: 'Asia/Shanghai',
    days: [
      { date: '2026-11-27', code: 0 },
      { date: '2026-11-28', code: 61 },
      { date: '2026-11-29', code: 61 },
    ],
  },
});
const OLD_TEXT = '上海：今天晴，明天起连续两天有雨';

/** An Open-Meteo forecast body: three cloudy days in Shanghai. */
const cloudyBody = {
  timezone: 'Asia/Shanghai',
  daily: { time: ['2026-11-27', '2026-11-28', '2026-11-29'], weather_code: [3, 3, 3] },
};
const NEW_TEXT = '上海：未来三天都是多云';

const okFetch = (body: unknown = cloudyBody) => vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status: 200 }));
const failFetch = () =>
  vi.fn<typeof fetch>(async () => {
    throw new TypeError('Failed to fetch');
  });

let db: LocalDb;
let n = 0;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  db = await openLocalDb(`use-weather-${++n}`);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  db.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Lets pending IndexedDB reads and runs finish (only Date is faked, so real timers tick). */
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 50)));

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

/** Renders the hook and exposes the latest view. */
function renderHookView(o: Parameters<typeof useWeather>[1]) {
  const seen: WeatherView[] = [];
  function Probe() {
    const v = useWeather(db, o);
    seen.push(v);
    return <span data-testid="kind">{v.kind}</span>;
  }
  const r = render(<Probe />);
  return { ...r, latest: () => seen[seen.length - 1] };
}

it('no city: shows the hint to pick one, makes no request', async () => {
  const fetchFn = vi.fn<typeof fetch>();
  render(<WeatherLine db={db} fetchFn={fetchFn} />);
  expect(await screen.findByText('在设置里选一个城市即可显示天气')).toBeInTheDocument();
  expect(fetchFn).not.toHaveBeenCalled();
});

it('a fresh cache is shown without a request', async () => {
  await setCity(db, SH);
  await saveCache(db, shCache(ago(1 * HOUR)));
  const fetchFn = vi.fn<typeof fetch>();
  render(<WeatherLine db={db} fetchFn={fetchFn} />);
  expect(await screen.findByText(OLD_TEXT)).toBeInTheDocument();
  expect(fetchFn).not.toHaveBeenCalled();
});

it('an old cache (> 3 h) triggers one request and shows the new result', async () => {
  await setCity(db, SH);
  await saveCache(db, shCache(ago(4 * HOUR)));
  const fetchFn = okFetch();
  render(<WeatherLine db={db} fetchFn={fetchFn} />);
  expect(await screen.findByText(NEW_TEXT)).toBeInTheDocument();
  expect(fetchFn).toHaveBeenCalledTimes(1);
  const saved = await getCache(db);
  expect(saved?.fetchedAt).toBe(new Date(NOW).toISOString());
  expect(saved?.forecast.days.map((d) => d.code)).toEqual([3, 3, 3]);
  expect(saved?.city).toEqual(SH);
});

it('when the request fails, a cache under a day is shown with its time; older than a day hides the line', async () => {
  await setCity(db, SH);
  // 5 h old; 2026-11-26T20:00Z is 04:00 in the device zone (Asia/Shanghai).
  await saveCache(db, shCache('2026-11-26T20:00:00.000Z'));
  const first = render(<WeatherLine db={db} fetchFn={failFetch()} />);
  expect(await screen.findByText(`${OLD_TEXT}（04:00 更新）`)).toBeInTheDocument();
  first.unmount();

  await saveCache(db, shCache(ago(25 * HOUR)));
  const fetchFn = failFetch();
  const { container } = render(<WeatherLine db={db} fetchFn={fetchFn} />);
  await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
  await settle();
  expect(container).toBeEmptyDOMElement();
});

it('no cache and a failed request hide the line', async () => {
  await setCity(db, SH);
  const fetchFn = failFetch();
  const { container } = render(<WeatherLine db={db} fetchFn={fetchFn} />);
  await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
  await settle();
  expect(container).toBeEmptyDOMElement();
});

it('a cache of another city counts as none', async () => {
  await setCity(db, BJ);
  // Written straight to the store: the Beijing city with a Shanghai cache.
  await saveCache(db, shCache(ago(1 * HOUR)));
  const fetchFn = failFetch();
  const { container } = render(<WeatherLine db={db} fetchFn={fetchFn} />);
  await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
  await settle();
  expect(container).toBeEmptyDOMElement();
  expect(screen.queryByText(/上海/)).toBeNull();
});

it('"today" follows the city zone: past days in the cache are dropped', async () => {
  await setCity(db, TOKYO);
  await saveCache(db, {
    city: TOKYO,
    fetchedAt: ago(1 * HOUR),
    forecast: {
      timezone: 'Asia/Tokyo',
      days: [
        { date: '2026-11-26', code: 61 },
        { date: '2026-11-27', code: 0 },
        { date: '2026-11-28', code: 0 },
      ],
    },
  });
  const fetchFn = vi.fn<typeof fetch>();
  // NOW is 2026-11-27 10:00 in Tokyo, so 11-26 is in the past.
  render(<WeatherLine db={db} fetchFn={fetchFn} />);
  expect(await screen.findByText('东京：今天和明天晴')).toBeInTheDocument();
  expect(fetchFn).not.toHaveBeenCalled();
});

it('an unknown forecast zone falls back to the earliest day as today', async () => {
  await setCity(db, SH);
  const c = shCache(ago(1 * HOUR));
  await saveCache(db, { ...c, forecast: { ...c.forecast, timezone: 'Not/AZone' } });
  render(<WeatherLine db={db} fetchFn={vi.fn<typeof fetch>()} />);
  expect(await screen.findByText(OLD_TEXT)).toBeInTheDocument();
});

it('a forecast with only past days hides the line', async () => {
  await setCity(db, SH);
  await saveCache(db, {
    city: SH,
    fetchedAt: ago(1 * HOUR),
    forecast: { timezone: 'Asia/Shanghai', days: [{ date: '2026-11-25', code: 0 }, { date: '2026-11-26', code: 0 }] },
  });
  const { latest } = renderHookView({ fetchFn: vi.fn<typeof fetch>() });
  await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('hidden'));
  await settle();
  expect(latest()).toEqual({ kind: 'hidden' });
});

it('the hook reports ready with staleAt only for an old result', async () => {
  await setCity(db, SH);
  await saveCache(db, shCache(ago(1 * HOUR)));
  const fresh = renderHookView({ fetchFn: vi.fn<typeof fetch>() });
  await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('ready'));
  expect(fresh.latest()).toEqual({ kind: 'ready', text: OLD_TEXT, staleAt: null });
  fresh.unmount();

  await saveCache(db, shCache('2026-11-26T20:00:00.000Z'));
  const stale = renderHookView({ fetchFn: failFetch() });
  await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('ready'));
  expect(stale.latest()).toEqual({ kind: 'ready', text: OLD_TEXT, staleAt: '04:00' });
});

it('the line links to Open-Meteo', async () => {
  await setCity(db, SH);
  await saveCache(db, shCache(ago(1 * HOUR)));
  render(<WeatherLine db={db} fetchFn={vi.fn<typeof fetch>()} />);
  const link = await screen.findByRole('link', { name: 'Open-Meteo' });
  expect(link).toHaveAttribute('href', 'https://open-meteo.com/');
  expect(link).toHaveAttribute('target', '_blank');
  expect(link.getAttribute('rel')).toMatch(/noopener/);
  expect(link.getAttribute('rel')).toMatch(/noreferrer/);
});

it('the no-city hint has no link and is not a button', async () => {
  render(<WeatherLine db={db} fetchFn={vi.fn<typeof fetch>()} />);
  await screen.findByText('在设置里选一个城市即可显示天气');
  expect(screen.queryByRole('link')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
});

it('returning to the foreground refreshes only when the cache is older than 3 h', async () => {
  await setCity(db, SH);
  await saveCache(db, shCache(ago(1 * HOUR)));
  const fetchFn = okFetch();
  render(<WeatherLine db={db} fetchFn={fetchFn} />);
  expect(await screen.findByText(OLD_TEXT)).toBeInTheDocument();

  // Still under 3 h: coming back shows the cache again, no request.
  setVisibility('visible');
  fireEvent(document, new Event('visibilitychange'));
  fireEvent(document, new Event('visibilitychange'));
  await settle();
  expect(fetchFn).not.toHaveBeenCalled();

  // Going to the background does nothing.
  vi.setSystemTime(Date.parse(NOW) + 3 * HOUR);
  setVisibility('hidden');
  fireEvent(document, new Event('visibilitychange'));
  await settle();
  expect(fetchFn).not.toHaveBeenCalled();

  // Back in front with the cache now 4 h old: one request, even with two events close together.
  setVisibility('visible');
  fireEvent(document, new Event('visibilitychange'));
  fireEvent(document, new Event('visibilitychange'));
  expect(await screen.findByText(NEW_TEXT)).toBeInTheDocument();
  expect(fetchFn).toHaveBeenCalledTimes(1);

  // The fresh result is cached: another return makes no request.
  fireEvent(document, new Event('visibilitychange'));
  await settle();
  expect(fetchFn).toHaveBeenCalledTimes(1);
});

it('removes the listener on unmount and aborts the request in flight', async () => {
  await setCity(db, SH);
  let signal: AbortSignal | undefined;
  const fetchFn = vi.fn<typeof fetch>(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        signal = init?.signal ?? undefined;
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
  );
  const remove = vi.spyOn(document, 'removeEventListener');
  const { unmount } = render(<WeatherLine db={db} fetchFn={fetchFn} />);
  await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
  expect(signal?.aborted).toBe(false);
  unmount();
  expect(signal?.aborted).toBe(true);
  expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  // Events after unmount start nothing.
  setVisibility('visible');
  fireEvent(document, new Event('visibilitychange'));
  await settle();
  expect(fetchFn).toHaveBeenCalledTimes(1);
});

it('never throws: a broken getMeta hides the line', async () => {
  vi.spyOn(db, 'getMeta').mockRejectedValue(new Error('IndexedDB is gone'));
  const fetchFn = vi.fn<typeof fetch>();
  const { container } = render(<WeatherLine db={db} fetchFn={fetchFn} />);
  await waitFor(() => expect(console.error).toHaveBeenCalled());
  await settle();
  expect(container).toBeEmptyDOMElement();
  expect(fetchFn).not.toHaveBeenCalled();
});

it('a failed save still shows the new result', async () => {
  await setCity(db, SH);
  vi.spyOn(db, 'setMeta').mockRejectedValue(new Error('quota'));
  render(<WeatherLine db={db} fetchFn={okFetch()} />);
  expect(await screen.findByText(NEW_TEXT)).toBeInTheDocument();
});
