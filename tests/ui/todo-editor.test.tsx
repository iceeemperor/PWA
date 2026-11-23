// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Services } from '../../src/app/services';
import { TodoEditor } from '../../src/ui/TodoEditor';
import { createTestServices } from '../helpers/ui-services';

let repo: Services['repo'];
let close: ReturnType<typeof vi.fn<() => void>>;

beforeEach(async () => {
  repo = (await createTestServices()).repo;
  close = vi.fn<() => void>();
});
afterEach(() => vi.restoreAllMocks());

it('saving only a title change keeps priority changed underneath', async () => {
  const t = await repo.create('todos', { title: 'a' });
  render(<TodoEditor todo={t} repo={repo} onClose={close} />);
  await repo.update('todos', t.id, { priority: 'high' });
  const input = screen.getByLabelText('标题');
  await userEvent.clear(input);
  await userEvent.type(input, 'b');
  await userEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(await repo.list('todos')).toMatchObject([{ title: 'b', priority: 'high' }]);
});

it('saving with no change writes nothing', async () => {
  const t = await repo.create('todos', { title: 'a' });
  const spy = vi.spyOn(repo, 'update');
  render(<TodoEditor todo={t} repo={repo} onClose={close} />);
  await userEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(spy).not.toHaveBeenCalled();
});

it('two quick deletes remove once', async () => {
  const t = await repo.create('todos', { title: 'a' });
  const spy = vi.spyOn(repo, 'remove');
  render(<TodoEditor todo={t} repo={repo} onClose={close} />);
  const b = screen.getByRole('button', { name: '删除' });
  fireEvent.click(b);
  fireEvent.click(b);
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(spy).toHaveBeenCalledTimes(1);
});
