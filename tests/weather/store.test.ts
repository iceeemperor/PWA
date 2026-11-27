import { describe, expect, it } from 'vitest';
import { openLocalDb } from '../../src/data/local-db';
import { clearCity, getCache, getCity, saveCache, setCity, WEATHER_MAX_AGE_MS, WEATHER_TTL_MS, type CachedForecast } from '../../src/weather/store';
import type { City } from '../../src/weather/api';

const SH: City = { name: '上海', region: '上海市', country: '中国', latitude: 31.22, longitude: 121.46 };
const BJ: City = { name: '北京', region: null, country: '中国', latitude: 39.9, longitude: 116.4 };
const cache = (city: City): CachedForecast => ({ city, fetchedAt: '2026-11-27T01:00:00.000Z', forecast: { timezone: 'Asia/Shanghai', days: [{ date: '2026-11-27', code: 0 }] } });
let n = 0;
const open = () => openLocalDb(`weather-store-${++n}`);

describe('weather store', () => {
  it('exposes the TTL constants', () => {
    expect(WEATHER_TTL_MS).toBe(10_800_000);
    expect(WEATHER_MAX_AGE_MS).toBe(86_400_000);
  });

  it('reads null when nothing is stored', async () => {
    const db = await open();
    expect(await getCity(db)).toBeNull();
    expect(await getCache(db)).toBeNull();
    db.close();
  });

  it('round-trips the city and the cache', async () => {
    const db = await open();
    await setCity(db, SH);
    await saveCache(db, cache(SH));
    expect(await getCity(db)).toEqual(SH);
    expect(await getCache(db)).toEqual(cache(SH));
    db.close();
  });

  it('setCity stores the city and drops the cache', async () => {
    const db = await open();
    await setCity(db, SH);
    await saveCache(db, cache(SH));
    await setCity(db, BJ);
    expect(await getCache(db)).toBeNull();
    expect(await getCity(db)).toEqual(BJ);
    db.close();
  });

  it('clearCity removes both', async () => {
    const db = await open();
    await setCity(db, SH);
    await saveCache(db, cache(SH));
    await clearCity(db);
    expect(await getCity(db)).toBeNull();
    expect(await getCache(db)).toBeNull();
    db.close();
  });

  it('a malformed stored cache or city reads as null', async () => {
    const db = await open();
    for (const bad of [{ x: 1 }, 'str', 5, [], { ...SH, latitude: '1' }, { ...SH, name: 3 }, { ...SH, region: 4 }]) {
      await db.setMeta('weather_city', bad);
      expect(await getCity(db)).toBeNull();
    }
    const good = cache(SH);
    for (const bad of [{ x: 1 }, null, { ...good, fetchedAt: 'nope' }, { ...good, fetchedAt: 5 }, { ...good, city: { x: 1 } },
      { ...good, forecast: { timezone: 'UTC', days: [{ date: 'bad', code: 0 }] } }, { ...good, forecast: { timezone: 'UTC', days: [{ date: '2026-11-27', code: 1.5 }] } },
      { ...good, forecast: { timezone: 3, days: [] } }]) {
      await db.setMeta('weather_cache', bad);
      expect(await getCache(db)).toBeNull();
    }
    db.close();
  });
});
