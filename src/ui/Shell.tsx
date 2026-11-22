import { useState } from 'react';
import type { Services } from '../app/services';
import { ExportReminder } from './ExportReminder';
import { Settings } from './Settings';
import { SyncBanner } from './SyncBanner';
import { TodosTemp } from './TodosTemp';
import { useSyncStatus } from './useSyncStatus';

type Tab = 'todos' | 'settings';

const NAV: { tab: Tab; label: string }[] = [
  { tab: 'todos', label: '待办' },
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
  const { status, loaded } = useSyncStatus(repo, engine);

  async function signOut() {
    // The count is normally known already, so the question comes straight from the click.
    const pending = loaded ? status.pending : await repo.pendingCount();
    if (pending > 0) {
      const ok = confirmFn(`还有 ${pending} 项改动没有上传到云端。退出后它们仍保存在本机，下次登录会继续上传。确定退出登录？`);
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
          {tab === 'todos' ? <TodosTemp repo={repo} engine={engine} /> : <Settings services={services} />}
        </main>
      </div>
    </div>
  );
}
