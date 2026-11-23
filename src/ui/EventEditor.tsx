import { useEffect, useRef, useState, type FormEvent } from 'react';
import { InvalidRecordError, type Repo } from '../data/repo';
import { switchAllDay, validateEventFields } from '../data/validate-event-fields';
import { deviceTimeZone } from '../domain/time';
import type { EventFields, EventRecord } from '../domain/types';
import { useWriteAttempt, WriteError } from './write-error';
import { zoneLabel } from './zone-label';

export interface EventEditorProps {
  repo: Pick<Repo, 'create' | 'update' | 'remove'>;
  /** An existing event to edit, or the day (`YYYY-MM-DD`) of a new all-day event. */
  initial: EventRecord | { date: string };
  /** Called after a successful save or delete, and on 取消 or Escape. */
  onClose: () => void;
}

/** The Chinese words for the validation errors; anything not listed is 填写的内容有误. */
function validationMessage(e: unknown): string {
  if (e instanceof InvalidRecordError) {
    if (e.message.includes('ends_at must not be before starts_at')) return '结束不能早于开始';
    if (e.message.includes('title must not be blank')) return '请填写标题';
  }
  return '填写的内容有误';
}

const isExisting = (i: EventEditorProps['initial']): i is EventRecord => 'id' in i;

/** Splits a stored `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm` into its date and time parts. */
const parts = (v: string | null): { date: string; time: string } => (v === null ? { date: '', time: '' } : { date: v.slice(0, 10), time: v.slice(11, 16) });

/**
 * Edits or creates one calendar event, as a modal panel. Times are shown and edited exactly as stored: local time in
 * the event's own zone. Decision: an end time with no end date takes the start date; an end date with no end time
 * (timed event) is ignored, because a timed end needs a time. A failed check or write keeps the form as typed.
 */
export function EventEditor({ repo, initial, onClose }: EventEditorProps) {
  const existing = isExisting(initial) ? initial : null;
  const deviceTz = deviceTimeZone();
  const titleRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(existing?.title ?? '');
  const [note, setNote] = useState(existing?.note ?? '');
  const [important, setImportant] = useState(existing?.important ?? false);
  const [done, setDone] = useState(existing?.done ?? false);
  const [allDay, setAllDay] = useState(existing?.all_day ?? true);
  const [tz, setTz] = useState<string | null>(existing ? existing.tz : null);
  const start = parts(existing ? existing.starts_at : (initial as { date: string }).date);
  const end = parts(existing?.ends_at ?? null);
  const [startDate, setStartDate] = useState(start.date);
  const [startTime, setStartTime] = useState(start.time);
  const [endDate, setEndDate] = useState(end.date);
  const [endTime, setEndTime] = useState(end.time);
  const { error, setError, attempt } = useWriteAttempt();
  const [busy, setBusy] = useState(false);

  useEffect(() => titleRef.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** The event fields as the form stands now. */
  function fields(): EventFields {
    let ends: string | null;
    if (allDay) ends = endDate === '' ? null : endDate;
    else ends = endTime === '' ? null : `${endDate === '' ? startDate : endDate}T${endTime}`;
    return {
      title: title.trim(),
      all_day: allDay,
      starts_at: allDay ? startDate : `${startDate}T${startTime}`,
      ends_at: ends,
      tz: allDay ? null : tz,
      note,
      important,
      done,
      rrule: null,
    };
  }

  function toggleAllDay(to: boolean) {
    const t = switchAllDay(fields(), to, deviceTz);
    const s = parts(t.starts_at);
    const e = parts(t.ends_at);
    setAllDay(t.all_day);
    setTz(t.tz);
    setStartDate(s.date);
    setStartTime(s.time);
    setEndDate(e.date);
    setEndTime(e.time);
  }

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    const ok = await attempt(fn);
    setBusy(false);
    if (ok) onClose();
  }

  function save(ev: FormEvent) {
    ev.preventDefault();
    const f = fields();
    try {
      validateEventFields(f);
    } catch (e) {
      setError(validationMessage(e));
      return;
    }
    void run(() => (existing ? repo.update('events', existing.id, f) : repo.create('events', f)));
  }

  const foreignZone = !allDay && tz !== null && tz !== deviceTz;

  return (
    <div className="modal-backdrop">
      <form className="todo-editor event-editor" role="dialog" aria-modal="true" aria-label="编辑事项" onSubmit={save}>
        <label className="field">
          标题
          <input ref={titleRef} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="hit">
          <input type="checkbox" checked={allDay} onChange={(e) => toggleAllDay(e.target.checked)} />
          全天
        </label>
        {allDay ? (
          <div className="editor-row">
            <label className="field">
              日期
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </label>
            <label className="field">
              结束日期
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </label>
          </div>
        ) : (
          <>
            <div className="editor-row">
              <label className="field">
                开始日期
                <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </label>
              <label className="field">
                开始时间
                <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
              </label>
            </div>
            <div className="editor-row">
              <label className="field">
                结束日期
                <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </label>
              <label className="field">
                结束时间
                <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
              </label>
            </div>
            {foreignZone && (
              <p className="muted" data-testid="event-zone">
                时区：{zoneLabel(tz, `${startDate}T${startTime || '00:00'}`)}
              </p>
            )}
          </>
        )}
        <div className="editor-row">
          <label className="hit">
            <input type="checkbox" checked={important} onChange={(e) => setImportant(e.target.checked)} />
            重要
          </label>
          <label className="hit">
            <input type="checkbox" checked={done} onChange={(e) => setDone(e.target.checked)} />
            已完成
          </label>
        </div>
        <label className="field">
          备注
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <WriteError error={error} />
        <div className="editor-actions">
          <button type="submit" className="primary" disabled={busy}>
            保存
          </button>
          <button type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          {existing && (
            <button type="button" className="danger" disabled={busy} onClick={() => void run(() => repo.remove('events', existing.id))}>
              删除
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
