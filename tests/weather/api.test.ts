import { describe, expect, it, vi } from 'vitest';
import { WeatherError, fetchForecast, searchCities, type City } from '../../src/weather/api';

const SH: City = { name: '上海', region: '上海市', country: '中国', latitude: 31.22, longitude: 121.46 };
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('fetchForecast', () => {
  it('requests the daily weather code for 3 days in the city zone', async () => {
    const fetchFn = vi.fn().mockResolvedValue(ok({ timezone: 'Asia/Shanghai', daily: { time: ['2026-11-27', '2026-11-28', '2026-11-29'], weather_code: [0, 61, 3] } }));
    const f = await fetchForecast(SH, { fetchFn });
    const url = new URL(fetchFn.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe('https://api.open-meteo.com/v1/forecast');
    expect(Object.fromEntries(url.searchParams)).toEqual({ latitude: '31.22', longitude: '121.46', daily: 'weather_code', timezone: 'auto', forecast_days: '3' });
    expect(fetchFn.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(f).toEqual({ timezone: 'Asia/Shanghai', days: [{ date: '2026-11-27', code: 0 }, { date: '2026-11-28', code: 61 }, { date: '2026-11-29', code: 3 }] });
  });

  it.each([
    ['HTTP 500', () => new Response('x', { status: 500 })],
    ['HTTP 400 with reason', () => new Response(JSON.stringify({ error: true, reason: 'bad' }), { status: 400 })],
    ['not JSON', () => new Response('<html>', { status: 200 })],
    ['no daily', () => ok({ timezone: 'UTC' })],
    ['no timezone', () => ok({ daily: { time: ['2026-11-27'], weather_code: [0] } })],
    ['length mismatch', () => ok({ timezone: 'UTC', daily: { time: ['2026-11-27'], weather_code: [0, 1] } })],
    ['code not an integer', () => ok({ timezone: 'UTC', daily: { time: ['2026-11-27'], weather_code: ['0'] } })],
    ['code fractional', () => ok({ timezone: 'UTC', daily: { time: ['2026-11-27'], weather_code: [1.5] } })],
    ['bad date', () => ok({ timezone: 'UTC', daily: { time: ['27/11'], weather_code: [0] } })],
  ])('throws WeatherError on %s', async (_n, res) => {
    await expect(fetchForecast(SH, { fetchFn: vi.fn().mockResolvedValue(res()) })).rejects.toBeInstanceOf(WeatherError);
  });

  it('does not leak the response body into the error', async () => {
    const err = await fetchForecast(SH, { fetchFn: vi.fn().mockResolvedValue(new Response('SECRET-BODY', { status: 500 })) }).catch((e) => e);
    expect(err.message).not.toContain('SECRET-BODY');
  });

  it('throws WeatherError on a network failure and on timeout', async () => {
    await expect(fetchForecast(SH, { fetchFn: vi.fn().mockRejectedValue(new TypeError('fail')) })).rejects.toBeInstanceOf(WeatherError);
    const hang = vi.fn((_u: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    }));
    await expect(fetchForecast(SH, { fetchFn: hang as unknown as typeof fetch, timeoutMs: 10 })).rejects.toBeInstanceOf(WeatherError);
  });
});

describe('searchCities', () => {
  it('sends name, count 5, language zh and maps results', async () => {
    const fetchFn = vi.fn().mockResolvedValue(ok({ results: [{ id: 1, name: '上海', latitude: 31.22, longitude: 121.46, country: '中国', admin1: '上海市' }, { id: 2, name: 'x' }, { id: 3, latitude: 1, longitude: 2 }, { id: 4, name: 'Nowhere', latitude: 1, longitude: 2 }] }));
    expect(await searchCities(' 上海 ', { fetchFn })).toEqual([
      { name: '上海', region: '上海市', country: '中国', latitude: 31.22, longitude: 121.46 },
      { name: 'Nowhere', region: null, country: null, latitude: 1, longitude: 2 },
    ]);
    const url = new URL(fetchFn.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe('https://geocoding-api.open-meteo.com/v1/search');
    expect(Object.fromEntries(url.searchParams)).toEqual({ name: '上海', count: '5', language: 'zh', format: 'json' });
  });

  it('no results is an empty list; a blank query makes no request', async () => {
    expect(await searchCities('xyz', { fetchFn: vi.fn().mockResolvedValue(ok({ generationtime_ms: 1 })) })).toEqual([]);
    const fetchFn = vi.fn();
    expect(await searchCities('  ', { fetchFn })).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('throws WeatherError on failures', async () => {
    await expect(searchCities('a', { fetchFn: vi.fn().mockResolvedValue(new Response('{}', { status: 400 })) })).rejects.toBeInstanceOf(WeatherError);
    await expect(searchCities('a', { fetchFn: vi.fn().mockResolvedValue(new Response('<', { status: 200 })) })).rejects.toBeInstanceOf(WeatherError);
    await expect(searchCities('a', { fetchFn: vi.fn().mockRejectedValue(new Error('x')) })).rejects.toBeInstanceOf(WeatherError);
  });
});
