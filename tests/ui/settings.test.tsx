// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { Services } from '../../src/app/services';
import { buildMarkdownZip } from '../../src/backup/export-markdown';
import { saveFile } from '../../src/backup/save-file';
import { BACKUP_FORMAT, BACKUP_VERSION, type ImportSummary, type QueuedOp } from '../../src/domain/types';
import { CloudError } from '../../src/sync/cloud';
import type { SyncReport } from '../../src/sync/engine';
import { ExportReminder } from '../../src/ui/ExportReminder';
import { Settings } from '../../src/ui/Settings';
import { Shell } from '../../src/ui/Shell';
import { createTestServices, offlineCloud } from '../helpers/ui-services';

vi.mock('../../src/backup/save-file', () => ({ saveFile: vi.fn() }));
vi.mock('../../src/backup/export-markdown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/backup/export-markdown')>();
  return { ...actual, buildMarkdownZip: vi.fn(actual.buildMarkdownZip) };
});

const OK: SyncReport = { outcome: 'ok', pushed: 0, dropped: 0, failed: 0, pulled: 0, conflicts: 0 };
const id1 = '11111111-1111-4111-8111-111111111111';
const id2 = '22222222-2222-4222-8222-222222222222';

let services: Services;
let db: Services['db'];
let repo: Services['repo'];
let cloud: { importBackup: MockInstance<(p: unknown, r: boolean) => Promise<ImportSummary>> };
let engine: { sync: MockInstance<() => Promise<SyncReport>> };

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-11-05T00:00:00Z');
  const importFn = vi.fn<(p: unknown, r: boolean) => Promise<ImportSummary>>();
  services = await createTestServices({ cloud: { ...offlineCloud(), importBackup: importFn } });
  db = services.db;
  repo = services.repo;
  cloud = { importBackup: importFn };
  engine = { sync: vi.spyOn(services.engine, 'sync').mockResolvedValue(OK) };
  vi.mocked(saveFile).mockReset().mockResolvedValue('downloaded');
  vi.mocked(buildMarkdownZip).mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function clickText(text: string) {
  await userEvent.click(await screen.findByText(text));
}
async function choose(label: string) {
  await userEvent.click(await screen.findByLabelText(label));
}
async function pickFile(text: string) {
  const input = await screen.findByLabelText('选择备份文件');
  await userEvent.upload(input, new File([text], 'backup.json', { type: 'application/json' }));
}
function goodFile(): string {
  const now = '2026-11-01T00:00:00.000Z';
  return JSON.stringify({
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exported_at: now,
    tables: {
      todos: [
        { id: id1, kind: 'todo', title: 'milk', done: false, priority: 'normal', due_date: null, note: '', steps: [], created_at: now, updated_at: now, deleted_at: null },
      ],
    },
  });
}
function renderSettings() {
  return render(<Settings services={services} />);
}

describe('Settings (brief)', () => {
  beforeEach(() => {
    renderSettings();
  });

  it('export JSON syncs best-effort, saves the file with the dated name and records the export time', async () => {
    await clickText('导出完整备份');
    expect(engine.sync).toHaveBeenCalled();
    await waitFor(() => expect(saveFile).toHaveBeenCalledWith('productivity-app-backup-2026-11-05.json', expect.any(Blob)));
    await waitFor(async () => expect(await db.getMeta('last_export_at')).toBe('2026-11-05T00:00:00.000Z'));
  });

  it('export still works when the sync before it fails', async () => {
    engine.sync.mockRejectedValue(new Error('x'));
    await clickText('导出完整备份');
    await waitFor(() => expect(saveFile).toHaveBeenCalled());
  });

  it('Markdown export offers all or journal only', async () => {
    await choose('只导出日记');
    await clickText('导出 Markdown');
    await waitFor(() => expect(buildMarkdownZip).toHaveBeenCalledWith(expect.anything(), 'journal'));
  });

  it('the restore-purged checkbox is unchecked by default', () => {
    expect(screen.getByLabelText('同时找回已被永久清除的记录')).not.toBeChecked();
  });

  it('importing a bad file lists the errors and never calls the cloud', async () => {
    await pickFile('{"nope":1}');
    expect(await screen.findByText(/format/)).toBeInTheDocument();
    expect(cloud.importBackup).not.toHaveBeenCalled();
  });

  it('importing a good file shows the summary with added, restored and skipped counts', async () => {
    cloud.importBackup.mockResolvedValue({ added: 2, restored: 1, skipped: { exists: 3 } });
    await pickFile(goodFile());
    expect(await screen.findByText(/新增 2 条.*找回 1 条.*跳过 3 条/)).toBeInTheDocument();
  });
});

describe('Shell and failed ops (brief)', () => {
  it('the reminder shows after 7 days without export and disappears after exporting', async () => {
    await db.setMeta('last_export_at', '2026-10-28T00:00:00.000Z');
    render(<Shell services={services} />);
    expect(await screen.findByText(/已经 8 天没有导出备份/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '设置' }));
    await clickText('导出完整备份');
    await waitFor(() => expect(screen.queryByText(/天没有导出备份/)).not.toBeInTheDocument());
  });

  it('lists failed ops with their reason', async () => {
    const op: QueuedOp = { seq: 1, op_id: id1, table: 'todos', id: id2, kind: 'insert', base_rev: null, fields: {}, failed: { reason: 'title cannot be empty' } };
    vi.spyOn(repo, 'failedOps').mockResolvedValue([op]);
    renderSettings();
    expect(await screen.findByText(/title cannot be empty/)).toBeInTheDocument();
  });
});

describe('Settings: edges', () => {
  it('a never-exported reminder says so, and its link opens the settings page', async () => {
    render(<Shell services={services} />);
    expect(await screen.findByText(/还没有导出过备份/)).toBeInTheDocument();
    expect(screen.queryByText('导出完整备份')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '去导出' }));
    expect(await screen.findByText('导出完整备份')).toBeInTheDocument();
  });

  it('no reminder within 7 days of the last export', async () => {
    await db.setMeta('last_export_at', '2026-10-30T00:00:00.000Z');
    render(<ExportReminder services={services} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/备份/)).not.toBeInTheDocument();
  });

  it('does not record the export when saving the file fails, and says so', async () => {
    vi.mocked(saveFile).mockRejectedValue(new Error('disk full'));
    renderSettings();
    await clickText('导出完整备份');
    expect(await screen.findByText(/导出失败/)).toBeInTheDocument();
    expect(await db.getMeta('last_export_at')).toBeUndefined();
  });

  it('export tolerates a sync that resolves offline', async () => {
    engine.sync.mockResolvedValue({ ...OK, outcome: 'offline' });
    renderSettings();
    await clickText('导出完整备份');
    await waitFor(() => expect(saveFile).toHaveBeenCalled());
  });

  it('the JSON export is a full backup with the application/json type', async () => {
    await repo.create('todos', { title: 'milk' });
    renderSettings();
    await clickText('导出完整备份');
    await waitFor(() => expect(saveFile).toHaveBeenCalled());
    const blob = vi.mocked(saveFile).mock.calls[0][1];
    expect(blob.type).toBe('application/json');
    const parsed = JSON.parse(await blob.text());
    expect(parsed.format).toBe(BACKUP_FORMAT);
    expect(parsed.tables.todos.map((t: { title: string }) => t.title)).toEqual(['milk']);
  });

  it('Markdown export defaults to all, saves a dated zip and does not count as a backup', async () => {
    renderSettings();
    expect(screen.getByLabelText('全部')).toBeChecked();
    await clickText('导出 Markdown');
    await waitFor(() => expect(saveFile).toHaveBeenCalledWith('productivity-app-markdown-2026-11-05.zip', expect.any(Blob)));
    expect(buildMarkdownZip).toHaveBeenCalledWith({ notes: [], journal: [] }, 'all');
    expect(vi.mocked(saveFile).mock.calls[0][1].type).toBe('application/zip');
    expect(await db.getMeta('last_export_at')).toBeUndefined();
  });

  it('passes the restore-purged choice, groups skips by reason and syncs after importing', async () => {
    cloud.importBackup.mockResolvedValue({ added: 0, restored: 0, skipped: { exists: 3, purged: 1 } });
    renderSettings();
    await choose('同时找回已被永久清除的记录');
    await pickFile(goodFile());
    expect(await screen.findByText(/新增 0 条，找回 0 条，跳过 4 条/)).toBeInTheDocument();
    expect(screen.getByText(/已存在 3 条/)).toBeInTheDocument();
    expect(screen.getByText(/已被永久清除 1 条/)).toBeInTheDocument();
    expect(cloud.importBackup).toHaveBeenCalledWith(expect.anything(), true);
    await waitFor(() => expect(engine.sync).toHaveBeenCalled());
  });

  it('an import that throws shows a readable message instead of crashing', async () => {
    cloud.importBackup.mockRejectedValue(new CloudError('network'));
    renderSettings();
    await pickFile(goodFile());
    expect(await screen.findByText('导入失败：网络连接失败')).toBeInTheDocument();
    expect(screen.getByText('导出完整备份')).toBeInTheDocument();
  });

  it('an unexpected import error is shown too', async () => {
    cloud.importBackup.mockRejectedValue(new Error('boom'));
    renderSettings();
    await pickFile(goodFile());
    expect(await screen.findByText(/导入失败/)).toBeInTheDocument();
  });

  it('disables the controls while an import is running', async () => {
    let finish!: (s: ImportSummary) => void;
    cloud.importBackup.mockReturnValue(new Promise((r) => (finish = r)));
    renderSettings();
    await pickFile(goodFile());
    await waitFor(() => expect(screen.getByLabelText('选择备份文件')).toBeDisabled());
    expect(screen.getByRole('button', { name: '导出完整备份' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '导出 Markdown' })).toBeDisabled();
    expect(screen.getByLabelText('同时找回已被永久清除的记录')).toBeDisabled();
    finish({ added: 1, restored: 0, skipped: {} });
    await waitFor(() => expect(screen.getByLabelText('选择备份文件')).toBeEnabled());
  });

  it('failed ops show table and kind, and the list refreshes on repo changes', async () => {
    const spy = vi.spyOn(repo, 'failedOps').mockResolvedValue([]);
    renderSettings();
    expect(await screen.findByText('没有同步失败的改动')).toBeInTheDocument();
    spy.mockResolvedValue([
      { seq: 1, op_id: id1, table: 'todos', id: id2, kind: 'update', base_rev: 3, fields: {}, failed: { reason: 'bad priority' } },
    ]);
    await repo.create('todos', { title: 'trigger' });
    expect(await screen.findByText(/bad priority/)).toBeInTheDocument();
    expect(screen.getByText(/待办 · 修改/)).toBeInTheDocument();
  });
});
