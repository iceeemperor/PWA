import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { buildAgenda, goalsOf, type AgendaItem, type SortMode } from '../agenda/agenda';
import type { Services } from '../app/services';
import { addDays, deviceTimeZone, isTimeZone, localDateOf } from '../domain/time';
import type { TodoRecord } from '../domain/types';
import { GoalCard } from './GoalCard';
import { PRIORITIES, PRIORITY_LABELS, TodoEditor } from './TodoEditor';
import { useLiveRecords } from './useLiveRecords';
import { useWriteAttempt, WriteError } from './write-error';

export interface TodosPageProps {
  services: Services;
  /** Opens the calendar on a day (`YYYY-MM-DD`): the 日历 mark of an item that comes from the calendar. */
  onOpenDay: (date: string) => void;
}

type Tab = 'upcoming' | 'goals';
type Priority = TodoRecord['priority'];

const TABS: { tab: Tab; label: string }[] = [
  { tab: 'upcoming', label: '近期' },
  { tab: 'goals', label: '目标' },
];

/** Local meta key of the sort choice. Kept on this device only, never synced (spec 6.2). */
export const SORT_META_KEY = 'agenda_sort';
const isSortMode = (v: unknown): v is SortMode => v === 'priority' || v === 'date';

/** 今天 / 明天 / M月D日, plus ` HH:mm` when the item has a time. `today` is the device's date. */
export function dateLabel(date: string, time: string | null, today: string): string {
  let day: string;
  if (date === today) day = '今天';
  else if (date === addDays(today, 1)) day = '明天';
  else day = `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
  return time ? `${day} ${time}` : day;
}

function deviceZone(): string {
  const tz = deviceTimeZone();
  return isTimeZone(tz) ? tz : 'UTC';
}

/** The to-do area: 近期 (todos and important calendar items, merged) and 目标 (goals). */
export function TodosPage({ services, onOpenDay }: TodosPageProps) {
  const [tab, setTab] = useState<Tab>('upcoming');
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ upcoming: null, goals: null });

  function onTabKey(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next: Tab = tab === 'upcoming' ? 'goals' : 'upcoming';
    setTab(next);
    tabRefs.current[next]?.focus();
  }

  return (
    <section className="page todos-page">
      <div className="tabs" role="tablist" aria-label="待办">
        {TABS.map((t) => (
          <button
            key={t.tab}
            ref={(el) => {
              tabRefs.current[t.tab] = el;
            }}
            type="button"
            role="tab"
            id={`todos-tab-${t.tab}`}
            aria-selected={tab === t.tab}
            aria-controls={`todos-panel-${t.tab}`}
            tabIndex={tab === t.tab ? 0 : -1}
            className="tab"
            onClick={() => setTab(t.tab)}
            onKeyDown={onTabKey}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`todos-panel-${tab}`} aria-labelledby={`todos-tab-${tab}`}>
        {tab === 'upcoming' ? <Upcoming services={services} onOpenDay={onOpenDay} /> : <Goals services={services} />}
      </div>
    </section>
  );
}

function Upcoming({ services, onOpenDay }: TodosPageProps) {
  const { repo, engine, db } = services;
  const todos = useLiveRecords(repo, engine, 'todos');
  const events = useLiveRecords(repo, engine, 'events');
  const { error, attempt } = useWriteAttempt();

  const [mode, setMode] = useState<SortMode>('priority');
  const [modeLoaded, setModeLoaded] = useState(false);
  const modeTouched = useRef(false);
  const [showDone, setShowDone] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<Priority>('normal');
  const [date, setDate] = useState('');

  useEffect(() => {
    let live = true;
    db.getMeta<unknown>(SORT_META_KEY)
      .then((v) => {
        // A toggle made before the read finished wins.
        if (live && !modeTouched.current && isSortMode(v)) setMode(v);
      })
      .catch((e) => console.error('Could not read the sort choice', e))
      .finally(() => {
        if (live) setModeLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [db]);

  function toggleMode() {
    const next: SortMode = mode === 'priority' ? 'date' : 'priority';
    modeTouched.current = true;
    setMode(next);
    // Only a convenience: a failed save keeps the choice for this session.
    db.setMeta(SORT_META_KEY, next).catch((e) => console.error('Could not save the sort choice', e));
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    const ok = await attempt(() => repo.create('todos', { title: t, priority, due_date: date === '' ? null : date }));
    if (ok) {
      setTitle('');
      setDate('');
      setPriority('normal');
    }
  }

  function tick(item: AgendaItem, done: boolean) {
    void attempt(() => (item.source === 'todo' ? repo.update('todos', item.id, { done }) : repo.update('events', item.id, { done })));
  }

  const tz = deviceZone();
  const now = new Date();
  const today = localDateOf(now, tz);
  const agenda = buildAgenda(todos, events, { now, tz, mode, showDone });
  const byId = new Map(todos.map((t) => [t.id, t]));
  const openCount = agenda.groups.reduce((n, g) => n + g.items.length, 0);

  const row = (item: AgendaItem) => {
    const todo = item.source === 'todo' ? byId.get(item.id) : undefined;
    if (todo && editing === item.id) {
      return (
        <li key={`${item.source}-${item.id}`} className="agenda-item editing">
          <TodoEditor todo={todo} repo={repo} onClose={() => setEditing(null)} />
        </li>
      );
    }
    return (
      <AgendaRow
        key={`${item.source}-${item.id}`}
        item={item}
        note={todo?.note ?? ''}
        today={today}
        onTick={(done) => tick(item, done)}
        onEdit={todo ? () => setEditing(item.id) : undefined}
        onOpenDay={onOpenDay}
      />
    );
  };

  return (
    <div className="upcoming">
      <form className="quick-add" onSubmit={add}>
        <input className="quick-title" placeholder="新待办" aria-label="新待办" value={title} onChange={(e) => setTitle(e.target.value)} />
        <div className="quick-options">
          <label className="inline-field">
            优先级
            <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
          </label>
          <label className="inline-field">
            日期
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <button type="submit" className="primary">
            添加
          </button>
        </div>
      </form>
      <WriteError error={error} />
      <div className="agenda-toolbar">
        <button type="button" onClick={toggleMode}>
          排序：{mode === 'priority' ? '按优先级' : '按日期'}
        </button>
        <label className="check">
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
          显示已完成
        </label>
      </div>
      {modeLoaded && (
        <>
          {openCount === 0 ? (
            <p className="muted empty">近期没有待办</p>
          ) : (
            agenda.groups
              .filter((g) => g.items.length > 0)
              .map((g) => (
                <section key={g.priority ?? 'all'} className="agenda-group">
                  {g.priority && <h3 className={`group-title ${g.priority}`}>{PRIORITY_LABELS[g.priority]}</h3>}
                  <ul className="agenda-list">{g.items.map(row)}</ul>
                </section>
              ))
          )}
          {showDone && (
            <section className="agenda-group" aria-label="已完成">
              <h3 className="group-title">已完成</h3>
              {agenda.done.length === 0 ? <p className="muted empty">没有已完成的项目</p> : <ul className="agenda-list">{agenda.done.map(row)}</ul>}
            </section>
          )}
        </>
      )}
    </div>
  );
}

interface AgendaRowProps {
  item: AgendaItem;
  note: string;
  today: string;
  onTick: (done: boolean) => void;
  /** Todos only: opens the editor. */
  onEdit?: () => void;
  onOpenDay: (date: string) => void;
}

function AgendaRow({ item, note, today, onTick, onEdit, onOpenDay }: AgendaRowProps) {
  const label = item.date === null ? null : dateLabel(item.date, item.time, today);
  const classes = ['agenda-item'];
  if (item.done) classes.push('done');
  if (item.overdue) classes.push('overdue');
  return (
    <li className={classes.join(' ')}>
      <label className="hit">
        <input type="checkbox" aria-label={item.title} checked={item.done} onChange={(e) => onTick(e.target.checked)} />
      </label>
      <div className="agenda-main">
        {onEdit ? (
          <button type="button" className="agenda-title" onClick={onEdit}>
            {item.title}
          </button>
        ) : (
          <span className="agenda-title">{item.title}</span>
        )}
        {note && <p className="item-note">{note}</p>}
        <div className="agenda-meta">
          <span className={`prio-dot ${item.priority}`} role="img" aria-label={`优先级${PRIORITY_LABELS[item.priority]}`} />
          {label && <span className="agenda-date">{label}</span>}
          {item.overdue && <span className="overdue-mark">已过期</span>}
          {item.source === 'event' && item.date && (
            <button type="button" className="cal-mark" aria-label={`日历：打开${label}`} onClick={() => onOpenDay(item.date!)}>
              <span className="cal-pill">日历</span>
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

function Goals({ services }: { services: Services }) {
  const { repo, engine } = services;
  const todos = useLiveRecords(repo, engine, 'todos');
  const { error, attempt } = useWriteAttempt();
  const [title, setTitle] = useState('');

  async function add(e: FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    if (await attempt(() => repo.create('todos', { title: t, kind: 'goal' }))) setTitle('');
  }

  const goals = goalsOf(todos);
  const open = goals.filter((g) => !g.done);
  const done = goals.filter((g) => g.done);

  return (
    <div className="goals">
      <form className="quick-add goal-add" onSubmit={add}>
        <input className="quick-title" placeholder="新目标" aria-label="新目标" value={title} onChange={(e) => setTitle(e.target.value)} />
        <button type="submit" className="primary">
          添加
        </button>
      </form>
      <WriteError error={error} />
      {open.length === 0 && <p className="muted empty">还没有进行中的目标</p>}
      {open.map((g) => (
        <GoalCard key={g.id} goal={g} repo={repo} />
      ))}
      {done.length > 0 && (
        <details className="done-goals">
          <summary>已完成的目标</summary>
          {done.map((g) => (
            <GoalCard key={g.id} goal={g} repo={repo} />
          ))}
        </details>
      )}
    </div>
  );
}
