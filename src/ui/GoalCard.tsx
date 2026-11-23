import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { RecordNotFoundError, type Repo } from '../data/repo';
import { newId as defaultNewId } from '../domain/ids';
import type { Step, TodoRecord } from '../domain/types';
import { useWriteAttempt, WriteError } from './write-error';

export interface GoalCardProps {
  goal: TodoRecord;
  repo: Pick<Repo, 'get' | 'update' | 'remove'>;
  newId?: () => string;
}

interface StepRowProps {
  step: Step;
  onTick: (done: boolean) => void;
  /** Resolves to whether the new text was saved. */
  onRename: (text: string) => Promise<boolean>;
  onDelete: () => void;
}

function StepRow({ step, onTick, onRename, onDelete }: StepRowProps) {
  const [text, setText] = useState(step.text);
  const [editing, setEditing] = useState(false);

  // Follow the stored text (another device, an undo) unless the user is typing in the field.
  useEffect(() => {
    if (!editing) setText(step.text);
  }, [step.text, editing]);

  async function commit() {
    if (text === step.text) {
      setEditing(false);
      return;
    }
    // A failed save leaves the typed text in the field.
    if (await onRename(text)) setEditing(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commit();
    } else if (e.key === 'Escape') {
      setText(step.text);
      setEditing(false);
    }
  }

  return (
    <li className={step.done ? 'step done' : 'step'}>
      <label className="hit">
        <input type="checkbox" aria-label={step.text} checked={step.done} onChange={(e) => onTick(e.target.checked)} />
      </label>
      <input
        className="step-text"
        aria-label="步骤内容"
        value={text}
        onFocus={() => setEditing(true)}
        onChange={(e) => {
          setEditing(true);
          setText(e.target.value);
        }}
        onBlur={() => void commit()}
        onKeyDown={onKeyDown}
      />
      <button type="button" className="danger small" aria-label={`删除步骤 ${step.text}`} onClick={onDelete}>
        删除
      </button>
    </li>
  );
}

/** One goal: its title and done mark, and its small steps. Every step edit writes the whole `steps` array. */
export function GoalCard({ goal, repo, newId = defaultNewId }: GoalCardProps) {
  const { error, attempt } = useWriteAttempt();
  const [draft, setDraft] = useState('');

  // Step writes run one at a time, and each applies its change by step id to the newest stored steps, not to the
  // rendered copy: a second quick action (or a pull) between render and re-read must not be overwritten.
  // The chain moves on after a failed link too (`.then(run, run)`), so one failure cannot block later writes.
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  function changeSteps(change: (steps: Step[]) => Step[]): Promise<boolean> {
    const run = () =>
      attempt(async () => {
        const fresh = await repo.get('todos', goal.id);
        if (!fresh) throw new RecordNotFoundError(`No todos record with id ${goal.id}`);
        await repo.update('todos', goal.id, { steps: change(fresh.steps) });
      });
    const next = chain.current.then(run, run);
    chain.current = next;
    return next;
  }
  const setStep = (id: string, patch: Partial<Step>) =>
    changeSteps((steps) => steps.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  async function addStep(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    const step: Step = { id: newId(), text, done: false };
    if (await changeSteps((steps) => [...steps, step])) setDraft('');
  }

  return (
    <article className={goal.done ? 'goal-card done' : 'goal-card'}>
      <header className="goal-head">
        <label className="hit">
          <input
            type="checkbox"
            aria-label={goal.title}
            checked={goal.done}
            onChange={(e) => void attempt(() => repo.update('todos', goal.id, { done: e.target.checked }))}
          />
        </label>
        <h3 className="goal-title">{goal.title}</h3>
        <button
          type="button"
          className="danger small"
          aria-label={`删除目标 ${goal.title}`}
          onClick={() => void attempt(() => repo.remove('todos', goal.id))}
        >
          删除
        </button>
      </header>
      {goal.note && <p className="item-note">{goal.note}</p>}
      {goal.steps.length > 0 && (
        <ul className="steps">
          {goal.steps.map((step) => (
            <StepRow
              key={step.id}
              step={step}
              onTick={(done) => void setStep(step.id, { done })}
              onRename={(text) => setStep(step.id, { text })}
              onDelete={() => void changeSteps((steps) => steps.filter((s) => s.id !== step.id))}
            />
          ))}
        </ul>
      )}
      <form className="step-add" onSubmit={addStep}>
        <input placeholder="新步骤" aria-label="新步骤" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <button type="submit">添加步骤</button>
      </form>
      <WriteError error={error} />
    </article>
  );
}
