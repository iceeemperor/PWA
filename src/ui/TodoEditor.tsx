import { useRef, useState, type FormEvent } from 'react';
import type { Repo } from '../data/repo';
import type { TodoRecord } from '../domain/types';
import { changedFields } from './changed-fields';
import { useWriteAttempt, WriteError } from './write-error';

type Priority = TodoRecord['priority'];

export const PRIORITY_LABELS: Record<Priority, string> = { high: '高', normal: '普通', low: '低' };
export const PRIORITIES: Priority[] = ['high', 'normal', 'low'];

export interface TodoEditorProps {
  todo: TodoRecord;
  repo: Pick<Repo, 'update' | 'remove'>;
  /** Called after a successful save or delete, and on 取消. */
  onClose: () => void;
}

/**
 * Edits one todo in place. The note is plain text here; Markdown rendering arrives in stage 4. A failed write keeps
 * the editor open with everything the user typed.
 */
export function TodoEditor({ todo, repo, onClose }: TodoEditorProps) {
  const [title, setTitle] = useState(todo.title);
  const [note, setNote] = useState(todo.note);
  const [priority, setPriority] = useState<Priority>(todo.priority);
  const [date, setDate] = useState(todo.due_date ?? '');
  const { error, setError, attempt } = useWriteAttempt();
  const [busy, setBusy] = useState(false);

  const inFlight = useRef(false);
  const before = useRef(todo);

  async function run(fn: () => Promise<unknown>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const ok = await attempt(fn);
    setBusy(false);
    inFlight.current = false;
    if (ok) onClose();
  }

  function save(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    const t = title.trim();
    if (!t) {
      setError('标题不能为空');
      return;
    }
    const b = before.current;
    const patch = changedFields(
      { title: b.title, note: b.note, priority: b.priority, due_date: b.due_date },
      { title: t, note, priority, due_date: date === '' ? null : date },
    );
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    void run(() => repo.update('todos', todo.id, patch));
  }

  return (
    <form className="todo-editor" aria-label="编辑待办" onSubmit={save}>
      <label className="field">
        标题
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="field">
        备注
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="editor-row">
        <label className="field">
          优先级
          <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          日期
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>
      <WriteError error={error} />
      <div className="editor-actions">
        <button type="submit" className="primary" disabled={busy}>
          保存
        </button>
        <button type="button" onClick={onClose} disabled={busy}>
          取消
        </button>
        <button type="button" className="danger" disabled={busy} onClick={() => void run(() => repo.remove('todos', todo.id))}>
          删除
        </button>
      </div>
    </form>
  );
}
