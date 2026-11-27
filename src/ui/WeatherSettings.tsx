import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { LocalDb } from '../data/local-db';
import { searchCities, type City } from '../weather/api';
import { clearCity, getCity, setCity } from '../weather/store';

export interface WeatherSettingsProps {
  db: LocalDb;
  /** Only tests pass this. */
  fetchFn?: typeof fetch;
}

/** 名字，省/州，国家, leaving out a missing part together with its comma. */
function cityLabel(c: City): string {
  return [c.name, c.region, c.country].filter((p): p is string => !!p).join('，');
}

export function WeatherSettings({ db, fetchFn }: WeatherSettingsProps) {
  const [current, setCurrent] = useState<City | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<City[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const guard = useRef(false);
  const live = useRef(true);
  /** Bumped when the query is edited, so a search still in flight for the old text shows nothing. */
  const queryGen = useRef(0);

  useEffect(() => {
    live.current = true;
    getCity(db)
      .then((c) => {
        if (live.current) setCurrent(c);
      })
      .catch(() => {});
    return () => {
      live.current = false;
    };
  }, [db]);

  async function search() {
    const name = query.trim();
    if (!name || guard.current) return;
    guard.current = true;
    const gen = queryGen.current;
    setSearching(true);
    setMessage(null);
    setResults([]);
    let found: City[] = [];
    let failed = false;
    try {
      found = (await searchCities(name, { fetchFn })).slice(0, 5);
    } catch {
      failed = true;
    } finally {
      guard.current = false;
    }
    if (!live.current) return;
    setSearching(false);
    if (gen !== queryGen.current) return;
    if (failed) setMessage('搜索失败，请稍后再试');
    else if (found.length === 0) setMessage('没有找到这个地方');
    else setResults(found);
  }

  async function choose(city: City) {
    if (guard.current) return;
    guard.current = true;
    try {
      await setCity(db, city);
      if (!live.current) return;
      setCurrent(city);
      setResults([]);
      setQuery('');
      setMessage(null);
    } catch {
      if (live.current) setMessage('保存失败，请稍后再试');
    } finally {
      guard.current = false;
    }
  }

  async function clear() {
    try {
      await clearCity(db);
      if (live.current) setCurrent(null);
    } catch {
      if (live.current) setMessage('清除失败，请稍后再试');
    }
  }

  function onQueryChange(value: string) {
    queryGen.current += 1;
    setQuery(value);
    setResults([]);
    setMessage(null);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void search();
  }

  return (
    <div className="card weather-settings">
      <h3>天气</h3>
      <p className="muted">天气只保存在这台设备上</p>
      {current && (
        <div className="weather-current">
          <span>{`当前城市：${current.name}`}</span>
          <button type="button" onClick={() => void clear()}>
            清除
          </button>
        </div>
      )}
      <form className="weather-search" onSubmit={onSubmit}>
        <label className="field">
          城市
          <input type="text" value={query} onChange={(e) => onQueryChange(e.target.value)} autoComplete="off" />
        </label>
        <button type="submit" disabled={searching}>
          {searching ? '搜索中…' : '搜索'}
        </button>
      </form>
      {message && (
        <p className="muted" role="status">
          {message}
        </p>
      )}
      {results.length > 0 && (
        <ul className="weather-results">
          {results.map((c, i) => (
            <li key={i}>
              <button type="button" onClick={() => void choose(c)}>
                {cityLabel(c)}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="muted">
        地点数据来自{' '}
        <a href="https://www.geonames.org" target="_blank" rel="noopener noreferrer">
          GeoNames
        </a>
      </p>
    </div>
  );
}
