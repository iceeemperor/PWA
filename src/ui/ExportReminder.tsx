import { useEffect, useState } from 'react';
import type { Services } from '../app/services';
import { shouldRemindExport } from '../backup/reminder';

const DAY_MS = 24 * 60 * 60 * 1000;

// Settings and the reminder are separate parts of the shell; a recorded export tells every mounted reminder to re-read.
const exportListeners = new Set<() => void>();

/** Call after recordExport so a showing reminder disappears without a reload. */
export function notifyExportRecorded(): void {
  for (const fn of [...exportListeners]) fn();
}

export interface ExportReminderProps {
  services: Pick<Services, 'db'>;
  /** Opens the settings page. Without it the reminder is text only. */
  onOpenSettings?: () => void;
}

/**
 * Spec 7.1: more than 7 days since the last full backup (or none yet) shows a reminder on top of every page.
 * Checked on mount, after an export, and whenever the app returns to the foreground.
 */
export function ExportReminder({ services, onOpenSettings }: ExportReminderProps) {
  const { db } = services;
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    let seq = 0;
    const check = async () => {
      const mine = ++seq;
      let last: string | null = null;
      try {
        const v = await db.getMeta<string>('last_export_at');
        last = typeof v === 'string' ? v : null;
      } catch {
        // Unreadable meta reads as never exported.
      }
      if (!live || mine !== seq) return;
      const now = new Date();
      if (!shouldRemindExport(last, now)) return setText(null);
      const at = last === null ? NaN : Date.parse(last);
      setText(Number.isNaN(at) ? '还没有导出过备份' : `已经 ${Math.floor((now.getTime() - at) / DAY_MS)} 天没有导出备份`);
    };
    void check();
    exportListeners.add(check);
    // An installed app can sit in the background for days: coming back is when the 7 days may have passed.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      exportListeners.delete(check);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [db]);

  if (text === null) return null;
  return (
    <div className="notice export-reminder" role="note">
      <span>{text}</span>
      {onOpenSettings && (
        <button type="button" className="link" onClick={onOpenSettings}>
          去导出
        </button>
      )}
    </div>
  );
}
