import type { DayWeather } from './summary';

export interface City { name: string; region: string | null; country: string | null; latitude: number; longitude: number }
export interface Forecast { timezone: string; days: DayWeather[] }

export class WeatherError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WeatherError';
  }
}

interface Options { fetchFn?: typeof fetch; timeoutMs?: number }

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const SEARCH_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validates a forecast-shaped value (timezone plus days of {date, code}); null when malformed. */
export function parseForecastShape(v: unknown): Forecast | null {
  if (!isRecord(v) || typeof v.timezone !== 'string' || !Array.isArray(v.days)) return null;
  const days: DayWeather[] = [];
  for (const d of v.days) {
    if (!isRecord(d) || typeof d.date !== 'string' || !DATE_RE.test(d.date) || !Number.isInteger(d.code)) return null;
    days.push({ date: d.date, code: d.code as number });
  }
  return { timezone: v.timezone, days };
}

async function getJson(url: URL, o: Options): Promise<unknown> {
  const fetchFn = o.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? 8000);
  try {
    let res: Response;
    try {
      res = await fetchFn(url.toString(), { signal: controller.signal });
    } catch (cause) {
      throw new WeatherError('Weather request failed', { cause });
    }
    if (!res.ok) throw new WeatherError(`Weather service returned HTTP ${res.status}`);
    try {
      return await res.json();
    } catch (cause) {
      throw new WeatherError('Weather response was not JSON', { cause });
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchForecast(city: City, o: Options = {}): Promise<Forecast> {
  const url = new URL(FORECAST_URL);
  url.searchParams.set('latitude', String(city.latitude));
  url.searchParams.set('longitude', String(city.longitude));
  url.searchParams.set('daily', 'weather_code');
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('forecast_days', '3');
  const body = await getJson(url, o);
  const daily = isRecord(body) ? body.daily : undefined;
  if (!isRecord(body) || !isRecord(daily) || !Array.isArray(daily.time) || !Array.isArray(daily.weather_code) || daily.time.length !== daily.weather_code.length) {
    throw new WeatherError('Weather response had an unexpected shape');
  }
  const forecast = parseForecastShape({
    timezone: body.timezone,
    days: daily.time.map((date: unknown, i: number) => ({ date, code: (daily.weather_code as unknown[])[i] })),
  });
  if (!forecast) throw new WeatherError('Weather response had an unexpected shape');
  return forecast;
}

export async function searchCities(query: string, o: Options = {}): Promise<City[]> {
  const name = query.trim();
  if (!name) return [];
  const url = new URL(SEARCH_URL);
  url.searchParams.set('name', name);
  url.searchParams.set('count', '5');
  url.searchParams.set('language', 'zh');
  url.searchParams.set('format', 'json');
  const body = await getJson(url, o);
  if (!isRecord(body)) throw new WeatherError('City search response had an unexpected shape');
  if (body.results === undefined || body.results === null) return [];
  if (!Array.isArray(body.results)) throw new WeatherError('City search response had an unexpected shape');
  const cities: City[] = [];
  for (const r of body.results) {
    if (!isRecord(r) || typeof r.name !== 'string') continue;
    if (typeof r.latitude !== 'number' || !Number.isFinite(r.latitude) || typeof r.longitude !== 'number' || !Number.isFinite(r.longitude)) continue;
    cities.push({
      name: r.name,
      region: typeof r.admin1 === 'string' ? r.admin1 : null,
      country: typeof r.country === 'string' ? r.country : null,
      latitude: r.latitude,
      longitude: r.longitude,
    });
  }
  return cities;
}
