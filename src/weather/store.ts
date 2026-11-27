import type { LocalDb } from '../data/local-db';
import { parseForecastShape, type City, type Forecast } from './api';

export const WEATHER_TTL_MS = 3 * 60 * 60 * 1000;
export const WEATHER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface CachedForecast { city: City; fetchedAt: string; forecast: Forecast }

const CITY_KEY = 'weather_city';
const CACHE_KEY = 'weather_cache';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nullableString = (v: unknown) => v === null || typeof v === 'string';

function parseCity(v: unknown): City | null {
  if (!isRecord(v) || typeof v.name !== 'string') return null;
  if (!nullableString(v.region) || !nullableString(v.country)) return null;
  if (typeof v.latitude !== 'number' || !Number.isFinite(v.latitude) || typeof v.longitude !== 'number' || !Number.isFinite(v.longitude)) return null;
  return { name: v.name, region: v.region as string | null, country: v.country as string | null, latitude: v.latitude, longitude: v.longitude };
}

export async function getCity(db: LocalDb): Promise<City | null> {
  return parseCity(await db.getMeta<unknown>(CITY_KEY));
}

export async function setCity(db: LocalDb, city: City): Promise<void> {
  await db.setMeta(CITY_KEY, city);
  await db.setMeta(CACHE_KEY, null);
}

export async function clearCity(db: LocalDb): Promise<void> {
  await db.setMeta(CITY_KEY, null);
  await db.setMeta(CACHE_KEY, null);
}

export async function getCache(db: LocalDb): Promise<CachedForecast | null> {
  const v = await db.getMeta<unknown>(CACHE_KEY);
  if (!isRecord(v)) return null;
  const city = parseCity(v.city);
  const forecast = parseForecastShape(v.forecast);
  if (!city || !forecast || typeof v.fetchedAt !== 'string' || Number.isNaN(Date.parse(v.fetchedAt))) return null;
  return { city, fetchedAt: v.fetchedAt, forecast };
}

export async function saveCache(db: LocalDb, c: CachedForecast): Promise<void> {
  await db.setMeta(CACHE_KEY, c);
}
