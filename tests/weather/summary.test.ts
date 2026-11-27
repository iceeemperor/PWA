import { describe, expect, it } from 'vitest';
import { summarize, weatherKind } from '../../src/weather/summary';

describe('weatherKind', () => {
  it.each([[0, 'sunny'], [1, 'sunny'], [2, 'cloudy'], [3, 'cloudy'], [45, 'fog'], [48, 'fog'], [51, 'rain'], [57, 'rain'], [61, 'rain'], [67, 'rain'], [80, 'rain'], [82, 'rain'],
    [71, 'snow'], [77, 'snow'], [85, 'snow'], [86, 'snow'], [95, 'thunder'], [96, 'thunder'], [99, 'thunder'], [4, null], [100, null], [-1, null], [1.5, null]])
    ('weatherKind(%s) is %s', (code, kind) => expect(weatherKind(code)).toBe(kind));
});

describe('summarize', () => {
  const d = (date: string, code: number) => ({ date, code });
  it('three days of the same kind', () => {
    expect(summarize([d('2026-11-27', 0), d('2026-11-28', 1), d('2026-11-29', 0)], '2026-11-27')).toBe('未来三天都是晴');
    expect(summarize([d('2026-11-27', 61), d('2026-11-28', 63), d('2026-11-29', 80)], '2026-11-27')).toBe('未来三天都有雨');
    expect(summarize([d('2026-11-27', 3), d('2026-11-28', 2), d('2026-11-29', 3)], '2026-11-27')).toBe('未来三天都是多云');
  });
  it('runs are joined with a comma', () => {
    expect(summarize([d('2026-11-27', 0), d('2026-11-28', 61), d('2026-11-29', 61)], '2026-11-27')).toBe('今天晴，明天起连续两天有雨');
    expect(summarize([d('2026-11-27', 3), d('2026-11-28', 0), d('2026-11-29', 61)], '2026-11-27')).toBe('今天多云，明天晴，后天有雨');
    expect(summarize([d('2026-11-27', 61), d('2026-11-28', 61), d('2026-11-29', 0)], '2026-11-27')).toBe('今天和明天有雨，后天晴');
    expect(summarize([d('2026-11-27', 95), d('2026-11-28', 71), d('2026-11-29', 45)], '2026-11-27')).toBe('今天有雷雨，明天有雪，后天有雾');
  });
  it('drops days before today, so a cache from yesterday shifts', () =>
    expect(summarize([d('2026-11-26', 61), d('2026-11-27', 0), d('2026-11-28', 0)], '2026-11-27')).toBe('今天和明天晴'));
  it('skips unknown codes and returns null when nothing is left', () => {
    expect(summarize([d('2026-11-27', 4), d('2026-11-28', 0), d('2026-11-29', 0)], '2026-11-27')).toBe('明天和后天晴');
    expect(summarize([d('2026-11-26', 0)], '2026-11-27')).toBeNull(); expect(summarize([], '2026-11-27')).toBeNull();
  });
  it('ignores input order', () => expect(summarize([d('2026-11-29', 0), d('2026-11-27', 61), d('2026-11-28', 0)], '2026-11-27')).toBe('今天有雨，明天起连续两天晴'));
  it('never throws on malformed dates; they are ignored', () => {
    expect(summarize([d('not-a-date', 0), d('2026-13-45x', 0), d('2026-11-27', 0)], '2026-11-27')).toBe('今天晴');
    expect(summarize([d('garbage', 0)], '2026-11-27')).toBeNull();
    expect(summarize([d('2026-11-27', 0)], 'bad-today')).toBeNull();
  });
});
