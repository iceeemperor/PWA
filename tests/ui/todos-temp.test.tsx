// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LocalWriteError } from '../../src/data/repo';
import type { CloudClient } from '../../src/sync/cloud';
import { TodosTemp } from '../../src/ui/TodosTemp';
import { FAKE_USER_ID } from '../helpers/fake-auth';
import { createTestServices, offlineCloud } from '../helpers/ui-services';
import type { Services } from '../../src/app/services';

let repo: Services['repo'];

beforeEach(async () => {
  repo = (await createTestServices()).repo;
});
afterEach(() => {
  vi.restoreAllMocks();
});

it('the temporary todo screen adds, toggles and deletes through the repo', async () => {
  render(<TodosTemp repo={repo} />);
  await userEvent.type(screen.getByPlaceholderText('新待办'), 'milk{enter}');
  expect(await screen.findByText('milk')).toBeInTheDocument();
  expect((await repo.list('todos')).map((t) => t.title)).toEqual(['milk']);
  await userEvent.click(screen.getByRole('checkbox'));
  expect((await repo.list('todos'))[0].done).toBe(true);
  await userEvent.click(screen.getByRole('button', { name: '删除' }));
  expect(await repo.list('todos')).toHaveLength(0);
});

it('shows 保存失败 when a local write fails', async () => {
  vi.spyOn(repo, 'create').mockRejectedValue(new LocalWriteError('full'));
  render(<TodosTemp repo={repo} />);
  await userEvent.type(screen.getByPlaceholderText('新待办'), 'milk{enter}');
  expect(await screen.findByText(/保存失败/)).toBeInTheDocument();
});

it('is labelled as a temporary screen', () => {
  render(<TodosTemp repo={repo} />);
  expect(screen.getByText(/临时界面，阶段 2 替换/)).toBeInTheDocument();
});

it('re-reads the list after a sync run brings in a record from another device', async () => {
  const ts = new Date().toISOString();
  let served = false;
  const cloud: CloudClient = {
    ...offlineCloud(),
    pull: async () => {
      if (served) return { rows: [], has_more: false };
      served = true;
      return {
        rows: [
          {
            table: 'todos',
            row: {
              id: '11111111-1111-4111-8111-111111111111',
              user_id: FAKE_USER_ID,
              kind: 'todo',
              title: 'from phone',
              done: false,
              priority: 'normal',
              due_date: null,
              note: '',
              steps: [],
              created_at: ts,
              updated_at: ts,
              rev: 1,
              deleted_at: null,
              purged_at: null,
            },
          },
        ],
        has_more: false,
      };
    },
  };
  const s = await createTestServices({ cloud });
  render(<TodosTemp repo={s.repo} engine={s.engine} />);
  await screen.findByPlaceholderText('新待办');
  expect(screen.queryByText('from phone')).toBeNull();
  expect(await s.engine.sync()).toMatchObject({ outcome: 'ok', pulled: 1 });
  expect(await screen.findByText('from phone')).toBeInTheDocument();
});
