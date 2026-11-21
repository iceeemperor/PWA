import type { SyncStatus } from '../sync/engine';

const STATE_TEXT: Partial<Record<SyncStatus['state'], string>> = {
  syncing: '正在同步…',
  offline: '离线',
  unavailable: '云端暂时无法连接，本机数据不受影响',
  auth_expired: '登录已过期',
};

/** One line of sync state. A non-empty queue is always shown (spec 8.3): it may be the only copy of those changes. */
export function SyncBanner({ status }: { status: SyncStatus }) {
  const parts: string[] = [];
  const stateText = STATE_TEXT[status.state];
  if (stateText) parts.push(stateText);
  if (status.pending > 0) parts.push(`未同步 ${status.pending} 项`);
  if (status.failed > 0) parts.push(`同步失败 ${status.failed} 项`);
  if (parts.length === 0) parts.push('已同步');

  const warn = status.pending > 0 || status.failed > 0 || status.state === 'offline' || status.state === 'unavailable' || status.state === 'auth_expired';
  return (
    <div className={warn ? 'sync-banner warn' : 'sync-banner'} role="status">
      {parts.join(' · ')}
    </div>
  );
}
