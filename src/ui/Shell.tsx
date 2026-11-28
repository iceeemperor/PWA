import { useState } from 'react';
import { deviceTimeZone, isTimeZone, localDateOf } from '../domain/time';
import type { EventRecord } from '../domain/types';
import type { Services } from '../app/services';
import { CalendarPage } from './CalendarPage';
import { EventEditor } from './EventEditor';
import { ExportReminder } from './ExportReminder';
import { Settings } from './Settings';
import { SyncBanner } from './SyncBanner';
import { TodosPage } from './TodosPage';
import { useSyncStatus } from './useSyncStatus';

type Tab = 'todos' | 'calendar' | 'settings';

const today = (): string => {
  const tz = deviceTimeZone();
  return localDateOf(new Date(), isTimeZone(tz) ? tz : 'UTC');
};

const NAV: { tab: Tab; label: string }[] = [
  { tab: 'todos', label: '待办' },
  { tab: 'calendar', label: '日历' },
  { tab: 'settings', label: '设置' },
];

export interface ShellProps {
  services: Services;
  /** Asks before signing out with changes still queued. Defaults to window.confirm. */
  confirmFn?: (msg: string) => boolean;
}

const defaultConfirm = (msg: string) => window.confirm(msg);

/** The signed-in frame: sync state on top, bottom navigation on phones, side navigation from 768px. */
export function Shell({ services, confirmFn = defaultConfirm }: ShellProps) {
  const { repo, engine, auth } = services;
  const [tab, setTab] = useState<Tab>('todos');
  const [day, setDay] = useState(today);
  const [editing, setEditing] = useState<EventRecord | { date: string } | null>(null);
  const { status } = useSyncStatus(repo, engine);

  async function signOut() {
    // Read the queue at click time: the banner's cached count can lag a write made a moment ago.
    // If the read fails the count is unknown, so ask anyway with a count-free message
    // (a stale last-known count could say 0 and mislead).
    let pending: number | null;
    try {
      pending = await repo.pendingCount();
    } catch {
      pending = null;
    }
    if (pending === null || pending > 0) {
      const what = pending === null ? '可能还有改动' : `还有 ${pending} 项改动`;
      const ok = confirmFn(`${what}没有上传到云端。退出后它们仍保存在本机，下次登录会继续上传。确定退出登录？`);
      if (!ok) return;
    }
    await auth.signOut();
  }

  return (
    <div className="shell">
      <nav className="nav" aria-label="主导航">
        <div className="nav-brand">个人效率</div>
        {NAV.map((n) => (
          <button
            key={n.tab}
            type="button"
            className="nav-item"
            aria-current={tab === n.tab ? 'page' : undefined}
            onClick={() => setTab(n.tab)}
          >
            {n.label}
          </button>
        ))}
      </nav>
      <div className="main">
        <header className="topbar">
          <SyncBanner status={status} />
          <button type="button" className="link" onClick={() => void signOut()}>
            退出登录
          </button>
        </header>
        <main className="content">
          <ExportReminder services={services} onOpenSettings={tab === 'settings' ? undefined : () => setTab('settings')} />
          {tab === 'todos' && (
            <TodosPage
              services={services}
              onOpenDay={(date) => {
                setDay(date);
                setTab('calendar');
              }}
            />
          )}
          {tab === 'calendar' && (
            <CalendarPage services={services} day={day} onDayChange={setDay} onNewEvent={(date) => setEditing({ date })} onOpenEvent={setEditing} />
          )}
          {tab === 'settings' && <Settings services={services} />}
          {editing && <EventEditor key={'id' in editing ? editing.id : editing.date} repo={repo} initial={editing} onClose={() => setEditing(null)} />}
        </main>
      </div>
    </div>
  );
}
