import { useEffect, useRef, useState } from 'react';
import type { LocalDb } from '../data/local-db';
import { deviceTimeZone, isTimeZone, localDateOf, localTimeOf } from '../domain/time';
import { fetchForecast, WeatherError, type City, type Forecast } from './api';
import { getCache, getCity, saveCache, WEATHER_MAX_AGE_MS, WEATHER_TTL_MS } from './store';
import { summarize } from './summary';

/** `text` already starts with the city name; `staleAt` (`HH:mm`, device zone) is set only when an old result is shown. */
export type WeatherView = { kind: 'no_city' } | { kind: 'hidden' } | { kind: 'ready'; text: string; staleAt: string | null };

export interface UseWeatherOptions {
  fetchFn?: typeof fetch;
  now?: () => Date;
  doc?: Document;
}

/** What one pass of `loadWeather` yields: a view, or `error` when local storage could not be read (keep what is shown). */
export type WeatherLoad = WeatherView | { kind: 'error' };

const HIDDEN: WeatherView = { kind: 'hidden' };

/** After a failed request, no new request for this long. In memory only: 近期 remounts on every tab switch. */
export const WEATHER_BACKOFF_MS = 10 * 60 * 1000;
let lastFail: { latitude: number; longitude: number; at: number } | null = null;

/** Tests only: forget the last failed request. */
export function resetWeatherBackoff(): void {
  lastFail = null;
}

/** The backoff belongs to the city that failed; another city (other latitude/longitude) is not held back. */
function inBackoff(city: City, nowMs: number): boolean {
  if (lastFail === null || lastFail.latitude !== city.latitude || lastFail.longitude !== city.longitude) return false;
  const since = nowMs - lastFail.at;
  // A clock that went back ends the wait rather than stretching it.
  return since >= 0 && since < WEATHER_BACKOFF_MS;
}

/** What a failure is, without any data: the message of our own errors, else just the error's name. */
function describe(e: unknown): string {
  if (e instanceof WeatherError) return e.message;
  return e instanceof Error ? e.name : typeof e;
}

function deviceZone(): string {
  const tz = deviceTimeZone();
  return isTimeZone(tz) ? tz : 'UTC';
}

/** `<city>：<summary>`; hidden when the forecast has nothing from the city's today on. */
function viewOf(city: City, forecast: Forecast, now: Date, staleAt: string | null): WeatherView {
  let today: string | undefined;
  if (isTimeZone(forecast.timezone)) today = localDateOf(now, forecast.timezone);
  else today = forecast.days.map((d) => d.date).sort()[0];
  if (!today) return HIDDEN;
  const summary = summarize(forecast.days, today);
  if (summary === null) return HIDDEN;
  return { kind: 'ready', text: `${city.name}：${summary}`, staleAt };
}

/** A fetch whose request also stops when `signal` aborts (the hook unmounted). */
function abortable(fetchFn: typeof fetch, signal: AbortSignal): typeof fetch {
  return (input, init) => {
    const c = new AbortController();
    const inner = init?.signal ?? null;
    const stop = () => c.abort();
    if (signal.aborted || inner?.aborted) c.abort();
    signal.addEventListener('abort', stop, { once: true });
    inner?.addEventListener('abort', stop, { once: true });
    return fetchFn(input, { ...init, signal: c.signal }).finally(() => {
      signal.removeEventListener('abort', stop);
      inner?.removeEventListener('abort', stop);
    });
  };
}

interface LoadOptions {
  fetchFn: typeof fetch;
  now: () => Date;
  signal: AbortSignal;
  /** Called before the request with the old result (cache under a day old), so it shows while the request runs. */
  onInterim?: (view: WeatherView) => void;
}

/**
 * One pass of the flow: city, cache, maybe one request. Never throws. A cache under 3 h is shown as is; an older one
 * under a day is handed to `onInterim` (marked with its time) before the request and is the result if the request fails.
 * Within `WEATHER_BACKOFF_MS` of a failed request no request is made.
 */
export async function loadWeather(db: LocalDb, o: LoadOptions): Promise<WeatherLoad> {
  try {
    const city = await getCity(db);
    if (!city) return { kind: 'no_city' };
    let cache = await getCache(db);
    // A cache of another city (Settings changed it) counts as none.
    if (cache && (cache.city.latitude !== city.latitude || cache.city.longitude !== city.longitude)) cache = null;
    const now = o.now();
    // A fetchedAt in the future (the clock went back) is not fresh and is not shown as an old result.
    const age = cache ? now.getTime() - Date.parse(cache.fetchedAt) : Number.NaN;
    if (cache && age >= 0 && age < WEATHER_TTL_MS) return viewOf(city, cache.forecast, now, null);
    const old = cache && age >= 0 && age < WEATHER_MAX_AGE_MS ? cache : null;
    const oldView = (): WeatherView =>
      old ? viewOf(city, old.forecast, o.now(), localTimeOf(new Date(old.fetchedAt), deviceZone())) : HIDDEN;

    if (inBackoff(city, now.getTime())) return oldView();
    if (old) o.onInterim?.(oldView());

    let forecast: Forecast;
    try {
      forecast = await fetchForecast(city, { fetchFn: abortable(o.fetchFn, o.signal) });
    } catch (e) {
      if (o.signal.aborted) return HIDDEN;
      lastFail = { latitude: city.latitude, longitude: city.longitude, at: o.now().getTime() };
      console.error('Weather request failed:', describe(e));
      return oldView();
    }
    // A success ends the backoff of its own city only; another city's failure keeps waiting.
    if (lastFail && lastFail.latitude === city.latitude && lastFail.longitude === city.longitude) lastFail = null;
    const fetchedAt = o.now();
    try {
      await saveCache(db, { city, fetchedAt: fetchedAt.toISOString(), forecast });
    } catch (e) {
      // Only the next refresh suffers: this result is still shown.
      console.error('Could not save the weather:', describe(e));
    }
    return viewOf(city, forecast, fetchedAt, null);
  } catch (e) {
    console.error('Could not load the weather:', describe(e));
    return { kind: 'error' };
  }
}

/**
 * The weather hint for the 近期 tab. Runs on mount and whenever the document becomes visible again (the cache keeps that
 * to one request per 3 hours, the backoff to none for 10 minutes after a failure). An old result shows while the
 * request runs and is swapped when it succeeds. A storage read error keeps what is shown (hidden on the first load).
 * Overlapping triggers share one run; after unmount the request is aborted and nothing is set. A city changed in
 * Settings is picked up when the 近期 tab mounts again.
 */
export function useWeather(db: LocalDb, o: UseWeatherOptions = {}): WeatherView {
  const [view, setView] = useState<WeatherView>(HIDDEN);
  const optsRef = useRef(o);
  optsRef.current = o;
  const inFlight = useRef<Promise<void> | null>(null);

  useEffect(() => {
    const doc = optsRef.current.doc ?? document;
    const controller = new AbortController();
    let live = true;

    const run = (): Promise<void> => {
      if (inFlight.current) return inFlight.current;
      const { fetchFn, now } = optsRef.current;
      const p: Promise<void> = loadWeather(db, {
        fetchFn: fetchFn ?? ((input, init) => fetch(input, init)),
        now: now ?? (() => new Date()),
        signal: controller.signal,
        onInterim: (v) => {
          if (live) setView(v);
        },
      })
        .then((v) => {
          if (live && v.kind !== 'error') setView(v);
        })
        .finally(() => {
          if (inFlight.current === p) inFlight.current = null;
        });
      inFlight.current = p;
      return p;
    };

    const onVisibility = () => {
      if (live && doc.visibilityState === 'visible') void run();
    };
    doc.addEventListener('visibilitychange', onVisibility);
    void run();

    return () => {
      live = false;
      controller.abort();
      doc.removeEventListener('visibilitychange', onVisibility);
      // A remount (StrictMode, a new db) must not wait on this aborted run.
      inFlight.current = null;
    };
  }, [db]);

  return view;
}
