import { useState } from 'react';
import type { Services } from '../app/services';
import { PurgedRecordError } from '../data/repo';
import type { TableName } from '../domain/types';
import { useLiveRecords } from './useLiveRecords';
import { writeErrorMessage } from './write-error';

const DAY_MS = 86_400_000;
const KEEP_DAYS = 30;

/** Whole days the record stays in the trash: exactly 30 on the day of deletion, never below 0. */
export function daysUntilPurge(deletedAt: string, now: Date): number {
  const elapsed = Math.floor((now.getTime() - new Date(deletedAt).getTime()) / DAY_MS);
  return Math.max(0, KEEP_DAYS - elapsed);
}

/** M月D日 in the device zone. */
function dateText(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

interface Row {
  id: string;
  title: string;
  deletedAt: string;
  goal: boolean;
}

function byNewest(a: Row, b: Row): number {
  return a.deletedAt < b.deletedAt ? 1 : a.deletedAt > b.deletedAt ? -1 : 0;
}

export function TrashSection({ services }: { services: Services }) {
  const { repo, engine } = services;
  const todos = useLiveRecords(repo, engine, 'todos', { trashed: true });
  const events = useLiveRecords(repo, engine, 'events', { trashed: true });
  const [error, setError] = useState<string | null>(null);
  const now = new Date();

  const toRow = (r: { id: string; title: string; deleted_at: string | null }, goal: boolean): Row => ({
    id: r.id,
    title: r.title,
    deletedAt: r.deleted_at ?? '',
    goal,
  });
  const todoRows = todos.map((r) => toRow(r, r.kind === 'goal')).sort(byNewest);
  const eventRows = events.map((r) => toRow(r, false)).sort(byNewest);

  async function restore(t: TableName, id: string) {
    try {
      await repo.restore(t, id);
      setError(null);
    } catch (e) {
      console.error('Restore failed', e);
      setError(e instanceof PurgedRecordError ? '已被永久清除' : writeErrorMessage(e));
    }
  }

  return (
    <div className="card trash">
      <h3>回收站</h3>
      <p className="muted">删除的内容在这里保留 30 天，之后永久清除</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {todoRows.length === 0 && eventRows.length === 0 ? (
        <p className="muted">回收站是空的</p>
      ) : (
        <>
          <TrashGroup label="待办" t="todos" rows={todoRows} now={now} onRestore={restore} />
          <TrashGroup label="日历" t="events" rows={eventRows} now={now} onRestore={restore} />
        </>
      )}
    </div>
  );
}

function TrashGroup({
  label,
  t,
  rows,
  now,
  onRestore,
}: {
  label: string;
  t: TableName;
  rows: Row[];
  now: Date;
  onRestore: (t: TableName, id: string) => Promise<void>;
}) {
  if (rows.length === 0) return null;
  return (
    <section>
      <h4>{label}</h4>
      <ul className="trash-list">
        {rows.map((r) => {
          const left = daysUntilPurge(r.deletedAt, now);
          return (
            <li key={r.id}>
              <div className="trash-main">
                <span data-testid={`trash-${t === 'todos' ? 'todo' : 'event'}-title`}>{r.title || '无标题'}</span>
                {r.goal && <span className="tag">目标</span>}
                <span className="muted">{dateText(r.deletedAt)}</span>
                <span className="muted">{left === 0 ? '即将清除' : `还剩 ${left} 天`}</span>
              </div>
              <button type="button" className="restore" onClick={() => void onRestore(t, r.id)}>
                恢复
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
