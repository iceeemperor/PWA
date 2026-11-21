import { useEffect, useState, type FormEvent } from 'react';
import { LocalWriteError, type Repo } from '../data/repo';
import type { RecordOf } from '../domain/types';
import type { SyncEngine } from '../sync/engine';

type Todo = RecordOf<'todos'>;

export interface TodosTempProps {
  repo: Repo;
  /** Sync runs write without Repo.onChange; their status events are how the list learns of pulled records. */
  engine?: Pick<SyncEngine, 'subscribe'>;
}

function messageFor(e: unknown): string {
  if (e instanceof LocalWriteError) return '保存失败：本机存储写入失败（可能空间不足），这次改动没有保存';
  return '操作失败，请重试';
}

/** A bare todo list to exercise the data layer end to end. Replaced by the real todo module in stage 2. */
export function TodosTemp({ repo, engine }: TodosTempProps) {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    let seq = 0;
    const reload = async () => {
      const mine = ++seq;
      const list = await repo.list('todos');
      if (!live || mine !== seq) return;
      setTodos(list.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)));
    };
    void reload();
    const offRepo = repo.onChange(() => void reload());
    const offEngine = engine?.subscribe(() => void reload());
    return () => {
      live = false;
      offRepo();
      offEngine?.();
    };
  }, [repo, engine]);

  async function attempt(fn: () => Promise<unknown>): Promise<boolean> {
    try {
      await fn();
      setError(null);
      return true;
    } catch (e) {
      setError(messageFor(e));
      return false;
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    if (await attempt(() => repo.create('todos', { title: t }))) setTitle('');
  }

  return (
    <section className="page">
      <p className="temp-label">临时界面，阶段 2 替换</p>
      <form className="todo-add" onSubmit={add}>
        <input placeholder="新待办" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="新待办" />
        <button type="submit" className="primary">
          添加
        </button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <ul className="todo-list">
        {todos.map((t) => (
          <li key={t.id} className={t.done ? 'done' : undefined}>
            <label>
              <input
                type="checkbox"
                checked={t.done}
                onChange={(e) => void attempt(() => repo.update('todos', t.id, { done: e.target.checked }))}
              />
              <span>{t.title}</span>
            </label>
            <button type="button" className="danger" onClick={() => void attempt(() => repo.remove('todos', t.id))}>
              删除
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
