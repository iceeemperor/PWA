import type { LocalDb } from '../data/local-db';
import { useWeather } from '../weather/useWeather';

export interface WeatherLineProps {
  db: LocalDb;
  /** Tests only. */
  fetchFn?: typeof fetch;
}

/** One muted line at the top of 近期: the city's weather for today to the day after, or a hint to pick a city. */
export function WeatherLine({ db, fetchFn }: WeatherLineProps) {
  const view = useWeather(db, fetchFn ? { fetchFn } : {});
  if (view.kind === 'hidden') return null;
  if (view.kind === 'no_city') return <p className="weather-line">在设置里选一个城市即可显示天气</p>;
  return (
    <p className="weather-line">
      <span>{view.staleAt ? `${view.text}（${view.staleAt} 更新）` : view.text}</span>{' '}
      <a className="weather-credit" href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">
        Open-Meteo
      </a>
    </p>
  );
}
