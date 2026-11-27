import { addDays } from '../domain/time';

export type WeatherKind = 'sunny' | 'cloudy' | 'fog' | 'rain' | 'snow' | 'thunder';

export interface DayWeather { date: string; code: number }

const inRange = (c: number, lo: number, hi: number) => c >= lo && c <= hi;

/** WMO weather code to a coarse kind; null for non-integers and unlisted codes. */
export function weatherKind(code: number): WeatherKind | null {
  if (!Number.isInteger(code)) return null;
  if (code === 0 || code === 1) return 'sunny';
  if (code === 2 || code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if (inRange(code, 51, 57) || inRange(code, 61, 67) || inRange(code, 80, 82)) return 'rain';
  if (inRange(code, 71, 77) || code === 85 || code === 86) return 'snow';
  if (inRange(code, 95, 99)) return 'thunder';
  return null;
}

const DAY_NAME = ['今天', '明天', '后天'];
const PHRASE: Record<WeatherKind, string> = { sunny: '晴', cloudy: '多云', fog: '有雾', rain: '有雨', snow: '有雪', thunder: '有雷雨' };

/** One-line Chinese summary of today/tomorrow/day-after; null when nothing usable. Never throws. */
export function summarize(days: DayWeather[], today: string): string | null {
  try {
    if (!Array.isArray(days)) return null;
    const dates = [0, 1, 2].map((n) => addDays(today, n));
    // offset (0..2) -> kind; days before today, malformed dates and unknown codes drop out.
    const byOffset: (WeatherKind | null)[] = [null, null, null];
    const sorted = days
      .filter((x) => x && typeof x.date === 'string' && x.date >= today)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    for (const x of sorted) {
      const i = dates.indexOf(x.date);
      if (i < 0 || byOffset[i] !== null) continue;
      byOffset[i] = weatherKind(x.code);
    }
    if (byOffset.every((k) => k === null)) return null;
    const [a, b, c] = byOffset;
    if (a && a === b && b === c) {
      return `未来三天都${a === 'sunny' || a === 'cloudy' ? '是' : ''}${PHRASE[a]}`;
    }
    const parts: string[] = [];
    let i = 0;
    while (i < 3) {
      const kind = byOffset[i];
      if (!kind) { i++; continue; }
      let j = i;
      while (j + 1 < 3 && byOffset[j + 1] === kind) j++;
      const len = j - i + 1;
      const first = parts.length === 0;
      if (len === 1) parts.push(`${DAY_NAME[i]}${PHRASE[kind]}`);
      else if (len === 2) parts.push(first ? `${DAY_NAME[i]}和${DAY_NAME[j]}${PHRASE[kind]}` : `${DAY_NAME[i]}起连续两天${PHRASE[kind]}`);
      i = j + 1;
    }
    return parts.join('，');
  } catch {
    return null;
  }
}
