// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Services } from '../../src/app/services';
import { LocalWriteError } from '../../src/data/repo';
import { deviceTimeZone } from '../../src/domain/time';
import type { TodoRecord } from '../../src/domain/types';
import type { CloudClient } from '../../src/sync/cloud';
import { TodosPage } from '../../src/ui/TodosPage';
import { FAKE_USER_ID } from '../helpers/fake-auth';
import { createTestServices, offlineCloud } from '../helpers/ui-services';
import { saveCache, setCity } from '../../src/weather/store';

// 2026-11-23 12:00 in Asia/Shanghai (the device zone fixed in vitest.config.ts).
const NOW = '2026-11-23T04:00:00Z';

let s: Services;
let onOpenDay: ReturnType<typeof vi.fn<(date: string) => void>>;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  s = await createTestServices();
  onOpenDay = vi.fn<(date: string) => void>();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const renderPage = () => render(<TodosPage services={s} onOpenDay={onOpenDay} />);

/** The list row (li) that shows `title`. */
async function rowOf(title: string): Promise<HTMLElement> {
  const el = await screen.findByText(title);
  const li = el.closest('li');
  if (!li) throw new Error(`no row for ${title}`);
  return li as HTMLElement;
}

it('runs in the fixed device zone', () => {
  expect(deviceTimeZone()).toBe('Asia/Shanghai');
});

it('has two tabs: 近期 and 目标', async () => {
  renderPage();
  expect(screen.getByRole('tablist')).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: '近期' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tab', { name: '目标' })).toHaveAttribute('aria-selected', 'false');
  await userEvent.click(screen.getByRole('tab', { name: '目标' }));
  expect(screen.getByRole('tab', { name: '目标' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByPlaceholderText('新目标')).toBeInTheDocument();
});

it('adds a todo with title, priority and date from the quick form', async () => {
  renderPage();
  await userEvent.type(screen.getByPlaceholderText('新待办'), '买牛奶');
  await userEvent.selectOptions(screen.getByLabelText('优先级'), 'high');
  await userEvent.type(screen.getByLabelText('日期'), '2026-11-25');
  await userEvent.click(screen.getByRole('button', { name: '添加' }));
  expect(await s.repo.list('todos')).toMatchObject([{ title: '买牛奶', priority: 'high', due_date: '2026-11-25', kind: 'todo' }]);
  expect(await screen.findByText('买牛奶')).toBeInTheDocument();
  expect(screen.getByPlaceholderText('新待办')).toHaveValue('');
});

it('the quick form defaults to 普通 with no date, and Enter adds', async () => {
  renderPage();
  expect(screen.getByLabelText('优先级')).toHaveValue('normal');
  await userEvent.type(screen.getByPlaceholderText('新待办'), '倒垃圾{enter}');
  await waitFor(async () => expect(await s.repo.list('todos')).toMatchObject([{ title: '倒垃圾', priority: 'normal', due_date: null }]));
});

it('a blank title adds nothing', async () => {
  renderPage();
  await userEvent.type(screen.getByPlaceholderText('新待办'), '   {enter}');
  expect(await s.repo.list('todos')).toEqual([]);
});

it('shows one line when there is nothing upcoming', async () => {
  renderPage();
  expect(await screen.findByText('近期没有待办')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: '高' })).toBeNull();
});

it('shows the groups 高 普通 低 and marks overdue items', async () => {
  await s.repo.create('todos', { title: '交报告', priority: 'high', due_date: '2026-11-20' });
  await s.repo.create('todos', { title: '买菜', priority: 'normal', due_date: '2026-11-23' });
  await s.repo.create('todos', { title: '整理书架', priority: 'low' });
  renderPage();
  expect(await screen.findByRole('heading', { name: '高' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '普通' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '低' })).toBeInTheDocument();
  const overdue = await rowOf('交报告');
  expect(within(overdue).getByText('已过期')).toBeInTheDocument();
  expect(within(overdue).getByText('11月20日')).toBeInTheDocument();
  const today = await rowOf('买菜');
  expect(within(today).queryByText('已过期')).toBeNull();
  expect(within(today).getByText('今天')).toBeInTheDocument();
});

it('hides an empty group heading', async () => {
  await s.repo.create('todos', { title: '买菜' });
  renderPage();
  expect(await screen.findByRole('heading', { name: '普通' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: '高' })).toBeNull();
  expect(screen.queryByRole('heading', { name: '低' })).toBeNull();
  expect(screen.queryByText('近期没有待办')).toBeNull();
});

it('labels dates 今天, 明天, M月D日 and adds the time of a timed event', async () => {
  await s.repo.create('todos', { title: '明天的事', due_date: '2026-11-24' });
  await s.repo.create('events', { title: '开会', all_day: false, starts_at: '2026-11-26T09:30', tz: 'Asia/Shanghai', important: true });
  // 2026-11-23 23:00 in New York is 2026-11-24 12:00 in Shanghai.
  await s.repo.create('events', { title: '越洋电话', all_day: false, starts_at: '2026-11-23T23:00', tz: 'America/New_York', important: true });
  renderPage();
  expect(within(await rowOf('明天的事')).getByText('明天')).toBeInTheDocument();
  expect(within(await rowOf('开会')).getByText('11月26日 09:30')).toBeInTheDocument();
  expect(within(await rowOf('越洋电话')).getByText('明天 12:00')).toBeInTheDocument();
});

it('the sort button switches to 按日期 and the choice survives a remount', async () => {
  await s.repo.create('todos', { title: '甲', priority: 'high' });
  await s.repo.create('todos', { title: '乙', priority: 'low' });
  const first = renderPage();
  expect(await screen.findByRole('heading', { name: '高' })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /按优先级/ }));
  expect(await screen.findByRole('button', { name: /按日期/ })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: '高' })).toBeNull();
  expect(screen.getByText('甲')).toBeInTheDocument();
  expect(screen.getByText('乙')).toBeInTheDocument();
  await waitFor(async () => expect(await s.db.getMeta('agenda_sort')).toBe('date'));
  first.unmount();
  renderPage();
  expect(await screen.findByRole('button', { name: /按日期/ })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: '高' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: /按日期/ }));
  expect(await screen.findByRole('heading', { name: '高' })).toBeInTheDocument();
  await waitFor(async () => expect(await s.db.getMeta('agenda_sort')).toBe('priority'));
});

it('an unknown stored sort choice falls back to 按优先级', async () => {
  await s.db.setMeta('agenda_sort', 'bogus');
  renderPage();
  expect(await screen.findByRole('button', { name: /按优先级/ })).toBeInTheDocument();
});

it('ticking a todo writes todos.done; ticking a calendar item writes events.done', async () => {
  const todo = await s.repo.create('todos', { title: '买菜' });
  const event = await s.repo.create('events', { title: '体检', starts_at: '2026-11-24', important: true });
  renderPage();
  await userEvent.click(await screen.findByRole('checkbox', { name: '买菜' }));
  await waitFor(async () => expect((await s.repo.get('todos', todo.id))?.done).toBe(true));
  await userEvent.click(screen.getByRole('checkbox', { name: '体检' }));
  await waitFor(async () => expect((await s.repo.get('events', event.id))?.done).toBe(true));
  // Done items leave the upcoming list.
  await waitFor(() => expect(screen.queryByRole('checkbox', { name: '买菜' })).toBeNull());
});

it('a calendar item shows the calendar mark and opens its day', async () => {
  await s.repo.create('events', { title: '体检', starts_at: '2026-11-24', important: true });
  await s.repo.create('events', { title: '不重要的事', starts_at: '2026-11-24' });
  await s.repo.create('todos', { title: '买菜' });
  renderPage();
  const row = await rowOf('体检');
  await userEvent.click(within(row).getByRole('button', { name: /日历/ }));
  expect(onOpenDay).toHaveBeenCalledWith('2026-11-24');
  expect(within(await rowOf('买菜')).queryByRole('button', { name: /日历/ })).toBeNull();
  expect(screen.queryByText('不重要的事')).toBeNull();
});

it('显示已完成 shows completed items newest first', async () => {
  await s.repo.create('todos', { title: '旧的', due_date: '2026-11-10', done: true });
  await s.repo.create('todos', { title: '新的', due_date: '2026-11-22', done: true });
  await s.repo.create('events', { title: '看过的展', starts_at: '2026-11-15', important: true, done: true });
  await s.repo.create('todos', { title: '没做完' });
  renderPage();
  await screen.findByText('没做完');
  expect(screen.queryByText('新的')).toBeNull();
  await userEvent.click(screen.getByRole('checkbox', { name: '显示已完成' }));
  const section = await screen.findByRole('region', { name: '已完成' });
  const titles = within(section).getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'));
  expect(titles).toEqual(['新的', '看过的展', '旧的']);
  expect(within(section).getByRole('checkbox', { name: '新的' })).toBeChecked();
  // Unticking a completed one brings it back.
  await userEvent.click(within(section).getByRole('checkbox', { name: '新的' }));
  await waitFor(async () => expect((await s.repo.list('todos')).find((t) => t.title === '新的')?.done).toBe(false));
});

it('editing a todo changes title, note, priority and date; 删除 moves it to the trash', async () => {
  const todo = await s.repo.create('todos', { title: '买菜' });
  renderPage();
  await userEvent.click(await screen.findByRole('button', { name: '买菜' }));
  const editor = screen.getByRole('form', { name: '编辑待办' });
  const title = within(editor).getByLabelText('标题');
  await userEvent.clear(title);
  await userEvent.type(title, '买菜和水果');
  await userEvent.type(within(editor).getByLabelText('备注'), '**超市** <b>x</b>');
  await userEvent.selectOptions(within(editor).getByLabelText('优先级'), 'low');
  await userEvent.type(within(editor).getByLabelText('日期'), '2026-11-30');
  await userEvent.click(within(editor).getByRole('button', { name: '保存' }));
  await waitFor(async () =>
    expect(await s.repo.get('todos', todo.id)).toMatchObject({ title: '买菜和水果', note: '**超市** <b>x</b>', priority: 'low', due_date: '2026-11-30' }),
  );
  expect(screen.queryByRole('form', { name: '编辑待办' })).toBeNull();
  // The note is shown as plain text, not rendered.
  expect(await screen.findByText('**超市** <b>x</b>')).toBeInTheDocument();
  expect(document.querySelector('.todos-page b')).toBeNull();

  await userEvent.click(screen.getByRole('button', { name: '买菜和水果' }));
  await userEvent.click(within(screen.getByRole('form', { name: '编辑待办' })).getByRole('button', { name: '删除' }));
  await waitFor(async () => expect((await s.repo.list('todos', { trashed: true })).map((t) => t.id)).toEqual([todo.id]));
  await waitFor(() => expect(screen.queryByText('买菜和水果')).toBeNull());
});

it('the editor can clear a date', async () => {
  const todo = await s.repo.create('todos', { title: '买菜', due_date: '2026-11-25' });
  renderPage();
  await userEvent.click(await screen.findByRole('button', { name: '买菜' }));
  const editor = screen.getByRole('form', { name: '编辑待办' });
  await userEvent.clear(within(editor).getByLabelText('日期'));
  await userEvent.click(within(editor).getByRole('button', { name: '保存' }));
  await waitFor(async () => expect((await s.repo.get('todos', todo.id))?.due_date).toBeNull());
});

it('the editor refuses a blank title and keeps the editor open', async () => {
  const todo = await s.repo.create('todos', { title: '买菜' });
  renderPage();
  await userEvent.click(await screen.findByRole('button', { name: '买菜' }));
  const editor = screen.getByRole('form', { name: '编辑待办' });
  await userEvent.clear(within(editor).getByLabelText('标题'));
  await userEvent.click(within(editor).getByRole('button', { name: '保存' }));
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(screen.getByRole('form', { name: '编辑待办' })).toBeInTheDocument();
  expect((await s.repo.get('todos', todo.id))?.title).toBe('买菜');
});

it('a refused record shows the reason and keeps the edit until it is fixed', async () => {
  // A stage 1 todo stored with a lone surrogate in its title: no edit saves until the title is fixed.
  const ts = new Date().toISOString();
  const bad: TodoRecord = {
    id: '22222222-2222-4222-8222-222222222222', user_id: FAKE_USER_ID, kind: 'todo', title: 'bad\uD800', done: false,
    priority: 'normal', due_date: null, note: '', steps: [], created_at: ts, updated_at: ts, rev: 1, deleted_at: null, purged_at: null,
  };
  await s.db.raw.put('todos', bad);
  renderPage();
  const row = await rowOf('bad\uD800');
  await userEvent.click(within(row).getByRole('button', { name: /bad/ }));
  const editor = screen.getByRole('form', { name: '编辑待办' });
  await userEvent.type(within(editor).getByLabelText('备注'), '新备注');
  await userEvent.click(within(editor).getByRole('button', { name: '保存' }));
  expect(await screen.findByText(/title must be text/)).toBeInTheDocument();
  expect(within(screen.getByRole('form', { name: '编辑待办' })).getByLabelText('备注')).toHaveValue('新备注');
  const title = within(screen.getByRole('form', { name: '编辑待办' })).getByLabelText('标题');
  await userEvent.clear(title);
  await userEvent.type(title, '修好了');
  await userEvent.click(within(screen.getByRole('form', { name: '编辑待办' })).getByRole('button', { name: '保存' }));
  await waitFor(async () => expect(await s.repo.get('todos', bad.id)).toMatchObject({ title: '修好了', note: '新备注' }));
});

describe('goals', () => {
  async function openGoals() {
    renderPage();
    await userEvent.click(screen.getByRole('tab', { name: '目标' }));
  }

  it('a goal can get steps; ticking a step writes steps', async () => {
    await openGoals();
    await userEvent.type(screen.getByPlaceholderText('新目标'), '学游泳{enter}');
    const card = (await screen.findByText('学游泳')).closest('.goal-card') as HTMLElement;
    expect(card).not.toBeNull();
    await waitFor(async () => expect(await s.repo.list('todos')).toMatchObject([{ kind: 'goal', title: '学游泳', steps: [] }]));
    await userEvent.type(within(card).getByPlaceholderText('新步骤'), '第一步');
    await userEvent.click(within(card).getByRole('button', { name: '添加步骤' }));
    await waitFor(async () => expect((await s.repo.list('todos'))[0].steps).toMatchObject([{ text: '第一步', done: false }]));
    const [goal] = await s.repo.list('todos');
    expect(goal.steps[0].id).toMatch(/^[0-9a-f-]{36}$/);
    await userEvent.click(await within(card).findByRole('checkbox', { name: '第一步' }));
    await waitFor(async () => expect((await s.repo.get('todos', goal.id))?.steps[0].done).toBe(true));
  });

  it('goals stay out of the upcoming list', async () => {
    await s.repo.create('todos', { title: '学游泳', kind: 'goal' });
    renderPage();
    expect(await screen.findByText('近期没有待办')).toBeInTheDocument();
    expect(screen.queryByText('学游泳')).toBeNull();
  });

  it('editing and deleting a step write the whole steps array', async () => {
    const goal = await s.repo.create('todos', {
      title: '学游泳', kind: 'goal',
      steps: [{ id: 's1', text: '买泳镜', done: false }, { id: 's2', text: '报名', done: true }],
    });
    await openGoals();
    const field = await screen.findByDisplayValue('买泳镜');
    await userEvent.clear(field);
    await userEvent.type(field, '买泳镜和泳帽{enter}');
    await waitFor(async () =>
      expect((await s.repo.get('todos', goal.id))?.steps).toEqual([{ id: 's1', text: '买泳镜和泳帽', done: false }, { id: 's2', text: '报名', done: true }]),
    );
    await userEvent.click(screen.getByRole('button', { name: '删除步骤 报名' }));
    await waitFor(async () => expect((await s.repo.get('todos', goal.id))?.steps).toEqual([{ id: 's1', text: '买泳镜和泳帽', done: false }]));
  });

  async function seedTwoSteps() {
    return s.repo.create('todos', {
      title: '学游泳', kind: 'goal',
      steps: [{ id: 'a', text: '买泳镜', done: false }, { id: 'b', text: '报名', done: false }],
    });
  }

  it('rename one step, then tick another at once: both survive', async () => {
    const goal = await seedTwoSteps();
    await openGoals();
    const field = await screen.findByDisplayValue('买泳镜');
    // No await between the actions: the second fires before the list re-reads.
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: '买泳镜和泳帽' } });
    fireEvent.blur(field);
    fireEvent.click(screen.getByRole('checkbox', { name: '报名' }));
    await waitFor(async () =>
      expect((await s.repo.get('todos', goal.id))?.steps).toEqual([
        { id: 'a', text: '买泳镜和泳帽', done: false },
        { id: 'b', text: '报名', done: true },
      ]),
    );
  });

  it('two quick ticks on different steps: both survive', async () => {
    const goal = await seedTwoSteps();
    await openGoals();
    const a = await screen.findByRole('checkbox', { name: '买泳镜' });
    const b = screen.getByRole('checkbox', { name: '报名' });
    fireEvent.click(a);
    fireEvent.click(b);
    await waitFor(async () =>
      expect((await s.repo.get('todos', goal.id))?.steps.map((x) => x.done)).toEqual([true, true]),
    );
  });

  it('a step change stored after the render (a pull) is not overwritten', async () => {
    const goal = await seedTwoSteps();
    await openGoals();
    const box = await screen.findByRole('checkbox', { name: '买泳镜' });
    // Another device renamed 报名 and added a step; written without telling the page, like a pull mid-run.
    const stored = await s.repo.get('todos', goal.id);
    await s.db.raw.put('todos', {
      ...stored!,
      steps: [{ id: 'a', text: '买泳镜', done: false }, { id: 'b', text: '报名游泳班', done: false }, { id: 'c', text: '下水', done: false }],
    });
    fireEvent.click(box);
    await waitFor(async () =>
      expect((await s.repo.get('todos', goal.id))?.steps).toEqual([
        { id: 'a', text: '买泳镜', done: true },
        { id: 'b', text: '报名游泳班', done: false },
        { id: 'c', text: '下水', done: false },
      ]),
    );
  });

  it('every checkbox sits in a .hit touch box (sized 44px in styles.css)', async () => {
    await seedTwoSteps();
    await openGoals();
    await screen.findByRole('checkbox', { name: '报名' });
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(3); // the goal and its two steps
    for (const box of boxes) expect(box.parentElement).toHaveClass('hit');
  });

  it('a failed step write does not jam the next one, and its error still shows', async () => {
    const goal = await seedTwoSteps();
    await openGoals();
    const a = await screen.findByRole('checkbox', { name: '买泳镜' });
    const b = screen.getByRole('checkbox', { name: '报名' });
    const realUpdate = s.repo.update.bind(s.repo);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.spyOn(s.repo, 'update')
      .mockRejectedValueOnce(new LocalWriteError('full'))
      .mockImplementationOnce(async (...args: Parameters<typeof realUpdate>) => {
        await gate;
        return realUpdate(...args);
      });
    fireEvent.click(a);
    fireEvent.click(b);
    // The first write failed: its message shows while the second is still running.
    expect(await screen.findByText('保存失败')).toBeInTheDocument();
    release();
    await waitFor(async () =>
      expect((await s.repo.get('todos', goal.id))?.steps.map((x) => x.done)).toEqual([false, true]),
    );
  });

  it('a done goal moves under 已完成的目标, collapsed', async () => {
    const goal = await s.repo.create('todos', { title: '学游泳', kind: 'goal' });
    await s.repo.create('todos', { title: '读完一本书', kind: 'goal' });
    await openGoals();
    await userEvent.click(await screen.findByRole('checkbox', { name: '学游泳' }));
    await waitFor(async () => expect((await s.repo.get('todos', goal.id))?.done).toBe(true));
    const details = (await screen.findByText('已完成的目标')).closest('details') as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    await waitFor(() => expect(within(details).getByText('学游泳')).toBeInTheDocument());
    expect(within(details).queryByText('读完一本书')).toBeNull();
  });

  it('a goal can be deleted to the trash', async () => {
    const goal = await s.repo.create('todos', { title: '学游泳', kind: 'goal' });
    await openGoals();
    await userEvent.click(await screen.findByRole('button', { name: '删除目标 学游泳' }));
    await waitFor(async () => expect((await s.repo.list('todos', { trashed: true })).map((t) => t.id)).toEqual([goal.id]));
  });

  it('a refused step write shows 保存失败 and keeps the step text', async () => {
    await s.repo.create('todos', { title: '学游泳', kind: 'goal' });
    await openGoals();
    const card = (await screen.findByText('学游泳')).closest('.goal-card') as HTMLElement;
    vi.spyOn(s.repo, 'update').mockRejectedValue(new LocalWriteError('full'));
    await userEvent.type(within(card).getByPlaceholderText('新步骤'), '第一步{enter}');
    expect(await screen.findByText('保存失败')).toBeInTheDocument();
    expect(within(card).getByPlaceholderText('新步骤')).toHaveValue('第一步');
  });
});

it('a refused write shows 保存失败 and keeps the form', async () => {
  vi.spyOn(s.repo, 'create').mockRejectedValue(new LocalWriteError('full'));
  renderPage();
  await userEvent.type(screen.getByPlaceholderText('新待办'), '买牛奶{enter}');
  expect(await screen.findByText('保存失败')).toBeInTheDocument();
  expect(screen.getByPlaceholderText('新待办')).toHaveValue('买牛奶');
});

it('the upcoming row checkbox sits in a .hit touch box', async () => {
  await s.repo.create('todos', { title: '买菜' });
  renderPage();
  expect((await screen.findByRole('checkbox', { name: '买菜' })).parentElement).toHaveClass('hit');
});

it('a refused tick shows 保存失败 and does not crash', async () => {
  await s.repo.create('todos', { title: '买菜' });
  renderPage();
  const box = await screen.findByRole('checkbox', { name: '买菜' });
  vi.spyOn(s.repo, 'update').mockRejectedValue(new LocalWriteError('full'));
  await userEvent.click(box);
  expect(await screen.findByText('保存失败')).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: '买菜' })).not.toBeChecked();
});

it('re-reads after an engine event (a pull)', async () => {
  renderPage();
  expect(await screen.findByText('近期没有待办')).toBeInTheDocument();
  const ts = new Date().toISOString();
  const pulled: TodoRecord = {
    id: '11111111-1111-4111-8111-111111111111', user_id: FAKE_USER_ID, kind: 'todo', title: 'from phone', done: false,
    priority: 'normal', due_date: null, note: '', steps: [], created_at: ts, updated_at: ts, rev: 1, deleted_at: null, purged_at: null,
  };
  // The engine writes without Repo.onChange; its status events are how the page learns of pulled records.
  await s.db.raw.put('todos', pulled);
  expect(screen.queryByText('from phone')).toBeNull();
  await s.engine.sync();
  expect(await screen.findByText('from phone')).toBeInTheDocument();
});

it('shows a record a real sync run pulls from another device', async () => {
  const ts = new Date().toISOString();
  let served = false;
  const cloud: CloudClient = {
    ...offlineCloud(),
    pull: async () => {
      if (served) return { rows: [], has_more: false };
      served = true;
      return {
        rows: [{
          table: 'todos',
          row: {
            id: '33333333-3333-4333-8333-333333333333', user_id: FAKE_USER_ID, kind: 'todo', title: 'pulled from phone', done: false,
            priority: 'normal', due_date: null, note: '', steps: [], created_at: ts, updated_at: ts, rev: 1, deleted_at: null, purged_at: null,
          },
        }],
        has_more: false,
      };
    },
  };
  s = await createTestServices({ cloud });
  renderPage();
  expect(await screen.findByText('近期没有待办')).toBeInTheDocument();
  expect(await s.engine.sync()).toMatchObject({ outcome: 'ok', pulled: 1 });
  expect(await screen.findByText('pulled from phone')).toBeInTheDocument();
});

describe('weather line', () => {
  const SH = { name: '上海', region: '上海市', country: '中国', latitude: 31.22, longitude: 121.46 };

  it('the upcoming tab shows the weather line above the list', async () => {
    await setCity(s.db, SH);
    // Fetched one hour before NOW (2026-11-23 12:00 Shanghai): fresh, so no request.
    await saveCache(s.db, {
      city: SH,
      fetchedAt: '2026-11-23T03:00:00.000Z',
      forecast: { timezone: 'Asia/Shanghai', days: [{ date: '2026-11-23', code: 0 }, { date: '2026-11-24', code: 0 }, { date: '2026-11-25', code: 0 }] },
    });
    await s.repo.create('todos', { title: '买菜' });
    const fetchFn = vi.fn<typeof fetch>();
    render(<TodosPage services={s} onOpenDay={onOpenDay} weatherFetchFn={fetchFn} />);
    const line = await screen.findByText('上海：未来三天都是晴');
    const form = screen.getByPlaceholderText('新待办').closest('form')!;
    const row = await rowOf('买菜');
    // The line comes first in the tab: above the add form and the list.
    expect(line.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(line.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open-Meteo' })).toBeInTheDocument();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('without a city the tab shows the hint and the goals tab has no weather line', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    render(<TodosPage services={s} onOpenDay={onOpenDay} weatherFetchFn={fetchFn} />);
    expect(await screen.findByText('在设置里选一个城市即可显示天气')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: '目标' }));
    expect(screen.queryByText('在设置里选一个城市即可显示天气')).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('coming back to 近期 re-reads a city chosen meanwhile', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ timezone: 'Asia/Shanghai', daily: { time: ['2026-11-23'], weather_code: [61] } })));
    render(<TodosPage services={s} onOpenDay={onOpenDay} weatherFetchFn={fetchFn} />);
    expect(await screen.findByText('在设置里选一个城市即可显示天气')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: '目标' }));
    await setCity(s.db, SH);
    await userEvent.click(screen.getByRole('tab', { name: '近期' }));
    expect(await screen.findByText('上海：今天有雨')).toBeInTheDocument();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
