// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openLocalDb, type LocalDb } from '../../src/data/local-db';
import type { City } from '../../src/weather/api';
import { getCache, saveCache, setCity, type CachedForecast } from '../../src/weather/store';
import { loadWeather, resetWeatherBackoff, useWeather, type WeatherView } from '../../src/weather/useWeather';
import { WeatherLine } from '../../src/ui/WeatherLine';

// 2026-11-27 09:00 in Asia/Shanghai (the device zone fixed in vitest.config.ts).
const NOW = '2026-11-27T01:00:00Z';
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const HIDDEN: WeatherView = { kind: 'hidden' };

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
  resetWeatherBackoff();
});
afterEach(() => {
  db.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Lets pending work finish (only Date is faked, so real timers tick). Only where there is no signal to wait on. */
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 50)));

/** One pass of the flow, awaited directly: its result is the final view, with no rendering in between. */
const load = (fetchFn: typeof fetch, extra: Partial<Parameters<typeof loadWeather>[1]> = {}) =>
  loadWeather(db, { fetchFn, now: () => new Date(), signal: new AbortController().signal, ...extra });

/** A fetch that waits until the test settles it. */
function deferredFetch() {
  let resolve!: (r: Response) => void;
  let reject!: (e: unknown) => void;
  const fetchFn = vi.fn<typeof fetch>(
    () =>
      new Promise<Response>((res, rej) => {
        resolve = res;
        reject = rej;
      }),
  );
  return {
    fetchFn,
    resolve: (body: unknown = cloudyBody) => resolve(new Response(JSON.stringify(body), { status: 200 })),
    reject: () => reject(new TypeError('Failed to fetch')),
  };
}

const visible = () => {
  setVisibility('visible');
  fireEvent(document, new Event('visibilitychange'));
};

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

/**
 * Renders the hook and exposes every view it rendered. A run that ends in a ready view always renders (each one is a
 * new object), so a rise in `count()` is a positive signal that the run finished.
 */
function renderHookView(o: Parameters<typeof useWeather>[1]) {
  const seen: WeatherView[] = [];
  function Probe() {
    const v = useWeather(db, o);
    seen.push(v);
    return <span data-testid="kind">{v.kind}</span>;
  }
  const r = render(<Probe />);
  return { ...r, seen, latest: () => seen[seen.length - 1], count: () => seen.length };
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
  const first = failFetch();
  expect(await load(first)).toEqual({ kind: 'ready', text: OLD_TEXT, staleAt: '04:00' });
  expect(first).toHaveBeenCalledTimes(1);
  resetWeatherBackoff();
  render(<WeatherLine db={db} fetchFn={failFetch()} />);
  expect(await screen.findByText(`${OLD_TEXT}（04:00 更新）`)).toBeInTheDocument();

  resetWeatherBackoff();
  await saveCache(db, shCache(ago(25 * HOUR)));
  const fetchFn = failFetch();
  expect(await load(fetchFn)).toEqual(HIDDEN);
  expect(fetchFn).toHaveBeenCalledTimes(1);
});

it('no cache and a failed request hide the line', async () => {
  await setCity(db, SH);
  const fetchFn = failFetch();
  const onInterim = vi.fn();
  expect(await load(fetchFn, { onInterim })).toEqual(HIDDEN);
  expect(fetchFn).toHaveBeenCalledTimes(1);
  expect(onInterim).not.toHaveBeenCalled();
});

it('a cache of another city counts as none', async () => {
  await setCity(db, BJ);
  // Written straight to the store: the Beijing city with a Shanghai cache.
  await saveCache(db, shCache(ago(1 * HOUR)));
  const fetchFn = failFetch();
  const onInterim = vi.fn();
  expect(await load(fetchFn, { onInterim })).toEqual(HIDDEN);
  expect(fetchFn).toHaveBeenCalledTimes(1);
  expect(onInterim).not.toHaveBeenCalled();
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
  const fetchFn = vi.fn<typeof fetch>();
  expect(await load(fetchFn)).toEqual(HIDDEN);
  expect(fetchFn).not.toHaveBeenCalled();
});

it('the hook reports ready with staleAt only for an old result', async () => {
  await setCity(db, SH);
  await saveCache(db, shCache(ago(1 * HOUR)));
  const fresh = renderHookView({ fetchFn: vi.fn<typeof fetch>() });
  await waitFor(() => expect(screen.getByTestId('kind')).toHaveTextContent('ready'));
  expect(fresh.latest()).toEqual({ kind: 'ready', text: OLD_TEXT, staleAt: null });
  fresh.unmount();

  await saveCache(db, shCache('2026-11-26T20:00:00.000Z'));
  const d = deferredFetch();
  const stale = renderHookView({ fetchFn: d.fetchFn });
  // The old result shows while the request runs, and again after it failed.
  await waitFor(() => expect(stale.latest()).toEqual({ kind: 'ready', text: OLD_TEXT, staleAt: '04:00' }));
  expect(d.fetchFn).toHaveBeenCalledTimes(1);
  const before = stale.count();
  d.reject();
  await waitFor(() => expect(stale.count()).toBe(before + 1));
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
  const getMeta = vi.spyOn(db, 'getMeta');
  const h = renderHookView({ fetchFn });
  await waitFor(() => expect(h.latest()).toEqual({ kind: 'ready', text: OLD_TEXT, staleAt: null }));

  // Still under 3 h: coming back shows the cache again (one run for two events), no request.
  let before = h.count();
  visible();
  visible();
  await waitFor(() => expect(h.count()).toBe(before + 1));
  expect(fetchFn).not.toHaveBeenCalled();

  // Going to the background does nothing: no run starts (a run reads the city synchronously).
  vi.setSystemTime(Date.parse(NOW) + 3 * HOUR);
  const reads = getMeta.mock.calls.length;
  setVisibility('hidden');
  fireEvent(document, new Event('visibilitychange'));
  expect(getMeta.mock.calls.length).toBe(reads);

  // Back in front with the cache now 4 h old: one request, even with two events close together.
  visible();
  visible();
  await waitFor(() => expect(h.latest()).toEqual({ kind: 'ready', text: NEW_TEXT, staleAt: null }));
  expect(fetchFn).toHaveBeenCalledTimes(1);

  // The fresh result is cached: another return makes no request.
  before = h.count();
  visible();
  await waitFor(() => expect(h.count()).toBe(before + 1));
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
  const getMeta = vi.spyOn(db, 'getMeta');
  visible();
  expect(getMeta).not.toHaveBeenCalled();
  await settle();
  expect(fetchFn).toHaveBeenCalledTimes(1);
});

it('never throws: a broken getMeta hides the line', async () => {
  vi.spyOn(db, 'getMeta').mockRejectedValue(new Error('IndexedDB is gone'));
  const fetchFn = vi.fn<typeof fetch>();
  expect(await load(fetchFn)).toEqual({ kind: 'error' });
  const { container } = render(<WeatherLine db={db} fetchFn={fetchFn} />);
  // The error is logged at the very end of the run, so no request can follow it.
  await waitFor(() => expect(console.error).toHaveBeenCalledTimes(2));
  expect(container).toBeEmptyDOMElement();
  expect(fetchFn).not.toHaveBeenCalled();
});

it('a failed save still shows the new result', async () => {
  await setCity(db, SH);
  vi.spyOn(db, 'setMeta').mockRejectedValue(new Error('quota'));
  render(<WeatherLine db={db} fetchFn={okFetch()} />);
  expect(await screen.findByText(NEW_TEXT)).toBeInTheDocument();
});

it('an old cache (> 3 h, < 1 day) shows at once with its time, before the request answers, then is swapped', async () => {
  await setCity(db, SH);
  // 4 h old: 2026-11-26T21:00Z is 05:00 in the device zone.
  await saveCache(db, shCache(ago(4 * HOUR)));
  const d = deferredFetch();
  render(<WeatherLine db={db} fetchFn={d.fetchFn} />);
  expect(await screen.findByText(`${OLD_TEXT}（05:00 更新）`)).toBeInTheDocument();
  expect(d.fetchFn).toHaveBeenCalledTimes(1);
  d.resolve();
  expect(await screen.findByText(NEW_TEXT)).toBeInTheDocument();
  expect(screen.queryByText(/更新/)).toBeNull();
});

it('the old result is handed over before the request is sent, and kept when it fails', async () => {
  await setCity(db, SH);
  await saveCache(db, shCache(ago(4 * HOUR)));
  const d = deferredFetch();
  const onInterim = vi.fn();
  const p = load(d.fetchFn, { onInterim });
  await vi.waitFor(() => expect(d.fetchFn).toHaveBeenCalledTimes(1));
  expect(onInterim).toHaveBeenCalledExactlyOnceWith({ kind: 'ready', text: OLD_TEXT, staleAt: '05:00' });
  d.reject();
  expect(await p).toEqual({ kind: 'ready', text: OLD_TEXT, staleAt: '05:00' });
});

it('without a usable cache the line stays hidden until the request answers', async () => {
  await setCity(db, SH);
  await saveCache(db, shCache(ago(25 * HOUR)));
  const d = deferredFetch();
  const onInterim = vi.fn();
  const p = load(d.fetchFn, { onInterim });
  await vi.waitFor(() => expect(d.fetchFn).toHaveBeenCalledTimes(1));
  expect(onInterim).not.toHaveBeenCalled();
  d.resolve();
  expect(await p).toEqual({ kind: 'ready', text: NEW_TEXT, staleAt: null });
});

it('after a failed request, no request for 10 minutes: not on return to the foreground, not on remount', async () => {
  await setCity(db, SH);
  await saveCache(db, shCache('2026-11-26T20:00:00.000Z'));
  const d = deferredFetch();
  const fetchFn = d.fetchFn;
  const stale = { kind: 'ready', text: OLD_TEXT, staleAt: '04:00' };
  const h = renderHookView({ fetchFn });
  // Shown while the request runs, then again once it failed.
  await waitFor(() => expect(h.latest()).toEqual(stale));
  expect(fetchFn).toHaveBeenCalledTimes(1);
  let before = h.count();
  d.reject();
  await waitFor(() => expect(h.count()).toBe(before + 1));

  // 5 min later, back in front: the old result again, no request.
  vi.setSystemTime(Date.parse(NOW) + 5 * MINUTE);
  before = h.count();
  visible();
  await waitFor(() => expect(h.count()).toBe(before + 1));
  expect(h.latest()).toEqual(stale);
  expect(fetchFn).toHaveBeenCalledTimes(1);

  // A remount (switching tabs) inside the window: the old result, no request.
  h.unmount();
  vi.setSystemTime(Date.parse(NOW) + 9 * MINUTE);
  const again = renderHookView({ fetchFn });
  await waitFor(() => expect(again.latest()).toEqual(stale));
  expect(fetchFn).toHaveBeenCalledTimes(1);

  // 10 min after the failure: one request.
  vi.setSystemTime(Date.parse(NOW) + 10 * MINUTE);
  visible();
  await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
});

it('the backoff skips the request without a cache too, and a success ends it', async () => {
  await setCity(db, SH);
  expect(await load(failFetch())).toEqual(HIDDEN);
  const ok = okFetch();
  vi.setSystemTime(Date.parse(NOW) + 9 * MINUTE);
  expect(await load(ok)).toEqual(HIDDEN);
  expect(ok).not.toHaveBeenCalled();
  vi.setSystemTime(Date.parse(NOW) + 10 * MINUTE);
  expect(await load(ok)).toEqual({ kind: 'ready', text: NEW_TEXT, staleAt: null });
  expect(ok).toHaveBeenCalledTimes(1);
});

it('a storage error after a good render keeps the line as it was', async () => {
  await setCity(db, SH);
  await saveCache(db, shCache(ago(1 * HOUR)));
  const fetchFn = vi.fn<typeof fetch>();
  const h = renderHookView({ fetchFn });
  await waitFor(() => expect(h.latest()).toEqual({ kind: 'ready', text: OLD_TEXT, staleAt: null }));
  const good = h.count();

  vi.spyOn(db, 'getMeta').mockRejectedValueOnce(new Error('IndexedDB hiccup'));
  visible();
  await waitFor(() => expect(console.error).toHaveBeenCalledWith('Could not load the weather:', 'Error'));
  // The next return reads fine. It can start only after the failed run has finished (and set whatever it set).
  await waitFor(() => {
    visible();
    expect(h.count()).toBeGreaterThan(good);
  });
  expect(h.seen.slice(good - 1).every((v) => v.kind === 'ready')).toBe(true);
  expect(h.latest()).toEqual({ kind: 'ready', text: OLD_TEXT, staleAt: null });
  expect(fetchFn).not.toHaveBeenCalled();
});
