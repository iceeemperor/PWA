import { useMemo } from 'react';
import { eventTime } from '../agenda/agenda';
import type { Services } from '../app/services';
import { eventsOnDay, monthGrid } from '../calendar/month';
import { deviceTimeZone, isTimeZone, localDateOf, zonedToInstant } from '../domain/time';
import type { EventRecord } from '../domain/types';
import { useLiveRecords } from './useLiveRecords';

export interface CalendarPageProps {
  services: Services;
  /** The selected day (`YYYY-MM-DD`); the month shown follows it. */
  day: string;
  onDayChange: (d: string) => void;
  /** 新建事项 for the selected day (the editor itself is wired by the shell). */
  onNewEvent: (date: string) => void;
  onOpenEvent: (e: EventRecord) => void;
}

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
const MAX_DOTS = 3;

function deviceZone(): string {
  const tz = deviceTimeZone();
  return isTimeZone(tz) ? tz : 'UTC';
}

const monthDay = (date: string): string => `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;

/** The same day number in the month `delta` months away, clamped to that month's length. */
function shiftMonth(day: string, delta: number): string {
  const total = Number(day.slice(0, 4)) * 12 + (Number(day.slice(5, 7)) - 1) + delta;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const prefix = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-`;
  const probe = new Date(0);
  probe.setUTCFullYear(year, month, 0); // day 0 of the next month: the last day of this one
  const d = Math.min(Number(day.slice(8, 10)), probe.getUTCDate());
  return `${prefix}${String(d).padStart(2, '0')}`;
}

/** A short zone name (GMT-5), or the IANA id when Intl cannot name the zone. */
function zoneLabel(e: EventRecord): string {
  const tz = e.tz as string;
  if (!isTimeZone(tz)) return tz;
  try {
    const at = zonedToInstant(e.starts_at, tz);
    const part = new Intl.DateTimeFormat('zh-CN', { timeZone: tz, timeZoneName: 'short' }).formatToParts(at).find((p) => p.type === 'timeZoneName');
    return part?.value ?? tz;
  } catch {
    return tz;
  }
}

const isDoneImportant = (e: EventRecord): boolean => e.important && e.done;

/** The calendar: a Monday-first month grid on top, the events of the selected day below. */
export function CalendarPage({ services, day, onDayChange, onNewEvent, onOpenEvent }: CalendarPageProps) {
  const events = useLiveRecords(services.repo, services.engine, 'events');
  const tz = deviceZone();
  const today = localDateOf(new Date(), tz);
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const weeks = useMemo(() => monthGrid(year, month), [year, month]);
  const byDay = useMemo(() => {
    const m = new Map<string, EventRecord[]>();
    for (const date of weeks.flat()) m.set(date, eventsOnDay(events, date, tz));
    return m;
  }, [weeks, events, tz]);
  const selected = eventsOnDay(events, day, tz);

  return (
    <section className="page calendar-page">
      <div className="month-bar">
        <button type="button" className="month-nav" onClick={() => onDayChange(shiftMonth(day, -1))}>
          上个月
        </button>
        <h2 className="month-title">{`${year}年${month}月`}</h2>
        <button type="button" className="month-nav" onClick={() => onDayChange(shiftMonth(day, 1))}>
          下个月
        </button>
        <button type="button" className="month-nav today-btn" onClick={() => onDayChange(today)}>
          今天
        </button>
      </div>
      <div className="month-grid" role="grid" aria-label={`${year}年${month}月`}>
        <div className="month-row" role="row">
          {WEEKDAYS.map((w) => (
            <div key={w} className="weekday" role="columnheader">
              {w}
            </div>
          ))}
        </div>
        {weeks.map((week) => (
          <div key={week[0]} className="month-row" role="row">
            {week.map((date) => {
              const list = byDay.get(date) ?? [];
              const classes = ['day-cell'];
              if (date.slice(0, 7) !== day.slice(0, 7)) classes.push('outside');
              if (date === today) classes.push('today');
              if (date === day) classes.push('selected');
              const name = list.length > 0 ? `${monthDay(date)}，有 ${list.length} 个事项` : monthDay(date);
              return (
                <div key={date} role="gridcell" className="day-slot">
                  <button
                    type="button"
                    className={classes.join(' ')}
                    aria-label={name}
                    aria-current={date === today ? 'date' : undefined}
                    aria-pressed={date === day}
                    onClick={() => onDayChange(date)}
                  >
                    <span className="day-num" aria-hidden="true">
                      {Number(date.slice(8, 10))}
                    </span>
                    <span className="dots" aria-hidden="true">
                      {list.slice(0, MAX_DOTS).map((e) => (
                        <span
                          key={e.id}
                          data-testid="event-dot"
                          className={`event-dot${e.important ? ' important' : ''}${isDoneImportant(e) ? ' done-important' : ''}`}
                        />
                      ))}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="day-header">
        <h3>{monthDay(day)}</h3>
        <button type="button" className="primary" onClick={() => onNewEvent(day)}>
          新建事项
        </button>
      </div>
      {selected.length === 0 ? (
        <p className="muted empty">这一天没有事项</p>
      ) : (
        <ul className="day-events" aria-label={`${monthDay(day)}的事项`}>
          {selected.map((e) => {
            const time = eventTime(e, tz);
            const foreign = !e.all_day && e.tz !== null && e.tz !== tz;
            return (
              <li key={e.id} className="day-event">
                <button type="button" className="day-event-btn" onClick={() => onOpenEvent(e)}>
                  <span className="event-time">
                    {e.all_day ? '全天' : (time ?? '')}
                    {foreign && <span className="event-tz">{zoneLabel(e)}</span>}
                  </span>
                  <span className={`event-title${e.done ? ' done' : ''}${isDoneImportant(e) ? ' done-important' : ''}`}>{e.title}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
