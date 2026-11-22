import { useEffect, useState, type ChangeEvent } from 'react';
import type { Services } from '../app/services';
import { buildBackup } from '../backup/export-json';
import { buildMarkdownZip } from '../backup/export-markdown';
import { importBackup } from '../backup/import';
import { recordExport } from '../backup/reminder';
import { saveFile } from '../backup/save-file';
import type { ImportSummary, OpKind, QueuedOp, TableName } from '../domain/types';
import { CloudError, type CloudErrorKind } from '../sync/cloud';
import { notifyExportRecorded } from './ExportReminder';

type Scope = 'all' | 'journal';
type Busy = null | 'json' | 'markdown' | 'import';
type ImportView = { kind: 'summary'; summary: ImportSummary } | { kind: 'invalid'; errors: string[] } | { kind: 'error'; message: string };

const TABLE_TEXT: Record<TableName, string> = { todos: '待办' };
const KIND_TEXT: Record<OpKind, string> = { insert: '新增', update: '修改', delete: '删除', restore: '还原' };
const SKIP_TEXT: Record<string, string> = { exists: '已存在', purged: '已被永久清除' };
const CLOUD_ERROR_TEXT: Record<CloudErrorKind, string> = {
  network: '网络连接失败',
  auth: '登录已过期，请重新登录',
  unavailable: '云端暂时无法连接',
  rejected: '云端拒绝了这次导入',
};

/** The UTC date, as in the export file names. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function importErrorText(e: unknown): string {
  if (e instanceof CloudError) return `导入失败：${CLOUD_ERROR_TEXT[e.kind]}`;
  return '导入失败：发生未知错误，请稍后再试';
}

/** Runs a sync and ignores how it went: exporting and importing must not depend on the cloud being reachable. */
async function syncBestEffort(engine: Services['engine']): Promise<void> {
  try {
    await engine.sync();
  } catch {
    // Offline or failing: the local data is still what gets exported.
  }
}

/**
 * How long the export click waits for its sync. navigator.share needs the click's transient user activation, which
 * WebKit lets expire quickly; a slow or hanging sync must not use it up. Settings also syncs on mount, so the click
 * usually finds the data fresh already.
 */
export const PRE_EXPORT_SYNC_MS = 1500;

/** syncBestEffort, but gives up waiting after `ms`. The timer is cleared when the sync settles first. */
async function syncBounded(engine: Services['engine'], ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([syncBestEffort(engine), new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

export interface SettingsProps {
  services: Services;
}

export function Settings({ services }: SettingsProps) {
  const { db, repo, cloud, engine } = services;
  const [busy, setBusy] = useState<Busy>(null);
  const [scope, setScope] = useState<Scope>('all');
  const [restorePurged, setRestorePurged] = useState(false);
  const [exportMsg, setExportMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [importView, setImportView] = useState<ImportView | null>(null);
  const [failed, setFailed] = useState<QueuedOp[]>([]);
  const [failedLoaded, setFailedLoaded] = useState(false);

  // Freshen the local data while the user reads the page, so the export click has little left to wait for.
  useEffect(() => {
    void syncBestEffort(engine);
  }, [engine]);

  useEffect(() => {
    let live = true;
    let seq = 0;
    const reload = async () => {
      const mine = ++seq;
      try {
        const ops = await repo.failedOps();
        if (!live || mine !== seq) return;
        setFailed(ops);
        setFailedLoaded(true);
      } catch {
        // Keep the last list.
      }
    };
    void reload();
    const offRepo = repo.onChange(() => void reload());
    const offEngine = engine.subscribe(() => void reload());
    return () => {
      live = false;
      offRepo();
      offEngine();
    };
  }, [repo, engine]);

  async function exportJson() {
    setBusy('json');
    setExportMsg(null);
    try {
      // Best effort first, so the backup includes what other devices pushed (spec 7.1 exports the local database),
      // but bounded so the share sheet still gets the click's user activation.
      await syncBounded(engine, PRE_EXPORT_SYNC_MS);
      const backup = await buildBackup(db);
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const how = await saveFile(`productivity-app-backup-${today()}.json`, blob);
      // Only a file that was handed to the user counts as an export.
      await recordExport(db);
      notifyExportRecorded();
      setExportMsg({ ok: true, text: how === 'shared' ? '备份已交给系统分享面板' : '备份文件已开始下载' });
    } catch {
      setExportMsg({ ok: false, text: '导出失败，请重试' });
    } finally {
      setBusy(null);
    }
  }

  async function exportMarkdown() {
    setBusy('markdown');
    setExportMsg(null);
    try {
      // Stage 1 has no notes or journal tables yet.
      const zip = buildMarkdownZip({ notes: [], journal: [] }, scope);
      const blob = new Blob([zip as BlobPart], { type: 'application/zip' });
      await saveFile(`productivity-app-markdown-${today()}.zip`, blob);
      // Not recorded as an export: only the full JSON backup can be imported back (spec 7.1).
      setExportMsg({ ok: true, text: 'Markdown 压缩包已导出' });
    } catch {
      setExportMsg({ ok: false, text: '导出失败，请重试' });
    } finally {
      setBusy(null);
    }
  }

  async function onPick(e: ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setBusy('import');
    setImportView(null);
    try {
      const text = await file.text();
      const result = await importBackup(cloud, text, { restorePurged });
      if (!result.ok) {
        setImportView({ kind: 'invalid', errors: result.errors });
      } else {
        setImportView({ kind: 'summary', summary: result.summary });
        // Pull the imported rows down so they show on this device.
        await syncBestEffort(engine);
      }
    } catch (err) {
      setImportView({ kind: 'error', message: importErrorText(err) });
    } finally {
      // Picking the same file again must fire another change.
      input.value = '';
      setBusy(null);
    }
  }

  const disabled = busy !== null;

  return (
    <section className="page settings">
      <h2>设置</h2>

      <div className="card">
        <h3>导出</h3>
        <p className="muted">完整备份包含回收站里的记录，可用于恢复。</p>
        <button type="button" className="primary" disabled={disabled} onClick={() => void exportJson()}>
          导出完整备份
        </button>

        <fieldset className="scope" disabled={disabled}>
          <legend>Markdown 范围（只用于阅读，不能导入）</legend>
          <label>
            <input type="radio" name="md-scope" value="all" checked={scope === 'all'} onChange={() => setScope('all')} />
            全部
          </label>
          <label>
            <input type="radio" name="md-scope" value="journal" checked={scope === 'journal'} onChange={() => setScope('journal')} />
            只导出日记
          </label>
        </fieldset>
        <button type="button" disabled={disabled} onClick={() => void exportMarkdown()}>
          导出 Markdown
        </button>
        {exportMsg && (
          <p className={exportMsg.ok ? 'muted' : 'error'} role={exportMsg.ok ? 'status' : 'alert'}>
            {exportMsg.text}
          </p>
        )}
      </div>

      <div className="card">
        <h3>导入备份</h3>
        <p className="muted">导入是恢复：云端已有的记录不会被覆盖。</p>
        <label className="check">
          <input type="checkbox" checked={restorePurged} disabled={disabled} onChange={(e) => setRestorePurged(e.target.checked)} />
          同时找回已被永久清除的记录
        </label>
        <label className="field">
          选择备份文件
          <input type="file" accept="application/json,.json" disabled={disabled} onChange={(e) => void onPick(e)} />
        </label>
        {busy === 'import' && <p className="muted">正在导入…</p>}
        {importView && <ImportResultView view={importView} />}
      </div>

      <div className="card">
        <h3>同步失败</h3>
        {failedLoaded && failed.length === 0 ? (
          <p className="muted">没有同步失败的改动</p>
        ) : (
          <ul className="failed-list">
            {failed.map((op) => (
              <li key={op.seq}>
                <span className="muted">
                  {`${TABLE_TEXT[op.table] ?? op.table} · ${KIND_TEXT[op.kind] ?? op.kind}`}
                </span>
                <span>{op.failed?.reason}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function ImportResultView({ view }: { view: ImportView }) {
  if (view.kind === 'error') {
    return (
      <p className="error" role="alert">
        {view.message}
      </p>
    );
  }
  if (view.kind === 'invalid') {
    return (
      <div role="alert">
        <p className="error">文件没有通过校验，没有导入任何数据：</p>
        <ul className="error-list">
          {view.errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      </div>
    );
  }
  const { added, restored, skipped } = view.summary;
  const reasons = Object.entries(skipped).filter(([, n]) => n > 0);
  const skippedTotal = reasons.reduce((sum, [, n]) => sum + n, 0);
  return (
    <div role="status">
      <p>
        {`导入完成：新增 ${added} 条，找回 ${restored} 条，跳过 ${skippedTotal} 条`}
      </p>
      {reasons.length > 0 && (
        <ul className="skip-list">
          {reasons.map(([reason, n]) => (
            <li key={reason}>
              {`${SKIP_TEXT[reason] ?? reason} ${n} 条`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
