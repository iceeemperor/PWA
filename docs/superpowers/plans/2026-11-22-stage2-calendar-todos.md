# 阶段 2：日历 + 待办/目标 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在阶段 1 的地基上加入不重复的日历事项（`events` 表、月视图和当天列表）、正式的待办和目标界面（优先级、小步骤）、合并日历重要事项的「近期」栏（两种排序、14 天范围、显示已完成）和设置里的回收站。

**Architecture:** 沿用四层结构。新表 `events` 用一个新的 migration 加入云端，进入 `sync_tables` 后 `push_change`、`pull_changes`、清理和导入自动覆盖它。本机 IndexedDB 升到第 2 版。「近期」和排序写成纯函数（`src/agenda/*`），界面只调用 `Repo` 和这些函数。时区换算用浏览器自带的 `Intl`，不加依赖。

**Tech Stack:** 同阶段 1（React 19、TypeScript 7、Vite 8、vite-plugin-pwa 2、idb、zod 4、Supabase、Vitest 5、PGlite、fake-indexeddb、Testing Library）。不新增运行时依赖（`rrule` 库到阶段 3 才加）。

**Spec:** `docs/superpowers/specs/2026-11-05-productivity-app-design.md`（§4、§5.1、§5.2、§6、§8.5、§11 阶段 2、§12「联动与排序」「删除」）。

**项目根目录：** `C:\Users\Lenovo\Claude\productivity-app`，分支从 `main`（`38dd750`）新开 `stage-2-calendar-todos`。**绝不在它的上一级运行 git。** 阶段 1 的账本 `.superpowers/sdd/2026-11-06-stage1-foundation/progress.md` 里的裁决继续有效，尤其是「权限一律显式」「security definer 函数 `set search_path = public, pg_temp`」「SQL 改动只用新 migration」。

## Global Constraints

每个任务的要求都隐含包含本节。数值照抄规格。

- 最小宽度 360px；手机底部导航，768px 起侧边导航。（3.5）
- `id` 是前端生成的 UUID v4。时间戳 ISO 8601、UTC。待办日期 `YYYY-MM-DD`。（4）
- 日历事项例外：全天事项 `starts_at`/`ends_at` 为 `YYYY-MM-DD`；非全天为本地时间 `YYYY-MM-DDTHH:mm`（不带偏移）加 IANA 时区名 `tz`；全天事项 `tz` 为空；`ends_at` 可为空。（5.1）
- `events` 字段：`title` 必填、`all_day`、`starts_at`、`ends_at`、`tz`、`note`（纯文本）、`important` 默认否、`done` 默认否、`rrule` 可为空。`tz` 和 `rrule` 两列第一次建表就存在；阶段 2 里 `rrule` 始终为空，界面不开放。（5.1）
- 界面显示和判断「今天」时，换算成**设备所在时区**。（5.1、6.1）
- 「近期」= `kind = todo` 的待办 + `important = true` 的日历事项；显示未完成的，条件是日期不晚于今天之后 14 天，或者是没有日期的待办。（6.1）
- 已完成默认隐藏，打开「显示已完成」后全部显示，按日期倒序。（6.1）
- 排序两种模式，一个按钮切换，选择**保存在本机、不同步**。按优先级（默认）：高、普通、低三组，重要日历事项算「高」；组内：已过期未完成最前（按日期从早到晚），然后今天及以后（按日期从早到晚），最后没有日期的待办（按创建时间从新到旧）；已过期带红色标记；日期和优先级都相同时按 `id` 排。按日期：不分组，其余同上。（6.2）
- 勾选待办写 `todos.done`；勾选不重复的日历事项写 `events.done`。来自日历的项目带日历标记，点击跳到日历当天。（6.3）
- 「目标」栏单独显示 `kind = goal`，不受 14 天限制，不上日历，不参与优先级排序；小步骤写入 `steps`。（6.4）
- 月视图加当天列表；重要且已完成的事项在日历上显示为划线。（5.1）
- 回收站在设置里，按类型列出，可恢复；已被清空的不列出。（8.5）
- 删除只写 `deleted_at`；清理把内容重置为列的 DEFAULT（所以**每个内容列都要有 DEFAULT，且不能有 UNIQUE**，阶段 1 账本 Task 6 的注意）。（4、8.5）
- 推送从不 upsert；只带被改的字段；`events` 不留冲突副本（`sync_tables.copy_fields = '{}'`）。（8.2）
- 导出 JSON 的 `events` 表现在有数据；`event_overrides`、`notes`、`journal` 仍是空数组。（7.1）

## 规格没写、本计划替你定下的事（看计划时请重点看这几条）

1. 月视图**周一开头**。
2. 跨多天的全天事项在覆盖的每一天都显示；非全天事项只在开始那天显示（按设备时区）。「近期」里事项只按开始日期算。
3. 「显示已完成」打开后，已完成的项目放在列表下面单独一段，按日期倒序，不受 14 天限制；不混进优先级分组。
4. 排序选择存在本机的 IndexedDB 元数据里（`agenda_sort`）。
5. 编辑事项时，时间按事项自己的时区显示和修改；和设备时区不同时标出时区。新建事项用设备时区。
6. 全天改成非全天时默认 09:00 开始、没有结束时间；反过来只保留日期。
7. 夏令时：不存在的本地时间往后推，出现两次的取较早的一次。
8. 服务器只检查时区名的形状，真正的时区校验在本机（Repo 和备份校验用同一个函数，两者一致）。
9. 日历上的「日记小标记」等阶段 5 有日记再做。

## Review Focus

规格没有明说、但最可能咬到人的五种情况，每条在对应任务里有测试。

1. **事项的时区和设备时区不同**（比如在上海建的 9:00 会议，人到了东京）：日历格子、「近期」的日期和「今天」都按设备时区算，事项本身的 `tz` 和本地时间不变。（Task 3、5）
2. **夏令时缺口和重叠**：`America/New_York` 2026-03-08 02:30 不存在、2026-11-01 01:30 出现两次，换算要确定且不抛错（缺口往后推，重叠取较早的一次）。（Task 3）
3. **从阶段 1 升级的手机**：本机库从第 1 版升到第 2 版时，已有待办和未上传的队列一条不丢；游标归零以便拉到新表；另一个标签页还开着旧版本时，提示刷新而不是卡住或白屏。（Task 1）
4. **本地午夜附近**：「今天」「已过期」「14 天内」都按设备时区的日历日算，不按 UTC；UTC 已经是第二天、本地还是今天时，今天的事项不能变成「已过期」。（Task 5）
5. **全天与非全天来回切换、结束早于开始**：切换时字段格式随之转换；结束早于开始被拒绝并提示，而不是存进去后同步失败。（Task 3、8）

---

### Task 1: 表定义集中化与本机库升级到第 2 版

**Files:**
- Create: `src/domain/tables.ts`
- Modify: `src/domain/types.ts`（`TableName` 加 `'events'`，`EventFields`、`EventRecord`、`FieldsByTable`/`NewFieldsByTable` 加 `events`）、`src/data/local-db.ts`、`src/data/repo.ts`（`SPECS` 的 `defaults` 改用 `TABLE_DEFAULTS`）、`src/sync/engine.ts`（删掉 `TOMBSTONE_CONTENT`，改用 `TABLE_DEFAULTS`）、`src/app/services.ts`、`src/ui/App.tsx`
- Test: `tests/data/local-db-upgrade.test.ts`、`tests/domain/tables.test.ts`

**Interfaces:**
- Produces（`types.ts`）：`type TableName = 'todos' | 'events'`；`TABLES = ['todos', 'events']`；
  `interface EventFields { title: string; all_day: boolean; starts_at: string; ends_at: string | null; tz: string | null; note: string; important: boolean; done: boolean; rrule: string | null }`；`NewFields<'events'> = Pick<EventFields, 'title' | 'starts_at'> & Partial<Omit<EventFields, 'title' | 'starts_at'>>`。
- Produces（`tables.ts`）：`const TABLE_DEFAULTS: { [T in TableName]: FieldsOf<T> }`（**必须等于 SQL 列的 DEFAULT**：`events` 为 `{ title: '', all_day: true, starts_at: '', ends_at: null, tz: null, note: '', important: false, done: false, rrule: null }`）；`contentKeys(t: TableName): string[]`。
- Produces（`local-db.ts`）：`SCHEMA_VERSION = 2`；`openLocalDb(name?, o?: { onVersionChange?: () => void; onBlocked?: () => void })`。
- Produces（`services.ts`）：`createServices(env, o?: { onVersionChange?: () => void; onBlocked?: () => void })`，把回调传给 `openLocalDb`。
- `Repo` 的 `SPECS.events` 在本任务里先放一个拒绝一切写入的校验（抛 `InvalidRecordError('events are not available yet')`），Task 3 换成真正的规则；这样类型从本任务起就完整，界面在 Task 7 之前也不会写入事项。

- [ ] **Step 1: 写失败的测试**

```ts
// tests/data/local-db-upgrade.test.ts（每个测试用独立的库名）
it('upgrading a version 1 database keeps todos and the queue and resets the cursor', async () => {
  const name = uniqueName(); await seedVersion1(name, { todos: [todo1], queue: [op1], cursor: 812, db_id: ID });
  const db = await openLocalDb(name);
  expect(await db.raw.getAll('todos')).toEqual([todo1]); expect(await db.raw.getAll('queue')).toEqual([op1]);
  expect(db.raw.objectStoreNames.contains('events')).toBe(true);
  expect(await db.getMeta('cursor')).toBe(0); expect(db.dbId).toBe(ID);
});
it('a fresh install creates every store at version 2', async () => {
  const db = await openLocalDb(uniqueName()); expect([...db.raw.objectStoreNames].sort()).toEqual(['events', 'meta', 'queue', 'todos']);
});
it('an open old connection is told to close so the upgrade can finish', async () => {
  const name = uniqueName(); const onVersionChange = vi.fn(); await openLocalDb(name, { onVersionChange }); // stands in for the old tab
  await bumpVersion(name, 3); expect(onVersionChange).toHaveBeenCalledTimes(1);
});
it('a stage 1 tab that never closes its connection makes the new version report blocked', async () => {
  const name = uniqueName(); const old = await openVersion1WithoutHandlers(name); const onBlocked = vi.fn();
  const opening = openLocalDb(name, { onBlocked }); await vi.waitFor(() => expect(onBlocked).toHaveBeenCalledTimes(1));
  old.close(); await expect(opening).resolves.toBeTruthy();
});
// tests/domain/tables.test.ts
it('TABLE_DEFAULTS lists exactly the content fields of each record type', () => {
  expect(contentKeys('events').sort()).toEqual(['all_day', 'done', 'ends_at', 'important', 'note', 'rrule', 'starts_at', 'title', 'tz']);
});
```

`seedVersion1` 用 `idb` 直接按阶段 1 的结构（版本 1：`todos`、`queue`、`meta`）建库并写入；`bumpVersion` 用更高版本号打开同名库。

- [ ] **Step 2: 运行确认失败**：`npx vitest run tests/data/local-db-upgrade.test.ts tests/domain/tables.test.ts`。
- [ ] **Step 3: 实现。** `upgrade(db, oldVersion, _new, tx)`：每张表、`queue`、`meta` 只在 `!db.objectStoreNames.contains(...)` 时创建；`oldVersion >= 1 && oldVersion < 2` 时用升级事务 `tx.objectStore('meta').put(0, 'cursor')`（阶段 1 账本审计 I2：旧版本拉取时跳过了不认识的表但游标已越过它们）。`openDB` 的 `blocking` 回调里先 `close()` 再调 `onVersionChange`；`App` 收到后显示「应用已在另一个标签页更新，请刷新」和「刷新」按钮（`location.reload()`）。`blocked` 回调（阶段 1 的旧标签页没有 `blocking` 处理，不会主动关闭）调 `onBlocked`；`Root` 在启动画面上显示「请关闭其他打开着本应用的标签页或窗口」，旧连接关闭后升级自动完成、照常进入应用。`Repo` 和引擎的内容字段、墓碑内容一律来自 `TABLE_DEFAULTS`。
- [ ] **Step 4: 运行确认通过**：同上命令，再运行 `npx vitest run`（阶段 1 的全部测试仍通过）。
- [ ] **Step 5: 提交**：`git commit -m "feat(data): shared table defaults and local database version 2"`

---

### Task 2: 云端 `events` 表与加固

**Files:**
- Create: `supabase/migrations/20261122000100_events.sql`
- Test: `tests/db/events.test.ts`、`tests/db/sync-tables-rls.test.ts`；扩展 `tests/db/pull-purge.test.ts`、`tests/db/import-backup.test.ts`

**Interfaces:**
- Consumes: 阶段 1 的 `rev_seq`、`set_rev_and_updated_at()`、`sync_tables`、`push_change`、`pull_changes`、`purge_expired`、`import_backup`，以及 harness 的 `createTestDb`、`asUser`、`makeTombstone`、`trashAt`、`rowOf`。
- Produces: 表 `events`；`pull_changes` 重新定义（只多一个条件 `t.user_id = auth.uid()`）。

- [ ] **Step 1: 写失败的测试**

```ts
// tests/db/events.test.ts
it('a signed-in user can push, pull, trash and restore an event', async () => { /* push insert → pull_changes returns { table: 'events' } with a rev > 0 → delete → restore */ });
it('defaults: a minimal timed insert stores the column defaults for the rest', async () => {
  await push(A, insertEvent({ title: '会', all_day: false, starts_at: '2026-11-23T09:00', tz: 'Asia/Shanghai' }));
  expect(await rowOf(id)).toMatchObject({ ends_at: null, note: '', important: false, done: false, rrule: null });
});
it.each([
  ['blank title', { title: ' ' }],
  ['all-day with a time', { all_day: true, starts_at: '2026-11-23T09:00', tz: null }],
  ['all-day with a tz', { all_day: true, starts_at: '2026-11-23', tz: 'Asia/Shanghai' }],
  ['timed without tz', { all_day: false, starts_at: '2026-11-23T09:00', tz: null }],
  ['timed with seconds or offset', { all_day: false, starts_at: '2026-11-23T09:00:00+08:00', tz: 'Asia/Shanghai' }],
  ['end before start', { all_day: true, starts_at: '2026-11-23', ends_at: '2026-11-22' }],
  ['end in the other form', { all_day: true, starts_at: '2026-11-23', ends_at: '2026-11-23T10:00' }],
  ['rrule set', { all_day: true, starts_at: '2026-11-23', rrule: 'FREQ=DAILY' }],
])('push_change rejects %s as invalid', async (_n, fields) => expect((await push(A, insertEvent(fields))).status).toBe('invalid'));
it('purge turns an expired trashed event into a tombstone that satisfies every CHECK', async () => {
  /* insert, trashAt(id, 31 days ago), purge_expired as cron → purged_at set, content equals TABLE_DEFAULTS.events, rev bumped */
});
it('authenticated cannot insert, update or delete events directly; anon cannot select', async () => { /* privilege matrix like core.test.ts */ });
it('pull_changes never returns another user\'s rows even if RLS were disabled', async () => {
  /* as superuser: alter table events disable row level security; B's row exists; pull as A returns only A's rows; re-enable */
});
// tests/db/sync-tables-rls.test.ts
it('every table in sync_tables has RLS enabled and one policy per command', async () => {
  /* for each name in sync_tables: pg_class.relrowsecurity = true; pg_policies has select, insert, update, delete */
});
```

扩展：`import-backup.test.ts` 加「`events` 的行按原样新增并保留 `updated_at`」；`pull-purge.test.ts` 加「`events` 墓碑在拉取结果里」。

- [ ] **Step 2: 运行确认失败**：`npx vitest run tests/db`。
- [ ] **Step 3: 写 migration。** 表的公共列与 `todos` 完全相同（`id uuid primary key`、`user_id uuid not null default auth.uid()`、`created_at`、`updated_at`、`rev bigint`、`deleted_at`、`purged_at`，照抄 `20261106000100_core.sql` 的写法和 `created_at` 范围 CHECK）。内容列：`title text not null default ''`、`all_day boolean not null default true`、`starts_at text not null default ''`、`ends_at text`、`tz text`、`note text not null default ''`、`important boolean not null default false`、`done boolean not null default false`、`rrule text`。CHECK 全部写成 `purged_at is not null or (...)`，让墓碑（默认值）通过：
  - `btrim(title, <与 harden.sql 相同的空白集合>) <> ''`
  - 全天：`starts_at ~ '^\d{4}-\d{2}-\d{2}$'`、`tz is null`、`ends_at is null or (ends_at ~ 同一格式 and ends_at >= starts_at)`
  - 非全天：`starts_at ~ '^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$'`、`tz ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$'`、`ends_at is null or (ends_at ~ 同一格式 and ends_at >= starts_at)`（同一时区下本地时间的字符串比较就是先后比较）
  - `events_no_rrule_yet check (rrule is null)`（阶段 3 删掉这条）
  - 索引 `(user_id, rev)`；触发器 `events_set_rev_and_updated_at`；RLS 和四条策略（DELETE 为 `using (false)`）；`revoke all ... from anon, authenticated; grant select on events to authenticated`（写入只经 security definer 函数，阶段 1 F5）；`insert into sync_tables (name, copy_fields) values ('events', '{}')`。
  - `create or replace function pull_changes(...)`：复制 `20261106000300_pull_and_purge.sql` 的定义，每张表的查询多加 `and t.user_id = auth.uid()`，授权语句照旧重写一遍。
- [ ] **Step 4: 运行确认通过**：`npx vitest run tests/db`。
- [ ] **Step 5: 提交**：`git commit -m "feat(db): events table, explicit user filter in pull_changes"`

---

### Task 3: 事项字段规则与时区换算

**Files:**
- Create: `src/domain/time.ts`、`src/data/validate-event-fields.ts`
- Modify: `src/data/repo.ts`（`SPECS.events`；`update` 改为校验**合并后的整条内容**，两张表都一样）
- Test: `tests/domain/time.test.ts`、`tests/data/validate-event-fields.test.ts`；扩展 `tests/db/field-rules.test.ts`（三方一致）、`tests/data/repo.test.ts`

**Interfaces:**
- Produces（`time.ts`）：
  - `deviceTimeZone(): string`（`Intl.DateTimeFormat().resolvedOptions().timeZone`）
  - `isTimeZone(tz: string): boolean`（`new Intl.DateTimeFormat('en-US', { timeZone: tz })` 不抛错）
  - `zonedToInstant(local: string, tz: string): Date`（`local` 为 `YYYY-MM-DDTHH:mm`；缺口往后推、重叠取较早，即 Temporal 的 `'compatible'`）
  - `localDateOf(instant: Date, tz: string): string`（`YYYY-MM-DD`）、`localTimeOf(instant: Date, tz: string): string`（`HH:mm`）
  - `addDays(date: string, n: number): string`（纯日历运算，不经过时区）
- Produces（`validate-event-fields.ts`）：`validateEventFields(f: EventFields): void`，抛 `InvalidRecordError`；`switchAllDay(f: EventFields, toAllDay: boolean, deviceTz: string): Pick<EventFields, 'all_day' | 'starts_at' | 'ends_at' | 'tz'>`。

- [ ] **Step 1: 写失败的测试**

```ts
// tests/domain/time.test.ts
it('converts a local time in its own zone to the instant', () => expect(zonedToInstant('2026-11-23T09:00', 'Asia/Shanghai').toISOString()).toBe('2026-11-23T01:00:00.000Z'));
it('a local time in a DST gap moves forward', () => expect(zonedToInstant('2026-03-08T02:30', 'America/New_York').toISOString()).toBe('2026-03-08T07:30:00.000Z'));
it('an ambiguous local time takes the earlier instant', () => expect(zonedToInstant('2026-11-01T01:30', 'America/New_York').toISOString()).toBe('2026-11-01T05:30:00.000Z'));
it('the device date of an event can differ from its own date', () => {
  const at = zonedToInstant('2026-11-23T23:30', 'Asia/Shanghai'); expect(localDateOf(at, 'Asia/Tokyo')).toBe('2026-11-24'); expect(localTimeOf(at, 'Asia/Tokyo')).toBe('00:30');
});
it('addDays crosses month and year ends', () => { expect(addDays('2026-12-31', 1)).toBe('2027-01-01'); expect(addDays('2026-03-01', -1)).toBe('2026-02-28'); });
it('isTimeZone', () => { expect(isTimeZone('Asia/Shanghai')).toBe(true); expect(isTimeZone('Mars/Base')).toBe(false); });
// tests/data/validate-event-fields.test.ts — 与 Task 2 的 it.each 同一组坏值全部被拒绝，另加：
it('rejects a timed event whose tz is not a real IANA zone', () => expect(() => validateEventFields(ev({ all_day: false, starts_at: '2026-11-23T09:00', tz: 'Mars/Base' }))).toThrow(InvalidRecordError));
it('rejects a date that is not on the calendar', () => expect(() => validateEventFields(ev({ starts_at: '2026-02-30' }))).toThrow(InvalidRecordError));
it('switchAllDay to all-day keeps the dates and clears the zone', () =>
  expect(switchAllDay(ev({ all_day: false, starts_at: '2026-11-23T09:00', ends_at: '2026-11-24T10:00', tz: 'Asia/Shanghai' }), true, 'Asia/Tokyo'))
    .toEqual({ all_day: true, starts_at: '2026-11-23', ends_at: '2026-11-24', tz: null }));
it('switchAllDay to timed starts at 09:00 in the device zone with no end', () =>
  expect(switchAllDay(ev({ all_day: true, starts_at: '2026-11-23', ends_at: '2026-11-25' }), false, 'Asia/Tokyo'))
    .toEqual({ all_day: false, starts_at: '2026-11-23T09:00', ends_at: null, tz: 'Asia/Tokyo' }));
// tests/data/repo.test.ts
it('update validates the merged record: an end before the stored start is refused', async () => {
  const e = await repo.create('events', { title: 'x', starts_at: '2026-11-23' }); await expect(repo.update('events', e.id, { ends_at: '2026-11-20' })).rejects.toThrow(InvalidRecordError);
});
```

`field-rules.test.ts` 加一张 `events` 的表：同一组好值和坏值，经过 `validateEventFields`、Task 4 的备份校验和 `push_change`，结论一致。唯一允许的不一致是「形状对但不存在的时区名」：本机两处拒绝、服务器接受（服务器无法在 CHECK 里查时区库），把这一行写成预期的例外并注明原因。

- [ ] **Step 2: 运行确认失败**：`npx vitest run tests/domain/time.test.ts tests/data`。
- [ ] **Step 3: 实现。** `zonedToInstant`：先把 `local` 当成 UTC 得到猜测值，用 `Intl.DateTimeFormat(..., { timeZone: tz, hourCycle: 'h23', ... }).formatToParts` 求该时刻在 `tz` 的偏移，修正一次；如果修正后的本地时间与 `local` 不符（缺口），用缺口后的偏移；重叠时取两个候选里较早的。`validateEventFields` 的字符串字段沿用 `isStorableText`；日期沿用 `isCalendarDate`；非全天的日期部分也必须是真实日期。
- [ ] **Step 4: 运行确认通过**：`npx vitest run`。
- [ ] **Step 5: 提交**：`git commit -m "feat(data): event field rules and time-zone helpers"`

---

### Task 4: 备份覆盖 `events`

**Files:**
- Modify: `src/backup/validate.ts`（`SUPPORTED_TABLES` 加 `events`，`rowSchemas.events` 复用 `validateEventFields`）
- Test: 扩展 `tests/backup/validate.test.ts`、`tests/backup/export-json.test.ts`、`tests/backup/import.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `validateEventFields`，Task 1 的 `TABLES`（`buildBackup` 已按 `TABLES` 遍历，不用改）。

- [ ] **Step 1: 写失败的测试**

```ts
it('accepts a file with events and still rejects rows in event_overrides, notes and journal', () => { /* valid() with one all-day and one timed event → ok; event_overrides: [{}] → not ok */ });
it('rejects an event with an end before its start, naming the row', () =>
  expect(validateBackup(withEvent({ starts_at: '2026-11-23', ends_at: '2026-11-22' }))).toMatchObject({ ok: false, errors: [expect.stringContaining('events[0]')] }));
it('export contains events, trashed ones included, tombstones left out', async () => { /* create two events, remove one, tombstone a third → exported ids are the first two */ });
it('round trip with events: export from one device, import into an empty account, sync another device, same data', async () => { /* like the stage 1 round trip, with one todo and one timed event */ });
```

- [ ] **Step 2: 运行确认失败**：`npx vitest run tests/backup`。
- [ ] **Step 3: 实现。** 事项的行 schema 是严格的：公共字段（`id`、`created_at`、`updated_at`、`deleted_at`）加 `EventFields` 全部字段，不允许未知键，然后整条交给 `validateEventFields`。
- [ ] **Step 4: 运行确认通过**：`npx vitest run tests/backup`。
- [ ] **Step 5: 提交**：`git commit -m "feat(backup): events in the backup file"`

---

### Task 5: 「近期」与「目标」的业务规则

**Files:**
- Create: `src/agenda/agenda.ts`
- Test: `tests/agenda/agenda.test.ts`

**Interfaces:**
- Consumes: `TodoRecord`、`EventRecord`、Task 3 的 `zonedToInstant`、`localDateOf`、`localTimeOf`、`addDays`。
- Produces:
  - `const AGENDA_DAYS = 14`
  - `type SortMode = 'priority' | 'date'`
  - `interface AgendaItem { source: 'todo' | 'event'; id: string; title: string; date: string | null; time: string | null; priority: 'high' | 'normal' | 'low'; done: boolean; overdue: boolean; created_at: string }`（`date`、`time` 都是设备时区下的值；全天事项 `time` 为 `null`）
  - `interface Agenda { groups: { priority: 'high' | 'normal' | 'low' | null; items: AgendaItem[] }[]; done: AgendaItem[] }`（`date` 模式只有一组，`priority` 为 `null`；`done` 只在 `showDone` 时有内容）
  - `buildAgenda(todos: TodoRecord[], events: EventRecord[], o: { now: Date; tz: string; mode: SortMode; showDone: boolean }): Agenda`
  - `goalsOf(todos: TodoRecord[]): TodoRecord[]`（未删除的 `kind = goal`，未完成在前，其余按创建时间从新到旧）
  - `eventDate(e: EventRecord, tz: string): string`

- [ ] **Step 1: 写失败的测试**（`now` 固定为 `2026-11-23T04:00:00Z`，`tz` 为 `Asia/Shanghai`，所以今天是 `2026-11-23`）

```ts
it('merges todos and important events, leaves out unimportant events and goals', () => {
  const a = buildAgenda([todo({ title: 't' }), goal({ title: 'g' })], [event({ title: 'imp', important: true }), event({ title: 'plain' })], o());
  expect(titles(a)).toEqual(expect.arrayContaining(['t', 'imp'])); expect(titles(a)).not.toContain('plain'); expect(titles(a)).not.toContain('g');
});
it('keeps items up to today + 14 days and todos without a date, drops later ones', () => {
  const a = buildAgenda([todo({ due_date: '2026-12-07', title: 'in' }), todo({ due_date: '2026-12-08', title: 'out' }), todo({ title: 'nodate' })], [], o());
  expect(titles(a).sort()).toEqual(['in', 'nodate']);
});
it('an important event counts as high priority', () => expect(groupOf(buildAgenda([], [event({ important: true, starts_at: '2026-11-24' })], o()), 'high')).toHaveLength(1));
it('within a group: overdue first by date, then today and later by date, then undated by newest created', () => {
  const a = buildAgenda([
    todo({ title: 'later', due_date: '2026-11-25' }), todo({ title: 'od2', due_date: '2026-11-21' }), todo({ title: 'od1', due_date: '2026-11-20' }),
    todo({ title: 'today', due_date: '2026-11-23' }), todo({ title: 'old', created_at: '2026-11-01T00:00:00Z' }), todo({ title: 'new', created_at: '2026-11-22T00:00:00Z' }),
  ], [], o());
  expect(groupOf(a, 'normal').map(i => i.title)).toEqual(['od1', 'od2', 'today', 'later', 'new', 'old']);
  expect(groupOf(a, 'normal').filter(i => i.overdue).map(i => i.title)).toEqual(['od1', 'od2']);
});
it('same date and priority: ordered by id, so the order is stable', () => { /* two todos, ids 'a…' and 'b…', same due_date → 'a…' first whatever the input order */ });
it('date mode: one group, priority ignored, same rules otherwise', () => { /* high due 11-25, low due 11-24 → low first; groups.length === 1 */ });
it('done items are hidden; with showDone they appear in done, newest date first', () => {
  const todos = [todo({ title: 'd1', done: true, due_date: '2026-11-01' }), todo({ title: 'd2', done: true, due_date: '2026-11-20' }), todo({ title: 'open' })];
  expect(titles(buildAgenda(todos, [], o()))).toEqual(['open']);
  expect(buildAgenda(todos, [], o({ showDone: true })).done.map(i => i.title)).toEqual(['d2', 'd1']);
});
it('"today" follows the device zone, not UTC', () => {
  // 2026-11-23T17:00Z is already 11-24 01:00 in Shanghai but still 11-23 in UTC
  const a = buildAgenda([todo({ title: 'due23', due_date: '2026-11-23' })], [], o({ now: new Date('2026-11-23T17:00:00Z') }));
  expect(all(a).find(i => i.title === 'due23')!.overdue).toBe(true);
  const b = buildAgenda([todo({ title: 'due23', due_date: '2026-11-23' })], [], o({ now: new Date('2026-11-23T15:00:00Z') })); // 23:00 local
  expect(all(b).find(i => i.title === 'due23')!.overdue).toBe(false);
});
it('a timed event is dated in the device zone', () => {
  const e = event({ important: true, all_day: false, starts_at: '2026-11-24T23:30', tz: 'Asia/Shanghai' });
  expect(all(buildAgenda([], [e], o({ tz: 'Asia/Tokyo' })))[0]).toMatchObject({ date: '2026-11-25', time: '00:30' });
});
it('trashed items never appear', () => expect(all(buildAgenda([todo({ deleted_at: '2026-11-22T00:00:00Z' })], [event({ important: true, deleted_at: '2026-11-22T00:00:00Z' })], o({ showDone: true })))).toEqual([]));
it('goalsOf lists goals only, open ones first', () => { /* … */ });
```

- [ ] **Step 2: 运行确认失败**：`npx vitest run tests/agenda`。
- [ ] **Step 3: 实现。** 比较键依次为：组（`priority` 模式下高、普通、低）、段（过期 0、今天及以后 1、无日期 2）、段内（0 和 1 按 `date` 升序、同日按 `time`，全天在前；2 按 `created_at` 降序）、`id` 升序。`done` 列表按 `date` 降序，无日期的按 `created_at` 降序排在最后。`priority` 字段：待办取自己的，事项一律为 `'high'`。
- [ ] **Step 4: 运行确认通过**：同上命令。
- [ ] **Step 5: 提交**：`git commit -m "feat(agenda): upcoming list and goals rules"`

---

### Task 6: 待办界面（近期与目标）

**Files:**
- Create: `src/ui/TodosPage.tsx`、`src/ui/TodoEditor.tsx`、`src/ui/GoalCard.tsx`、`src/ui/useLiveRecords.ts`
- Modify: `src/ui/Shell.tsx`（「待办」标签改用 `TodosPage`）、`src/ui/styles.css`、`vitest.config.ts`（`test.env.TZ = 'Asia/Shanghai'`，让 `deviceTimeZone()` 在界面测试里是确定的）
- Delete: `src/ui/TodosTemp.tsx`、`tests/ui/todos-temp.test.tsx`
- Test: `tests/ui/todos-page.test.tsx`

**Interfaces:**
- Consumes: Task 5 的 `buildAgenda`、`goalsOf`、`AgendaItem`；`Repo`；`SyncEngine.subscribe`。
- Produces:
  - `useLiveRecords<T extends TableName>(repo: Repo, engine: SyncEngine, t: T, o?: { trashed?: boolean }): RecordOf<T>[]`（在 `repo.onChange` **或** `engine.subscribe` 时重读，阶段 1 的裁决）
  - `TodosPage({ services, onOpenDay }: { services: Services; onOpenDay: (date: string) => void })`
  - 排序选择存在本机元数据 `agenda_sort`（`'priority' | 'date'`，默认 `'priority'`），不同步。

- [ ] **Step 1: 写失败的测试**（时钟用阶段 1 的做法冻结：`vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime('2026-11-23T04:00:00Z')`，设备时区在 vitest 配置里固定为 `Asia/Shanghai`）

```tsx
it('has two tabs: 近期 and 目标', async () => { render(<TodosPage … />); expect(screen.getByRole('tab', { name: '近期' })).toHaveAttribute('aria-selected', 'true'); expect(screen.getByRole('tab', { name: '目标' })).toBeInTheDocument(); });
it('adds a todo with title, priority and date from the quick form', async () => {
  await userEvent.type(screen.getByPlaceholderText('新待办'), '买牛奶'); await userEvent.selectOptions(screen.getByLabelText('优先级'), 'high');
  await userEvent.type(screen.getByLabelText('日期'), '2026-11-25'); await userEvent.click(screen.getByRole('button', { name: '添加' }));
  expect(await repo.list('todos')).toMatchObject([{ title: '买牛奶', priority: 'high', due_date: '2026-11-25', kind: 'todo' }]);
});
it('shows the groups 高 普通 低 and marks overdue items', async () => { /* seed; expect headings 高/普通/低; overdue row has text 已过期 */ });
it('the sort button switches to 按日期 and the choice survives a remount', async () => { /* click 按日期 → one list; unmount, render again → still 按日期; db.getMeta('agenda_sort') === 'date' */ });
it('ticking a todo writes todos.done; ticking a calendar item writes events.done', async () => { /* both checkboxes; repo.get(...).done === true */ });
it('a calendar item shows the calendar mark and opens its day', async () => { const onOpenDay = vi.fn(); /* click 日历 link on the row */ expect(onOpenDay).toHaveBeenCalledWith('2026-11-24'); });
it('显示已完成 shows completed items newest first', async () => { /* … */ });
it('editing a todo changes title, note, priority and date; 删除 moves it to the trash', async () => { /* open editor by clicking the title; save; delete → repo.list('todos', { trashed: true }) has it */ });
it('a goal can get steps; ticking a step writes steps', async () => { /* 目标 tab, 新目标, add step 「第一步」, tick → steps[0].done === true */ });
it('a refused write shows 保存失败 and keeps the form', async () => { /* repo.create rejects LocalWriteError → text 保存失败; input still has the value */ });
it('re-reads after an engine event (a pull)', async () => { /* write directly to db.raw, fire engine subscribers → new row visible */ });
```

- [ ] **Step 2: 运行确认失败**：`npx vitest run tests/ui/todos-page.test.tsx`。
- [ ] **Step 3: 实现。** 近期每行：勾选框、标题、日期（今天显示「今天」，明天「明天」，其他 `M月D日`，有时间时加 `HH:mm`）、优先级色点、过期红色标记「已过期」、来自日历的加「日历」小标记（按钮，点击调 `onOpenDay(date)`）。快速新增表单固定在列表顶部：标题输入框（`新待办`）、`优先级`选择（高/普通/低，默认普通）、`日期`（`<input type="date">`，可空）、`添加`；回车等同添加。点标题打开 `TodoEditor`（标题、备注 `textarea`（纯文本显示，Markdown 渲染在阶段 4）、优先级、日期、`保存`、`删除`）。目标页：`新目标` 输入、每个目标一张 `GoalCard`（标题、完成勾选、步骤列表可勾选/改文字/删除、`添加步骤`），已完成的目标折叠在「已完成的目标」下。所有写入捕获 `LocalWriteError` 显示「保存失败」，捕获 `InvalidRecordError` 显示它的原因。
- [ ] **Step 4: 运行确认通过**：`npx vitest run tests/ui`。
- [ ] **Step 5: 提交**：`git commit -m "feat(ui): todos page with upcoming list and goals"`

---

### Task 7: 日历月视图与当天列表

**Files:**
- Create: `src/calendar/month.ts`、`src/ui/CalendarPage.tsx`
- Test: `tests/calendar/month.test.ts`、`tests/ui/calendar-page.test.tsx`

**Interfaces:**
- Consumes: Task 3 的时间函数，Task 5 的 `eventDate`，Task 6 的 `useLiveRecords`。
- Produces:
  - `monthGrid(year: number, month: number): string[][]`（6 行 × 7 列的 `YYYY-MM-DD`，**周一开头**，含前后月补位）
  - `eventsOnDay(events: EventRecord[], date: string, tz: string): EventRecord[]`（未删除；全天事项在 `starts_at` 到 `ends_at`（含）的每一天出现；非全天事项只在它设备时区下的开始日期出现；顺序：全天在前，然后按设备时区的开始时间，再按 `id`）
  - `CalendarPage({ services, day, onDayChange, onNewEvent, onOpenEvent }: { services: Services; day: string; onDayChange: (d: string) => void; onNewEvent: (date: string) => void; onOpenEvent: (e: EventRecord) => void })`（Task 8 把后两个回调接到 `EventEditor`）

- [ ] **Step 1: 写失败的测试**

```ts
// tests/calendar/month.test.ts
it('November 2026 starts on Monday 10-26 and has 6 rows of 7', () => {
  const g = monthGrid(2026, 11); expect(g).toHaveLength(6); expect(g.every(r => r.length === 7)).toBe(true); expect(g[0][0]).toBe('2026-10-26'); expect(g[0][6]).toBe('2026-11-01');
});
it('a multi-day all-day event shows on every day it covers', () => {
  const e = event({ starts_at: '2026-11-23', ends_at: '2026-11-25' }); expect(['2026-11-22', '2026-11-23', '2026-11-25', '2026-11-26'].map(d => eventsOnDay([e], d, TZ).length)).toEqual([0, 1, 1, 0]);
});
it('a timed event shows on its start day in the device zone only', () => { /* 23:30 Shanghai, device Tokyo → on 11-25, not 11-24 */ });
// tests/ui/calendar-page.test.tsx
it('shows the month title, weekday header 一…日, and marks today and the selected day', () => { /* 2026年11月; 一 二 三 四 五 六 日 */ });
it('moves between months with 上个月 / 下个月 and back with 今天', async () => { /* … */ });
it('a day with events shows a dot; selecting it lists the events with their time', async () => { /* 09:00 会议 */ });
it('an important and done event is struck through on the calendar and in the list', () => { /* the title element has class "done-important" (text-decoration: line-through) */ });
it('新建事项 calls onNewEvent with the selected day', async () => { /* the editor itself arrives in Task 8 */ });
it('fits 360px: the grid has no horizontal scroll', () => { /* styles.css: .month-grid uses grid-template-columns: repeat(7, minmax(0, 1fr)) */ });
```

- [ ] **Step 2: 运行确认失败**：`npx vitest run tests/calendar tests/ui/calendar-page.test.tsx`。
- [ ] **Step 3: 实现。** 页面上半是月视图（标题「YYYY年M月」、`上个月`、`下个月`、`今天`、周一开头的七列、今天和选中日各有样式、有事项的日子显示小圆点，重要事项的圆点用主色），下半是选中日的列表（全天的标「全天」，非全天显示设备时区的 `HH:mm`，事项 `tz` 与设备不同时在时间后加时区名缩写；`新建事项` 按钮）。点一天调 `onDayChange`。日记小标记属于阶段 5，不做。
- [ ] **Step 4: 运行确认通过**：同上命令。
- [ ] **Step 5: 提交**：`git commit -m "feat(ui): calendar month view and day list"`

---

### Task 8: 事项编辑与导航接线

**Files:**
- Create: `src/ui/EventEditor.tsx`
- Modify: `src/ui/Shell.tsx`（导航改为「待办」「日历」「设置」三项；`TodosPage.onOpenDay` 切到日历并选中那天；`CalendarPage` 的 `onNewEvent`/`onOpenEvent` 打开 `EventEditor`）
- Test: `tests/ui/event-editor.test.tsx`、扩展 `tests/ui/app.test.tsx`

**Interfaces:**
- Consumes: Task 3 的 `validateEventFields`、`switchAllDay`、`deviceTimeZone`；`Repo`。
- Produces: `EventEditor({ repo, initial, onClose }: { repo: Repo; initial: EventRecord | { date: string }; onClose: () => void })`。

- [ ] **Step 1: 写失败的测试**

```tsx
it('creates an all-day event on the given day by default', async () => {
  render(<EventEditor repo={repo} initial={{ date: '2026-11-24' }} onClose={close} />); await userEvent.type(screen.getByLabelText('标题'), '体检'); await userEvent.click(screen.getByRole('button', { name: '保存' }));
  expect(await repo.list('events')).toMatchObject([{ title: '体检', all_day: true, starts_at: '2026-11-24', tz: null, rrule: null }]);
});
it('unticking 全天 asks for times and stores local time plus the device zone', async () => {
  /* untick 全天; 开始时间 09:30; 结束时间 10:30 → starts_at '2026-11-24T09:30', ends_at '2026-11-24T10:30', tz 'Asia/Shanghai' */
});
it('an end before the start is refused with 结束不能早于开始 and nothing is saved', async () => { /* … */ });
it('editing keeps the event\'s own zone, and shows it when it differs from the device', async () => { /* initial tz 'Europe/London' → label shows 伦敦时间 or the zone id; saved tz stays Europe/London */ });
it('important and done can be ticked; 删除 moves the event to the trash', async () => { /* … */ });
it('has no repeat option in stage 2', () => expect(screen.queryByText(/重复/)).toBeNull());
// tests/ui/app.test.tsx
it('the navigation has 待办, 日历 and 设置; the calendar mark on an upcoming item opens that day', async () => { /* … */ });
```

- [ ] **Step 2: 运行确认失败**：`npx vitest run tests/ui/event-editor.test.tsx tests/ui/app.test.tsx`。
- [ ] **Step 3: 实现。** 字段：`标题`、`全天`（勾选框，切换时用 `switchAllDay`）、`日期`/`结束日期`（全天）或 `开始`/`结束`（`date` 加 `time` 两个输入，结束可空）、`重要`、`已完成`、`备注`（纯文本）、`保存`、`取消`、已有事项多一个 `删除`。保存前调 `validateEventFields`，错误映射成中文：结束早于开始→「结束不能早于开始」，标题为空→「请填写标题」，其他→「填写的内容有误」。新建时 `tz` 取 `deviceTimeZone()`；编辑时保留原 `tz`。
- [ ] **Step 4: 运行确认通过**：`npx vitest run tests/ui`。
- [ ] **Step 5: 提交**：`git commit -m "feat(ui): event editor and calendar navigation"`

---

### Task 9: 回收站

**Files:**
- Create: `src/ui/TrashSection.tsx`
- Modify: `src/ui/Settings.tsx`（在「同步失败」之前加「回收站」一节）
- Test: `tests/ui/trash.test.tsx`

**Interfaces:**
- Consumes: `useLiveRecords(..., { trashed: true })`、`Repo.restore`。
- Produces: `TrashSection({ services })`；`daysUntilPurge(deletedAt: string, now: Date): number`（`max(0, 30 - 已过整天数)`）。

- [ ] **Step 1: 写失败的测试**（时钟冻结在 `2026-11-23T04:00:00Z`）

```tsx
it('lists trashed todos and events under 待办 and 日历, with days left', async () => {
  /* todo trashed 2026-11-13 → 「还剩 20 天」; event trashed today → 「还剩 30 天」 */
});
it('恢复 brings a record back and it leaves the list', async () => { /* click 恢复 → repo.get(...).deleted_at === null; row gone */ });
it('tombstones are not listed; an empty trash says 回收站是空的', async () => { /* … */ });
it('daysUntilPurge never goes below 0', () => expect(daysUntilPurge('2026-10-01T00:00:00Z', new Date('2026-11-23T04:00:00Z'))).toBe(0));
```

- [ ] **Step 2: 运行确认失败**：`npx vitest run tests/ui/trash.test.tsx`。
- [ ] **Step 3: 实现。** 每类一个小标题（待办、日历），每行：标题、删除日期、「还剩 N 天」、`恢复` 按钮。目标归在「待办」里，标注「目标」。说明文字：「删除的内容在这里保留 30 天，之后永久清除」。
- [ ] **Step 4: 运行确认通过**：同上命令。
- [ ] **Step 5: 提交**：`git commit -m "feat(ui): trash in settings"`

---

### Task 10: 离线与多设备收敛测试（事项）

**Files:**
- Test: `tests/sync/events-convergence.test.ts`、扩展 `tests/sync/pull.test.ts`

**Interfaces:**
- Consumes: 阶段 1 的 `createPgliteCloud`、`createDevice`、`createFlakyCloud`、`seedAndSync`、`snapshot`、`cloudRows`；Task 5 的 `buildAgenda`。

- [ ] **Step 1: 写测试**（引擎对表是通用的，这些测试预期直接通过；失败说明引擎或 Task 1 有表相关的遗漏，按 systematic-debugging 修）

```ts
it('an important event made on one device shows in the other device\'s upcoming list', async () => { /* a creates important event; sync a, sync b; buildAgenda on b's lists contains it */ });
it('done on one device and a new title on the other both survive', async () => { /* different fields of one event; both converge; snapshot(a) equals snapshot(b) */ });
it('deleting an event on one device beats an offline edit on the other', async () => { /* b offline update → dropped: 1, event stays trashed on both */ });
it('a purged event reaches every device as a tombstone and leaves the trash list', async () => { /* makeTombstone; sync; repo.get undefined; list trashed empty */ });
it('a stage-1 device that upgrades pulls the events it skipped before', async () => {
  /* device opened at version 1 with cursor already past an events row (seed cursor high); reopen at version 2 → sync pulls the event */
});
it('offline event edits replay in order after reconnecting', async () => { /* failNext('network', 99); create + update + done; failNext(0); sync → b sees the final state */ });
```

- [ ] **Step 2: 运行**：`npx vitest run tests/sync`，全部通过。
- [ ] **Step 3: 提交**：`git commit -m "test(sync): events converge across devices and offline"`

---

### Task 11: 部署与真机检查（需要用户本人）

**Files:**
- Modify: `docs/superpowers/plans/stage1-verification.md` 改名为 `docs/superpowers/plans/verification.md`，加「阶段 2」一节

- [ ] **Step 1: 推送数据库**：`npx supabase db push --remote`（只有 `20261122000100_events.sql` 一个待推送）。
- [ ] **Step 2: 合并并部署**：把 `stage-2-calendar-todos` 快进合并到 `main` 并推送，Cloudflare 自动构建（构建变量不变）。
- [ ] **Step 3: iPhone（主屏幕打开）和 Windows 浏览器各过一遍，结果记进 `verification.md`：**
  1. 打开后出现「更新」，点后进入新版本；原来的待办都在，没有「同步失败」。
  2. 另一个标签页开着旧版本时，新版本能打开，旧标签页提示刷新。
  3. 新建全天事项、非全天事项、跨三天的全天事项，月视图和当天列表显示正确；另一台设备收到。
  4. 标为重要的事项出现在「近期」的「高」组，点日历标记跳到那天；勾选后在日历上划线。
  5. 待办：三档优先级、过期红色标记、切到「按日期」后重开应用仍是按日期、「显示已完成」。
  6. 目标：新建、加步骤、勾选步骤，另一台设备一致。
  7. 删除一条待办和一条事项，在设置的回收站里看到「还剩 30 天」，恢复后回到原处。
  8. 断网新建和修改事项，恢复网络后自动补传，另一台收到。
  9. 两台设备同时改同一条事项的不同字段（一台改标题，一台勾完成），两边最终一致。
  10. 导出完整备份，文件里 `events` 有数据；导入后全部「跳过」。
- [ ] **Step 4: 提交**：`git add docs/superpowers/plans && git commit -m "docs: stage 2 verification results"`
