# 阶段 1：地基 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建好登录、云端数据库、本机优先的同步、JSON 与 Markdown 导出、JSON 导入和部署上线，让之后每个模块只调用统一的数据接口。

**Architecture:** 前端分四层：界面 → 本地数据层（IndexedDB，`Repo`）→ 同步层（上传队列加按 `rev` 增量拉取）→ 云端层（Supabase：表、RLS、服务器函数）。界面只调用 `Repo`，不直接碰云端。所有冲突、幂等、墓碑和清理规则放在 Postgres 函数里，用 PGlite（浏览器外的 WASM Postgres）在 Vitest 里直接测试，不需要 Docker。阶段 1 只建 `todos` 一张表，用它验证整套同步。

**Tech Stack:** TypeScript、React、Vite、vite-plugin-pwa、idb、zod、fflate、@supabase/supabase-js；测试用 Vitest、fake-indexeddb、@testing-library/react（jsdom）、@electric-sql/pglite；Supabase CLI 管理 migration；sharp 生成图标。依赖版本在安装时取最新稳定版并锁定在 lockfile 里。

**Spec:** `docs/superpowers/specs/2026-11-05-productivity-app-design.md`

**项目根目录：** `/home/claude/productivity-app/`。所有命令都在这个目录里运行。**绝不能在它的上一级（家目录，里面有 `.ssh` 等私人文件）里 `git init` 或 `git add`。**

## Global Constraints

每个任务的要求都隐含包含本节。数值照抄规格。

- 前端：TypeScript + React，Vite 构建，PWA（manifest 加 service worker）。（3.2）
- 最小宽度 360px；手机用底部导航，宽度 768px 以上用侧边导航。（3.5）
- `id` 是前端生成的 UUID v4，不用自增数字。（4）
- 时间戳一律 ISO 8601、UTC；待办日期是不带时区的 `YYYY-MM-DD`。（4）
- `rev`：bigint，所有表共用一个序列，每次新增或修改都由服务器取序列的下一个值；`updated_at` 只用于显示、由服务器写入（导入函数除外）；`created_at` 由客户端在创建时写入，创建后不再修改。（4）
- 删除只写 `deleted_at`；30 天后服务器清空内容并写入 `purged_at`，这一行永远保留（墓碑）。（4、8.5）
- 所有表启用 RLS；SELECT、INSERT、UPDATE、DELETE 策略分别写；INSERT 和 UPDATE 带 `WITH CHECK (user_id = auth.uid())`。（3.3）
- service_role 密钥绝不进前端、不进仓库；关闭新用户注册，不启用匿名登录和第三方登录。（3.3）
- 数据库的变化一律是版本化 SQL migration（Supabase CLI），不手改线上库。（3.2）
- 推送从不使用 upsert；每条操作带唯一 `op_id`；只带被改的字段。（8.1）
- 拉取时从游标往回退 100；游标和数据在同一个 IndexedDB 事务里更新；本机数据库为空从不被解释成「全都删了」。（8.1）
- 写入后立即推送，对连续输入做 2 秒防抖，不攒批；第一版不做实时推送。（8.1）
- 导出 JSON：`format` 为 `productivity-app-export`，`version` 为 `1`；包含回收站记录、不含墓碑；去掉 `user_id`、`rev`、`purged_at`。（7.1）
- 距离上次导出超过 7 天提醒。（7.1）

## Review Focus

规格没有明说、但最可能咬到你的五种情况，每条在对应任务里有测试。

1. 无痕模式或 IndexedDB 不可用：应用要给出明确提示，而不是白屏。（Task 2、15）
2. 同一浏览器开了两个标签页同时同步：不能重复推送同一批操作。（Task 7）
3. 部署新版本后 iPhone 仍在跑旧的 service worker：要提示更新而不是卡在旧版本。（Task 1、15）
4. 导入垃圾文件：不是 JSON、同一文件里 `id` 重复、大量坏记录，都要整体拒绝并给出有限的错误列表，不崩溃。（Task 12）
5. 还有未上传改动时点退出登录：要先确认，取消后保持登录。（Task 15）

## 范围

只实现阶段 1。以下内容属于后面的阶段，本计划只留好接口位置，不实现：冲突副本（随阶段 4 的 `notes` 表加入，阶段 1 的 `todos` 遇到冲突只做「最后被接受者为准」并计数）、日记同日合并（阶段 5）、重复事项例外和父子还原顺序（阶段 3）、`search` 的实现（阶段 6）、回收站界面（阶段 2）。

## File Structure

| 路径 | 职责 |
|---|---|
| `src/domain/types.ts` | 表名、记录类型、操作和结果类型、备份文件类型与常量 |
| `src/domain/ids.ts` | `newId`、`isUuid` |
| `src/data/local-db.ts` | 打开 IndexedDB，建仓库，`db_id` 和元数据 |
| `src/data/repo.ts` | 本地数据层：增删改查、入队、`onChange`、`search` 接口形状 |
| `src/data/validate-fields.ts` | 待办字段校验（与数据库约束一致） |
| `src/data/persist.ts` | 申请持久化存储 |
| `src/sync/cloud.ts` | `CloudClient` 接口和 `CloudError` |
| `src/sync/supabase-cloud.ts` | 用 Supabase 实现 `CloudClient`，错误分类 |
| `src/sync/engine.ts` | 同步引擎：推送、拉取、状态、单飞与跨标签锁 |
| `src/sync/triggers.ts` | 防抖、前台、联网触发，重试间隔，启动时清理 |
| `src/backup/export-json.ts` | 完整备份 |
| `src/backup/export-markdown.ts` | Markdown 压缩包 |
| `src/backup/validate.ts` | 备份文件整体校验 |
| `src/backup/import.ts` | 导入服务 |
| `src/backup/reminder.ts` | 导出提醒 |
| `src/backup/save-file.ts` | 保存文件（分享面板或下载） |
| `src/auth/auth.ts`、`src/supabase.ts` | 登录封装、Supabase 客户端 |
| `src/app/services.ts` | 组装各层 |
| `src/ui/*` | 界面：`App`、`LoginPage`、`Shell`、`SyncBanner`、`UpdatePrompt`、`TodosTemp`、`UnavailableScreen`、`Settings`、`ExportReminder`、`styles.css` |
| `supabase/migrations/*` | 版本化 SQL |
| `tests/**` | 与源码对应；`tests/helpers/*` 放测试替身 |

---

### Task 1: 工程脚手架

**Files:**
- Create: `package.json`、`tsconfig.json`、`vite.config.ts`、`vitest.config.ts`、`index.html`、`.gitignore`、`.env.example`、`src/main.tsx`、`src/ui/App.tsx`（占位）、`public/icon.svg`、`scripts/make-icons.mjs`、`tests/setup.ts`、`tests/smoke.test.ts`

**Interfaces:**
- Produces: npm 脚本 `dev`、`build`、`test`（`vitest run`）、`typecheck`（`tsc --noEmit`）；测试环境默认 node 并在 `tests/setup.ts` 里加载 `fake-indexeddb/auto`，UI 测试文件用 `// @vitest-environment jsdom`；PWA 配置 `registerType: 'prompt'`，manifest 为 `{ name: '个人效率', short_name: '效率', display: 'standalone', start_url: '/' }`，并含 192、512 的 PNG 图标和 `apple-touch-icon.png`（180）；`.env.example` 含 `VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY`、`VITE_PURGE_ON_START`。

- [ ] **Step 1: 写失败的冒烟测试** `tests/smoke.test.ts`，确认后面所有测试依赖的环境存在：

```ts
import { it, expect } from 'vitest';
it('test environment provides indexedDB and crypto.randomUUID', () => {
  expect(typeof indexedDB.open).toBe('function');
  expect(crypto.randomUUID()).toMatch(/^[0-9a-f-]{36}$/);
});
```

- [ ] **Step 2: 运行确认失败**：`npx vitest run tests/smoke.test.ts`，预期失败（还没有 package.json 或 vitest 配置）。
- [ ] **Step 3: 搭脚手架。** 用 Vite 的 React + TypeScript 模板初始化，加入上面「Tech Stack」里的依赖；`tsconfig` 开 `strict`；`vite.config.ts` 用 `vite-plugin-pwa`（`registerType: 'prompt'`，workbox 的 `navigateFallback` 为 `index.html`）；`scripts/make-icons.mjs` 用 sharp 从 `public/icon.svg` 生成三张 PNG，运行一次并提交产物；`.gitignore` 含 `node_modules`、`dist`、`.env*`（保留 `.env.example`）。
- [ ] **Step 4: 运行确认通过**：`npx vitest run`、`npm run typecheck`、`npm run build` 全部成功。
- [ ] **Step 5: 提交。** 仓库已由控制者在项目根目录初始化，`docs/` 已提交，当前在分支 `stage-1-foundation` 上，不要新建仓库：

```bash
git add -A && git commit -m "chore: scaffold app"
```

---

### Task 2: 领域类型与本机数据库

**Files:**
- Create: `src/domain/types.ts`、`src/domain/ids.ts`、`src/data/local-db.ts`
- Test: `tests/domain/ids.test.ts`、`tests/data/local-db.test.ts`

**Interfaces:**
- Produces（`src/domain/types.ts`）：
  - `type TableName = 'todos'`；`const TABLES: readonly TableName[] = ['todos']`
  - `interface CommonFields { id: string; user_id: string; created_at: string; updated_at: string; rev: number; deleted_at: string | null; purged_at: string | null }`
  - `interface Step { id: string; text: string; done: boolean }`
  - `interface TodoFields { kind: 'todo' | 'goal'; title: string; done: boolean; priority: 'high' | 'normal' | 'low'; due_date: string | null; note: string; steps: Step[] }`
  - `type TodoRecord = CommonFields & TodoFields`；`type FieldsOf<T extends TableName>`、`type RecordOf<T extends TableName>`、`type NewFields<T extends TableName>`（对待办是 `Pick<TodoFields,'title'> & Partial<Omit<TodoFields,'title'>>`）
  - `type OpKind = 'insert' | 'update' | 'delete' | 'restore'`
  - `interface QueuedOp { seq: number; op_id: string; table: TableName; id: string; kind: OpKind; base_rev: number | null; fields: Record<string, unknown>; failed: { reason: string } | null }`
  - `type PushOp = Omit<QueuedOp, 'seq' | 'failed'>`
  - `type PushStatus = 'applied' | 'dropped_trashed' | 'dropped_purged' | 'invalid'`
  - `interface PushResult { status: PushStatus; conflict: boolean; rev: number | null; record: Record<string, unknown> | null; message: string | null }`
  - `interface PullPage { rows: { table: TableName; row: Record<string, unknown> }[]; has_more: boolean }`
  - `type BackupTableKey = 'events' | 'event_overrides' | 'todos' | 'notes' | 'journal'`；`interface BackupFile { format: 'productivity-app-export'; version: 1; exported_at: string; tables: Record<BackupTableKey, Record<string, unknown>[]> }`；`const BACKUP_FORMAT`、`BACKUP_VERSION`、`BACKUP_TABLE_KEYS`
  - `interface ImportSummary { added: number; restored: number; skipped: Record<string, number> }`
- Produces（`ids.ts`）：`newId(): string`（UUID v4）、`isUuid(s: string): boolean`
- Produces（`local-db.ts`）：`class LocalDbUnavailableError extends Error`；`interface LocalDb { raw: IDBPDatabase; dbId: string; getMeta<T>(key: string): Promise<T | undefined>; setMeta(key: string, value: unknown): Promise<void>; close(): void }`；`openLocalDb(name?: string): Promise<LocalDb>`。仓库：每个表一个（`keyPath: 'id'`），`queue`（`keyPath: 'seq'`，自增），`meta`。元数据键：`db_id`、`cursor`（数字，初始 0）、`last_export_at`。

- [ ] **Step 1: 写失败的测试**

```ts
// tests/domain/ids.test.ts
it('newId returns a UUID v4', () => expect(newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));
it('isUuid accepts well-formed uuids and rejects others', () => {
  expect(isUuid(newId())).toBe(true); expect(isUuid('123')).toBe(false); expect(isUuid('')).toBe(false);
});
// tests/data/local-db.test.ts  (每个 it 使用不同的库名)
it('creates a store per table plus queue and meta, a db_id and cursor 0', async () => {
  const db = await openLocalDb('t1');
  expect([...db.raw.objectStoreNames].sort()).toEqual(['meta', 'queue', 'todos']);
  expect(isUuid(db.dbId)).toBe(true); expect(await db.getMeta('cursor')).toBe(0);
});
it('keeps db_id and meta values after reopening', async () => {
  const a = await openLocalDb('t2'); await a.setMeta('last_export_at', 'x'); const id = a.dbId; a.close();
  const b = await openLocalDb('t2'); expect(b.dbId).toBe(id); expect(await b.getMeta('last_export_at')).toBe('x');
});
afterEach(() => vi.unstubAllGlobals());
it('throws LocalDbUnavailableError when indexedDB is missing', async () => {
  vi.stubGlobal('indexedDB', undefined);
  await expect(openLocalDb('t3')).rejects.toBeInstanceOf(LocalDbUnavailableError);
});
```

- [ ] **Step 2: 运行确认失败**：`npx vitest run tests/domain tests/data/local-db.test.ts`，预期失败（模块不存在）。
- [ ] **Step 3: 按上面的签名实现。** `openLocalDb` 在 `indexedDB` 不存在或打开抛错时抛 `LocalDbUnavailableError`；首次打开时在同一个事务里写入 `db_id`（`newId()`）和 `cursor = 0`。
- [ ] **Step 4: 运行确认通过**：同上命令，预期全部通过。
- [ ] **Step 5: 提交**

```bash
git add src/domain src/data/local-db.ts tests/domain tests/data && git commit -m "feat: domain types and local IndexedDB"
```

---

### Task 3: 本地数据层 `Repo`

**Files:**
- Create: `src/data/repo.ts`、`src/data/validate-fields.ts`
- Test: `tests/data/repo.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `LocalDb`、类型、`newId`。
- Produces:
  - `class InvalidRecordError`、`TrashedRecordError`、`PurgedRecordError`、`LocalWriteError`（均 `extends Error`；`LocalWriteError` 表示本机存储写入失败，例如空间不足）
  - `validateTodoFields(f: Partial<TodoFields>): void`（非法则抛 `InvalidRecordError`：`title` 去空白后为空；`due_date` 不是 `YYYY-MM-DD`；`kind`、`priority` 不在枚举内）
  - `interface RepoDeps { userId: () => string; now?: () => Date; newId?: () => string }`
  - `interface SearchHit { table: TableName; id: string; snippet: string }`；`interface SearchOptions { limit?: number }`
  - `interface Repo { create<T extends TableName>(t: T, f: NewFields<T>): Promise<RecordOf<T>>; update<T extends TableName>(t: T, id: string, changes: Partial<FieldsOf<T>>): Promise<RecordOf<T>>; remove(t: TableName, id: string): Promise<void>; restore(t: TableName, id: string): Promise<void>; get<T extends TableName>(t: T, id: string): Promise<RecordOf<T> | undefined>; list<T extends TableName>(t: T, o?: { trashed?: boolean }): Promise<RecordOf<T>[]>; pendingCount(): Promise<number>; failedOps(): Promise<QueuedOp[]>; onChange(fn: () => void): () => void; search(q: string, o?: SearchOptions): Promise<SearchHit[]> }`
  - `createRepo(db: LocalDb, deps: RepoDeps): Repo`

- [ ] **Step 1: 写失败的测试**（`setup` 用唯一库名、`userId: () => U`、固定 `now`、递增 UUID 的 `newId`；`ops()` 读 `queue` 仓库；`setRev`、`makeTombstone`、`markFailed` 直接改写 IndexedDB 里的记录或队列项）

```ts
it('create fills defaults and queues one insert op', async () => {
  const r = await repo.create('todos', { title: 'a' });
  expect(r).toMatchObject({ kind: 'todo', done: false, priority: 'normal', due_date: null, note: '', steps: [], rev: 0, user_id: U, deleted_at: null, purged_at: null });
  expect(r.created_at).toBe(r.updated_at);
  expect(await ops()).toMatchObject([{ kind: 'insert', id: r.id, base_rev: null, failed: null, fields: { title: 'a', created_at: r.created_at } }]);
});
it('update changes the record and queues only the changed fields with the last seen rev', async () => {
  const r = await repo.create('todos', { title: 'a' }); await setRev(r.id, 7);
  const u = await repo.update('todos', r.id, { done: true });
  expect(u.done).toBe(true);
  expect((await ops()).at(-1)).toMatchObject({ kind: 'update', base_rev: 7, fields: { done: true } });
});
it('update on a trashed record throws TrashedRecordError', async () => {
  const r = await repo.create('todos', { title: 'a' }); await repo.remove('todos', r.id);
  await expect(repo.update('todos', r.id, { done: true })).rejects.toBeInstanceOf(TrashedRecordError);
});
it('remove moves a record to trash and restore brings it back', async () => {
  const r = await repo.create('todos', { title: 'a' }); await repo.remove('todos', r.id);
  expect(await repo.list('todos')).toHaveLength(0); expect(await repo.list('todos', { trashed: true })).toHaveLength(1);
  await repo.restore('todos', r.id); expect(await repo.list('todos')).toHaveLength(1);
  expect((await ops()).map(o => o.kind)).toEqual(['insert', 'delete', 'restore']);
});
it('tombstones are invisible and cannot be restored', async () => {
  const r = await repo.create('todos', { title: 'a' }); await makeTombstone(r.id);
  expect(await repo.get('todos', r.id)).toBeUndefined();
  expect(await repo.list('todos', { trashed: true })).toHaveLength(0);
  await expect(repo.restore('todos', r.id)).rejects.toBeInstanceOf(PurgedRecordError);
});
it('pendingCount ignores failed ops and failedOps lists them', async () => {
  await repo.create('todos', { title: 'a' }); await markFailed(1, 'bad');
  expect(await repo.pendingCount()).toBe(0); expect(await repo.failedOps()).toHaveLength(1);
});
it('onChange fires once per write and can be unsubscribed', async () => {
  const fn = vi.fn(); const off = repo.onChange(fn);
  await repo.create('todos', { title: 'a' }); expect(fn).toHaveBeenCalledTimes(1); off();
  await repo.create('todos', { title: 'b' }); expect(fn).toHaveBeenCalledTimes(1);
});
it('rejects invalid fields', async () => {
  await expect(repo.create('todos', { title: '  ' })).rejects.toBeInstanceOf(InvalidRecordError);
  await expect(repo.create('todos', { title: 'a', due_date: '2026/11/05' })).rejects.toBeInstanceOf(InvalidRecordError);
  await expect(repo.create('todos', { title: 'a', priority: 'urgent' as any })).rejects.toBeInstanceOf(InvalidRecordError);
});
it('search has the agreed shape and returns nothing yet', async () => expect(await repo.search('x')).toEqual([]));
it('a failed local write rejects with LocalWriteError and leaves nothing behind', async () => {
  const spy = vi.spyOn(db.raw, 'transaction').mockImplementation(() => { throw new DOMException('disk full', 'QuotaExceededError'); });
  await expect(repo.create('todos', { title: 'a' })).rejects.toBeInstanceOf(LocalWriteError); spy.mockRestore();
  expect(await repo.list('todos')).toHaveLength(0); expect(await ops()).toHaveLength(0);
});
```

- [ ] **Step 2: 运行确认失败**：`npx vitest run tests/data/repo.test.ts`，预期失败。
- [ ] **Step 3: 实现 `createRepo`。** 每次写入在**同一个 IndexedDB 事务**里同时写记录和队列，存储失败（如空间不足）时抛 `LocalWriteError` 且两边都不写入；新记录 `rev` 为 0、`updated_at` 等于 `created_at`；`update` 的 `base_rev` 取记录当前的 `rev`（本地编辑不改 `rev`）；`op_id` 用 `newId()`；每次写入成功后调用已注册的 `onChange` 监听器；`search` 暂时返回 `[]`。
- [ ] **Step 4: 运行确认通过**：同上命令。
- [ ] **Step 5: 提交**

```bash
git add src/data tests/data && git commit -m "feat: local repo with op queue"
```

---

### Task 4: 云端核心表、权限与 SQL 测试框架

**Files:**
- Create: `supabase/config.toml`（`npx supabase init` 生成，把 `[auth] enable_signup` 设为 `false`，`enable_anonymous_sign_ins` 设为 `false`）、`supabase/migrations/20261106000100_core.sql`、`tests/db/harness.ts`
- Test: `tests/db/harness.test.ts`、`tests/db/core.test.ts`

**Interfaces:**
- Produces（`tests/db/harness.ts`）：`const TEST_USER_A`、`TEST_USER_B`（固定 UUID）；`interface TestDb { pg: PGlite; asUser(uid: string): Promise<void>; asRole(role: 'anon' | 'postgres'): Promise<void> }`；`createTestDb(): Promise<TestDb>`。它新建内存 PGlite，建 `auth` schema、`auth.users(id uuid primary key)`、`auth.uid()`（读 `request.jwt.claim.sub` 设置）和角色 `anon`、`authenticated`，插入两个测试用户，再按文件名顺序执行 `supabase/migrations/*.sql`，**跳过以 `.cron.sql` 结尾的文件**。`asUser` 切到 `authenticated` 并设置 `request.jwt.claim.sub`；`asRole('anon')` 切到 `anon`，`asRole('postgres')` 回到超级用户。执行 migration 之前先 `alter default privileges in schema public grant all on tables, sequences, functions to anon, authenticated`（模拟 Supabase 的默认授权）。另导出 `makeTombstone(t, id)`（以超级用户把该行写成墓碑：`purged_at`、`deleted_at` 为现在，内容列重置为默认值）、`trashAt(t, id, daysAgo)`（把 `deleted_at` 设为若干天前）、`rowOf(t, id)`。测试文件里 `makeTombstone(id1)`、`trashAt(a, 31)`、`rowOf(id)`、`revOf(id)`、`count(uid)`、`seed(uid, n)` 这类简写，都是绑定了当前 `t` 的本地包装。
- Produces（SQL）：序列 `rev_seq`；表 `todos`（列和约束见 Step 3）、`applied_ops`、`sync_tables`；触发器函数 `set_rev_and_updated_at()`。

- [ ] **Step 1: 先验证 PGlite 能承担这个角色。** 写 `tests/db/harness.test.ts`，在 PGlite 里直接建一张开了 RLS 的表、一个触发器和一个序列，切到 `authenticated` 角色后插入别人的行，断言被拒绝，触发器和序列也生效。**如果 PGlite 不支持其中任何一项，停下来告诉用户**，退路是本机 Supabase CLI 加 Docker 加 pgTAP，那会改变本计划里所有 `tests/db` 的写法。
- [ ] **Step 2: 写失败的核心测试** `tests/db/core.test.ts`（`ins(uid, overrides)` 以 `postgres` 角色之外的 `asUser(uid)` 身份插入一行）

```ts
it('rev comes from one shared sequence and increases on every write', async () => {
  const a = await ins(A, {}); const b = await ins(A, {}); await upd(A, a.id, { done: true });
  const r = await rows(A); expect(r.find(x => x.id === a.id).rev).toBeGreaterThan(b.rev);
});
it('client-supplied rev and updated_at are ignored', async () => {
  const x = await ins(A, { rev: 999999, updated_at: '2000-01-01T00:00:00Z' });
  expect(x.rev).toBeLessThan(999999); expect(new Date(x.updated_at).getFullYear()).toBeGreaterThan(2000);
  const y = await upd(A, x.id, { rev: 5, updated_at: '2000-01-01T00:00:00Z' }); expect(y.rev).not.toBe(5);
});
it('a user cannot insert a row owned by someone else', async () => expect(ins(A, { user_id: B })).rejects.toThrow());
it('a user cannot read or update another user\'s rows', async () => {
  const x = await ins(A, {}); expect(await rows(B)).toHaveLength(0); expect(await upd(B, x.id, { done: true })).toBeUndefined();
});
it('an update cannot move a row to another user', async () => { const x = await ins(A, {}); await expect(upd(A, x.id, { user_id: B })).rejects.toThrow(); });
it('title must be non-empty unless purged_at is set', async () => {
  await expect(ins(A, { title: '' })).rejects.toThrow();
  await expect(ins(A, { title: '', purged_at: new Date().toISOString() })).resolves.toBeDefined();
});
it('created_at cannot be changed by an update', async () => {
  const x = await ins(A, {}); const y = await upd(A, x.id, { created_at: '2000-01-01T00:00:00Z' }); expect(y.created_at).toEqual(x.created_at);
});
```

- [ ] **Step 3: 运行确认失败**，然后写 migration `20261106000100_core.sql`：
  - `create sequence rev_seq`，并 `grant usage on sequence rev_seq to authenticated`。
  - 表 `todos`：`id uuid primary key`；`user_id uuid not null references auth.users(id) on delete cascade default auth.uid()`；`created_at`、`updated_at timestamptz not null default now()`；`rev bigint not null default 0`；`deleted_at`、`purged_at timestamptz`；`kind text not null default 'todo' check (kind in ('todo','goal'))`；`title text not null default ''`；`done boolean not null default false`；`priority text not null default 'normal' check (priority in ('high','normal','low'))`；`due_date date`；`note text not null default ''`；`steps jsonb not null default '[]'`；`check (purged_at is not null or title <> '')`。**每个内容列都必须有 DEFAULT**，因为清理会把它们重置成默认值。索引 `(user_id, rev)`。
  - 触发器 `set_rev_and_updated_at()`（BEFORE INSERT OR UPDATE）：`new.rev := nextval('rev_seq')`；除非本事务的设置 `app.keep_updated_at` 为 `on`，否则 `new.updated_at := now()`；UPDATE 时 `new.created_at := old.created_at`。
  - RLS：对 `todos` 启用，四条策略分别写，INSERT 与 UPDATE 带 `WITH CHECK (user_id = auth.uid())`，UPDATE 另有 `USING (user_id = auth.uid())`。
  - `applied_ops(user_id uuid, op_id uuid, result jsonb not null, created_at timestamptz not null default now(), primary key (user_id, op_id))`，启用 RLS 且不建任何策略（只有 security definer 函数能访问）。
  - `sync_tables(name text primary key, copy_fields text[] not null default '{}')`，启用 RLS 加一条 `SELECT USING (true)` 策略，插入 `('todos', '{}')`；授予 `authenticated` 的 SELECT。
- [ ] **Step 4: 运行确认通过**：`npx vitest run tests/db`。
- [ ] **Step 5: 提交**

```bash
git add supabase tests/db && git commit -m "feat(db): core schema, RLS and PGlite harness"
```

---

### Task 5: 服务器函数 `push_change`

**Files:**
- Create: `supabase/migrations/20261106000200_push_change.sql`
- Test: `tests/db/push-change.test.ts`

**Interfaces:**
- Consumes: Task 4 的表、触发器和 `TestDb`。
- Produces: `push_change(p_table text, p_op jsonb) returns jsonb`。`p_op` 为 `{ op_id, id, kind, base_rev, fields }`；返回 `{ status, conflict, rev, record, message }`，取值与 `PushResult` 一致。未登录抛 `not_authenticated`，表不在 `sync_tables` 里抛 `unknown_table`。`security definer`，`search_path` 固定为 `public`，只对 `authenticated` 授予执行权限（对 `public`、`anon` 撤销）。

- [ ] **Step 1: 写失败的测试**（本文件顶部的辅助函数：`push(uid, op)` 先 `asUser(uid)` 再 `select push_change('todos', $1)`；`op(kind, id, fields, base_rev)` 生成带新 `op_id` 的操作）

```ts
it('insert applies, assigns rev and forces user_id to the caller', async () => {
  const r = await push(A, op('insert', id1, { title: 'a', user_id: B }, null));
  expect(r).toMatchObject({ status: 'applied', conflict: false }); expect(r.rev).toBeGreaterThan(0); expect(r.record.user_id).toBe(A);
});
it('replaying the same op_id returns the stored result and writes nothing', async () => {
  const o = op('insert', id1, { title: 'a' }, null); const r1 = await push(A, o); const r2 = await push(A, o);
  expect(r2).toEqual(r1); expect(await count(A)).toBe(1);
});
it('update with the current base_rev is not a conflict', async () => {
  const r1 = await push(A, op('insert', id1, { title: 'a' }, null)); const r2 = await push(A, op('update', id1, { done: true }, r1.rev));
  expect(r2).toMatchObject({ status: 'applied', conflict: false });
});
it('update with a stale base_rev is applied, flagged, and only overwrites the sent fields', async () => {
  const r1 = await push(A, op('insert', id1, { title: 'a' }, null)); await push(A, op('update', id1, { title: 'from B' }, r1.rev));
  const r3 = await push(A, op('update', id1, { done: true }, r1.rev));
  expect(r3).toMatchObject({ status: 'applied', conflict: true }); expect(r3.record).toMatchObject({ title: 'from B', done: true });
});
it('delete always applies and sets deleted_at; restore clears it', async () => {
  await push(A, op('insert', id1, { title: 'a' }, null));
  const d = await push(A, op('delete', id1, {}, 0)); expect(d.record.deleted_at).not.toBeNull();
  const s = await push(A, op('restore', id1, {}, d.rev)); expect(s.record.deleted_at).toBeNull();
});
it('update on a trashed record is dropped and the row is unchanged', async () => {
  await push(A, op('insert', id1, { title: 'a' }, null)); await push(A, op('delete', id1, {}, 0));
  const r = await push(A, op('update', id1, { title: 'late' }, 0)); expect(r.status).toBe('dropped_trashed'); expect(r.record.title).toBe('a');
});
it('any op on a tombstone is dropped as purged', async () => {
  await push(A, op('insert', id1, { title: 'a' }, null)); await makeTombstone(id1);
  for (const k of ['update', 'delete', 'restore'] as const) expect((await push(A, op(k, id1, { title: 'x' }, 0))).status).toBe('dropped_purged');
});
it('insert with an existing id behaves as an update and creates no duplicate', async () => {
  await push(A, op('insert', id1, { title: 'a' }, null)); const r = await push(A, op('insert', id1, { title: 'b' }, null));
  expect(r.record.title).toBe('b'); expect(await count(A)).toBe(1);
});
it('server-managed keys in fields are ignored', async () => {
  const r = await push(A, op('insert', id1, { title: 'a', rev: 999999, updated_at: '2000-01-01T00:00:00Z', purged_at: '2000-01-01T00:00:00Z' }, null));
  expect(r.rev).toBeLessThan(999999); expect(r.record.purged_at).toBeNull();
});
it('invalid data returns status invalid with a message and writes nothing', async () => {
  const r = await push(A, op('insert', id1, { title: '' }, null)); expect(r.status).toBe('invalid'); expect(r.message).toBeTruthy(); expect(await count(A)).toBe(0);
});
it('another user\'s id cannot be taken over', async () => {
  await push(A, op('insert', id1, { title: 'a' }, null)); const r = await push(B, op('insert', id1, { title: 'x' }, null));
  expect(r.status).toBe('invalid'); expect(await titleOf(A, id1)).toBe('a');
});
it('unauthenticated and anon callers are rejected', async () => {
  await t.pg.exec(`reset role; select set_config('request.jwt.claim.sub','',false)`);
  await expect(t.pg.query(`select push_change('todos', '{}')`)).rejects.toThrow(/not_authenticated/);
  await t.asRole('anon'); await expect(t.pg.query(`select push_change('todos', '{}')`)).rejects.toThrow(/permission denied/);
});
it('unknown tables are rejected', async () => { await t.asUser(A); await expect(t.pg.query(`select push_change('nope', '{}')`)).rejects.toThrow(/unknown_table/); });
```

- [ ] **Step 2: 运行确认失败**：`npx vitest run tests/db/push-change.test.ts`，预期失败（函数不存在）。
- [ ] **Step 3: 写 migration。** 一个事务内按下面的顺序处理（动态 SQL 用 `format('%I')`，列名一律经 `information_schema.columns` 过滤）：
  1. `auth.uid()` 为空则抛 `not_authenticated`；`p_table` 不在 `sync_tables` 里则抛 `unknown_table`。
  2. 在 `applied_ops` 里查 `(auth.uid(), op_id)`，命中就直接返回当时存的 `result`。
  3. 按 `id` 和 `user_id = auth.uid()` 用 `FOR UPDATE` 锁住目标行。
  4. 可写列 = 表的列去掉服务器管理的 `user_id`、`updated_at`、`rev`、`deleted_at`、`purged_at`、`id`；UPDATE 时再去掉 `created_at`。`fields` 里不在可写列里的键一律忽略。
  5. `insert`：行不存在则**只插入 `fields` 里出现的列**（这样没传的列走数据库 DEFAULT），`user_id` 取 `auth.uid()`；行已存在则按 `update` 处理且 `conflict` 为 false。
  6. `update`：行已是墓碑返回 `dropped_purged`；已在回收站返回 `dropped_trashed`；否则只覆盖 `fields` 里出现的列，`conflict := (base_rev is distinct from 行当前 rev)`。
  7. `delete`：墓碑返回 `dropped_purged`；否则写入 `deleted_at = now()`（已在回收站则保持原值），不看 `base_rev`。`restore`：墓碑返回 `dropped_purged`；否则 `deleted_at = null`。
  8. 行不存在的 update、delete、restore 返回 `invalid`，`message` 为 `record not found`。
  9. 捕获 `check_violation`、`not_null_violation`、`unique_violation`、`invalid_text_representation`、`datetime_field_overflow`，返回 `status = 'invalid'`、`message` 取错误信息，且回滚本次写入。
  10. 返回的 `record` 是写入后整行的 `to_jsonb`；除 `invalid` 外把结果写进 `applied_ops`。
- [ ] **Step 4: 运行确认通过**：同上命令。
- [ ] **Step 5: 提交**

```bash
git add supabase tests/db && git commit -m "feat(db): push_change with rev conflict detection and idempotency"
```

---

### Task 6: 服务器函数 `pull_changes`、`purge_expired` 和定时任务文件

**Files:**
- Create: `supabase/migrations/20261106000300_pull_and_purge.sql`、`supabase/migrations/20261106000500_schedule_purge.cron.sql`
- Test: `tests/db/pull-purge.test.ts`

**Interfaces:**
- Consumes: Task 4、5。
- Produces:
  - `pull_changes(p_since bigint, p_limit int) returns jsonb` → `{ rows: [{ table, row }], has_more }`；`security invoker`（让 RLS 生效），对 `sync_tables` 里的每张表动态取 `rev > p_since` 的行（含回收站和墓碑），合并后按 `rev` 升序，最多 `p_limit` 行，多取一行用来判断 `has_more`。
  - `purge_expired() returns void`；`security definer`；授予 `authenticated`。

- [ ] **Step 1: 写失败的测试**

```ts
it('pull returns only the caller\'s rows after the cursor, in rev order, including trash and tombstones', async () => {
  const [a1, a2, a3] = await seed(A, 3); await seed(B, 1); await trash(A, a2); await makeTombstone(a3);
  const p = await pull(A, 0, 100);
  expect(p.rows.map(r => r.row.id).sort()).toEqual([a1, a2, a3].sort());
  const revs = p.rows.map(r => r.row.rev); expect(revs).toEqual([...revs].sort((x, y) => x - y)); expect(p.has_more).toBe(false);
  expect((await pull(A, p.rows[0].row.rev, 100)).rows).toHaveLength(2);
});
it('pull pages with has_more', async () => { await seed(A, 5); const p = await pull(A, 0, 2); expect(p.rows).toHaveLength(2); expect(p.has_more).toBe(true); });
it('purge clears content, keeps the row as a tombstone and bumps rev', async () => {
  const [id] = await seed(A, 1, { title: 'secret', note: 'n', steps: [{ id: 's', text: 't', done: false }] }); await trashAt(id, 31);
  const before = await revOf(id); await purgeAsCron();
  expect(await rowOf(id)).toMatchObject({ title: '', note: '', steps: [], purged_at: expect.anything() }); expect(await revOf(id)).toBeGreaterThan(before);
});
it('purge leaves rows trashed less than 30 days ago and live rows alone', async () => {
  const [a, b] = await seed(A, 2); await trashAt(a, 29); await purgeAsCron();
  expect((await rowOf(a)).purged_at).toBeNull(); expect((await rowOf(b)).title).not.toBe('');
});
it('purge removes applied_ops older than 30 days only', async () => { await agedOp(31); await agedOp(1); await purgeAsCron(); expect(await opCount()).toBe(1); });
it('a signed-in caller only purges their own rows; cron (no uid) purges everyone\'s', async () => {
  const [a] = await seed(A, 1); const [b] = await seed(B, 1); await trashAt(a, 31); await trashAt(b, 31);
  await purgeAs(A); expect((await rowOf(a)).purged_at).not.toBeNull(); expect((await rowOf(b)).purged_at).toBeNull();
  await purgeAsCron(); expect((await rowOf(b)).purged_at).not.toBeNull();
});
it('anon cannot call pull_changes or purge_expired', async () => { await t.asRole('anon'); await expect(t.pg.query('select purge_expired()')).rejects.toThrow(/permission denied/); });
```

- [ ] **Step 2: 运行确认失败**：`npx vitest run tests/db/pull-purge.test.ts`。
- [ ] **Step 3: 写 migration。** `purge_expired` 对 `sync_tables` 里每张表：把 `deleted_at < now() - interval '30 days' and purged_at is null` 的行（`auth.uid()` 非空时再加 `user_id = auth.uid()`）更新为 `purged_at = now()`，并把每个内容列设为 `DEFAULT`（动态取列名：排除 `id`、`user_id`、`created_at`、`updated_at`、`rev`、`deleted_at`、`purged_at`）；触发器会给它们分配新的 `rev`。最后删除超过 30 天的 `applied_ops`（同样限定 `auth.uid()`）。`.cron.sql` 文件内容：`create extension if not exists pg_cron;` 加 `select cron.schedule('purge-expired', '0 3 * * *', $$select public.purge_expired()$$);`（每天 UTC 03:00）。它不在 PGlite 里执行，在 Task 17 里实测。
- [ ] **Step 4: 运行确认通过**：`npx vitest run tests/db`。
- [ ] **Step 5: 提交**

```bash
git add supabase tests/db && git commit -m "feat(db): pull_changes, purge_expired and cron schedule"
```

---

### Task 7: 同步引擎，推送一侧

**Files:**
- Create: `src/sync/cloud.ts`、`src/sync/engine.ts`、`tests/helpers/pglite-cloud.ts`、`tests/helpers/device.ts`、`tests/helpers/flaky-cloud.ts`
- Test: `tests/sync/push.test.ts`

**Interfaces:**
- Consumes: Task 2、3 的 `LocalDb`、`Repo`；Task 4–6 的 SQL。
- Produces（`cloud.ts`）：`class CloudError extends Error { kind: 'network' | 'auth' | 'unavailable' | 'rejected' }`；`interface CloudClient { push(op: PushOp): Promise<PushResult>; pull(sinceRev: number, limit: number): Promise<PullPage>; purgeExpired(): Promise<void>; importBackup(payload: BackupFile, restorePurged: boolean): Promise<ImportSummary> }`。
- Produces（`engine.ts`）：
  - `const PULL_REWIND = 100`、`PULL_PAGE = 500`
  - `interface SyncReport { outcome: 'ok' | 'offline' | 'auth_expired' | 'unavailable'; pushed: number; dropped: number; failed: number; pulled: number; conflicts: number }`
  - `interface SyncStatus { state: 'idle' | 'syncing' | 'offline' | 'auth_expired' | 'unavailable'; pending: number; failed: number; lastSyncedAt: string | null; conflicts: number }`
  - `interface SyncDeps { db: LocalDb; cloud: CloudClient; locks?: Pick<LockManager, 'request'>; pageSize?: number }`
  - `interface SyncEngine { sync(): Promise<SyncReport>; status(): SyncStatus; subscribe(fn: (s: SyncStatus) => void): () => void }`；`createSyncEngine(deps: SyncDeps): SyncEngine`
- Produces（测试替身）：`createPgliteCloud(t: TestDb, uid: string): CloudClient`（每次调用先 `asUser(uid)` 再调对应 SQL 函数，`purgeExpired` 和 `importBackup` 同样）；`createDevice(o: { name: string; cloud: CloudClient; userId: string; now?: () => Date; locks?: Pick<LockManager, 'request'>; pageSize?: number }): Promise<Device>`，其中 `Device = { db: LocalDb; repo: Repo; engine: SyncEngine; reopenFresh(): Promise<Device> }`（每个设备用独立的 IndexedDB 库名，`reopenFresh` 删库后重开，模拟清除浏览器数据）；`createFlakyCloud(inner: CloudClient): CloudClient & { failNext(kind: CloudError['kind'], times?: number): void }`（`times` 默认 1，传 0 清除之前设置的失败）。

- [ ] **Step 1: 先写测试替身**（上面三个 helper，签名如上）。
- [ ] **Step 2: 写失败的测试**（每个 `it` 前 `beforeEach` 新建 `TestDb`、云端替身和设备；`forceTitle(id, title)` 直接改写队列里该记录 insert 操作的 `fields.title`，绕过 `Repo` 的校验；`makeTombstone`、`cloudRowCount` 是绑定了当前 `t` 的包装）

```ts
it('drains the queue in order and stores the server rev', async () => {
  const r = await a.repo.create('todos', { title: 'x' });
  expect(await a.engine.sync()).toMatchObject({ outcome: 'ok', pushed: 1, failed: 0 });
  expect((await a.repo.get('todos', r.id))!.rev).toBeGreaterThan(0); expect(await a.repo.pendingCount()).toBe(0);
});
it('later queued ops on the same record get the new base_rev, so own edits never conflict', async () => {
  const r = await a.repo.create('todos', { title: 'x' }); await a.repo.update('todos', r.id, { done: true });
  expect(await a.engine.sync()).toMatchObject({ pushed: 2, conflicts: 0 });
});
it('a successful push does not overwrite newer local edits still in the queue', async () => {
  const r = await a.repo.create('todos', { title: 'x' }); await a.repo.update('todos', r.id, { title: 'y' }); await a.engine.sync();
  expect((await a.repo.get('todos', r.id))!.title).toBe('y');
});
it('a network error keeps the queue and retries the same op_id later', async () => {
  await a.repo.create('todos', { title: 'x' }); flaky.failNext('network');
  expect(await a.engine.sync()).toMatchObject({ outcome: 'offline', pushed: 0 }); expect(await a.repo.pendingCount()).toBe(1);
  expect(await a.engine.sync()).toMatchObject({ outcome: 'ok', pushed: 1 }); expect(await cloudRowCount()).toBe(1);
});
it('an auth error stops the run and keeps the queue', async () => {
  await a.repo.create('todos', { title: 'x' }); flaky.failNext('auth');
  expect(await a.engine.sync()).toMatchObject({ outcome: 'auth_expired' }); expect(await a.repo.pendingCount()).toBe(1);
  expect(a.engine.status().state).toBe('auth_expired');
});
it('an unavailable cloud reports unavailable and keeps the queue', async () => {
  await a.repo.create('todos', { title: 'x' }); flaky.failNext('unavailable');
  expect(await a.engine.sync()).toMatchObject({ outcome: 'unavailable' }); expect(await a.repo.pendingCount()).toBe(1);
});
it('a rejected op moves to the failed list and does not block later ops', async () => {
  const bad = await a.repo.create('todos', { title: 'x' }); await forceTitle(bad.id, ''); await a.repo.create('todos', { title: 'ok' });
  expect(await a.engine.sync()).toMatchObject({ pushed: 1, failed: 1 }); expect(await a.repo.failedOps()).toHaveLength(1);
  expect(a.engine.status()).toMatchObject({ failed: 1, pending: 0 });
});
it('an op on a tombstone is discarded, not retried forever', async () => {
  const r = await a.repo.create('todos', { title: 'x' }); await a.engine.sync(); await makeTombstone(r.id);
  await a.repo.update('todos', r.id, { done: true });
  expect(await a.engine.sync()).toMatchObject({ dropped: 1 }); expect(await a.repo.pendingCount()).toBe(0);
});
it('concurrent sync() calls share one run', async () => {
  await a.repo.create('todos', { title: 'x' }); const spy = vi.spyOn(flaky, 'push');
  await Promise.all([a.engine.sync(), a.engine.sync()]); expect(spy).toHaveBeenCalledTimes(1);
});
it('runs inside the cross-tab lock when one is provided', async () => {
  const locks = { request: vi.fn((_n: string, cb: () => Promise<unknown>) => cb()) };
  const d = await createDevice({ name: 'locked', cloud: flaky, userId: U, locks: locks as any }); await d.engine.sync();
  expect(locks.request).toHaveBeenCalledWith('pa-sync', expect.any(Function));
});
```

- [ ] **Step 3: 运行确认失败**：`npx vitest run tests/sync/push.test.ts`。
- [ ] **Step 4: 实现 `createSyncEngine` 的推送部分**（拉取留到 Task 8，先让 `sync()` 在推送后直接返回）。要点：
  - 同一进程里单飞：已有运行时直接返回同一个 Promise；有 `locks` 时整个运行包在 `locks.request('pa-sync', ...)` 里。
  - 按 `seq` 顺序取非失败的操作逐条 `cloud.push`；成功后在**同一个 IndexedDB 事务**里删掉这条队列项，并把后续属于同一 `id` 的队列项的 `base_rev` 改成返回的 `rev`。
  - 本机记录：若这条记录已没有待推送的操作，用返回的 `record` 整体替换；若还有，只更新 `rev`、`updated_at`、`deleted_at`、`purged_at`，不动内容列。
  - `dropped_trashed` 与 `dropped_purged`：删掉这条操作，`dropped` 加一；`dropped_purged` 时把本机记录改成墓碑（清空内容、写入 `purged_at`）。`invalid`：写入 `failed = { reason: message }`，继续下一条。
  - `CloudError` 的 `network` 对应 `offline`，`auth` 对应 `auth_expired`，`unavailable` 对应 `unavailable`：立刻停止本次运行，队列保持原样；`rejected` 当作 `invalid` 处理。`status()` 和 `subscribe` 反映最新状态和待推送、失败数量。
- [ ] **Step 5: 运行确认通过**：同上命令，然后提交：

```bash
git add src/sync tests/sync tests/helpers && git commit -m "feat(sync): push side of the sync engine"
```

---

### Task 8: 同步引擎，拉取一侧与多设备收敛

**Files:**
- Modify: `src/sync/engine.ts`
- Test: `tests/sync/pull.test.ts`、`tests/sync/convergence.test.ts`

**Interfaces:**
- Consumes: Task 7 的引擎、`createPgliteCloud`、`createDevice`、`createFlakyCloud`。
- Produces: `sync()` 现在在推送成功后继续拉取：`since = max(0, cursor - PULL_REWIND)`，逐页取到 `has_more` 为 false；每页在**一个 IndexedDB 事务**里应用记录并把 `cursor` 更新为已见到的最大 `rev`；`SyncReport.pulled` 为实际应用的行数。

- [ ] **Step 1: 写失败的测试**

```ts
// tests/sync/pull.test.ts
it('applies rows with a higher rev and ignores equal or lower ones', async () => {
  await b.repo.create('todos', { title: 'x' }); await b.engine.sync(); expect(await a.engine.sync()).toMatchObject({ pulled: 1 });
  expect(await a.engine.sync()).toMatchObject({ pulled: 0 });
});
it('rewinds the cursor by 100 and re-applies nothing twice', async () => {
  await seedAndSync(b, 3); await a.engine.sync(); const c = await a.db.getMeta<number>('cursor');
  expect(await a.engine.sync()).toMatchObject({ pulled: 0 }); expect(await a.db.getMeta('cursor')).toBe(c);
});
it('walks through all pages', async () => {
  const small = await createDevice({ name: 'small', cloud, userId: U, pageSize: 2 }); await seedAndSync(b, 5);
  expect(await small.engine.sync()).toMatchObject({ pulled: 5 }); expect(await small.repo.list('todos')).toHaveLength(5);
});
it('a pulled tombstone removes the record from every list', async () => {
  const r = await b.repo.create('todos', { title: 'x' }); await b.engine.sync(); await a.engine.sync(); await makeTombstone(r.id); await a.engine.sync();
  expect(await a.repo.get('todos', r.id)).toBeUndefined(); expect(await a.repo.list('todos', { trashed: true })).toHaveLength(0);
});
it('a fresh install creates db_id, downloads everything and sets the cursor', async () => {
  await seedAndSync(b, 3); const fresh = await createDevice({ name: 'fresh', cloud, userId: U });
  expect(await fresh.engine.sync()).toMatchObject({ pulled: 3 }); expect(await fresh.db.getMeta<number>('cursor')).toBeGreaterThan(0);
});
it('a local edit made while a sync is running stays visible on top of the pulled server row', async () => {
  const r = await b.repo.create('todos', { title: 'x' }); await b.engine.sync();
  let hook: (() => Promise<unknown>) | undefined;
  const hooked: CloudClient = { ...cloud, pull: async (s, l) => { await hook?.(); return cloud.pull(s, l); } };
  const h = await createDevice({ name: 'hooked', cloud: hooked, userId: U }); await h.engine.sync();
  await b.repo.update('todos', r.id, { done: true }); await b.engine.sync();
  hook = () => h.repo.update('todos', r.id, { title: 'mine' });
  await h.engine.sync();
  expect(await h.repo.get('todos', r.id)).toMatchObject({ title: 'mine', done: true });
});
// tests/sync/convergence.test.ts
it('clearing browser data never deletes anything in the cloud', async () => {
  await seedAndSync(a, 3); const before = await cloudRowCount(); const fresh = await a.reopenFresh(); await fresh.engine.sync();
  expect(await cloudRowCount()).toBe(before); expect(await fresh.repo.list('todos')).toHaveLength(3);
});
it('edits to different fields on two devices both survive and both devices converge', async () => {
  const r = await a.repo.create('todos', { title: 'x' }); await a.engine.sync(); await b.engine.sync();
  await a.repo.update('todos', r.id, { title: 'A title' }); await b.repo.update('todos', r.id, { done: true });
  await a.engine.sync(); await b.engine.sync(); await a.engine.sync();
  expect(await a.repo.get('todos', r.id)).toMatchObject({ title: 'A title', done: true }); expect(await snapshot(a)).toEqual(await snapshot(b));
});
it('deleting on one device beats an offline edit on the other', async () => {
  const r = await a.repo.create('todos', { title: 'x' }); await a.engine.sync(); await b.engine.sync();
  await a.repo.remove('todos', r.id); await a.engine.sync(); await b.repo.update('todos', r.id, { title: 'late' });
  expect(await b.engine.sync()).toMatchObject({ dropped: 1 }); expect(await b.repo.list('todos', { trashed: true })).toHaveLength(1);
});
it('offline writes replay in order after reconnecting', async () => {
  flakyA.failNext('network', 99); const r = await a.repo.create('todos', { title: 'x' }); await a.repo.update('todos', r.id, { done: true }); await a.engine.sync();
  flakyA.failNext('network', 0); await a.engine.sync(); await b.engine.sync();
  expect(await b.repo.get('todos', r.id)).toMatchObject({ title: 'x', done: true });
});
it('a wrong device clock does not affect server timestamps or rev order', async () => {
  const skewed = await createDevice({ name: 'skew', cloud, userId: U, now: () => new Date('2036-01-01T00:00:00Z') });
  await skewed.repo.create('todos', { title: 'x' }); await skewed.engine.sync(); const [row] = await cloudRows();
  expect(new Date(row.updated_at).getFullYear()).toBeLessThan(2036);
});
```

- [ ] **Step 2: 运行确认失败**：`npx vitest run tests/sync`，预期新增测试失败。
- [ ] **Step 3: 实现拉取。** 应用规则：收到的行 `rev` 必须大于本机那条才应用；本机没有这条记录时直接写入（墓碑也写，保持 `purged_at`）；本机记录还有未失败的待推送操作时，把这些操作的 `fields` 按顺序叠在服务器行之上再写入，且**不改这些操作的 `base_rev`**；若收到的是墓碑，则连同这条记录的待推送操作一起丢弃。本机数据库为空时不产生任何删除操作。`conflicts` 在推送返回 `conflict: true` 时累加。
- [ ] **Step 4: 运行确认通过**：`npx vitest run tests/sync`。
- [ ] **Step 5: 提交**

```bash
git add src/sync tests/sync && git commit -m "feat(sync): pull side, tombstones and multi-device convergence"
```

---

### Task 9: 同步触发时机与持久化存储申请

**Files:**
- Create: `src/sync/triggers.ts`、`src/data/persist.ts`
- Test: `tests/sync/triggers.test.ts`、`tests/data/persist.test.ts`

**Interfaces:**
- Consumes: `SyncEngine`、`Repo.onChange`、`CloudClient.purgeExpired`。
- Produces:
  - `nextRetryDelay(failures: number): number`（`min(2000 * 2^failures, 300000)`）
  - `startSyncTriggers(d: { engine: SyncEngine; repo: Pick<Repo, 'onChange'>; win?: Pick<Window, 'addEventListener' | 'removeEventListener'>; doc?: Pick<Document, 'addEventListener' | 'removeEventListener'> & { visibilityState: string }; debounceMs?: number; purgeOnStart?: CloudClient }): () => void`，返回停止函数。
  - `requestPersistentStorage(s?: Pick<StorageManager, 'persist' | 'persisted'>): Promise<boolean>`

- [ ] **Step 1: 写失败的测试**（用 `vi.useFakeTimers()`）

```ts
it('syncs once at start', () => { start(); expect(engine.sync).toHaveBeenCalledTimes(1); });
it('debounces writes by 2000 ms into one sync', async () => {
  start(); engine.sync.mockClear(); fireChange(); await vi.advanceTimersByTimeAsync(1000); fireChange(); await vi.advanceTimersByTimeAsync(1999);
  expect(engine.sync).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(1); expect(engine.sync).toHaveBeenCalledTimes(1);
});
it('syncs when the page becomes visible and when the network returns', () => {
  start(); engine.sync.mockClear(); doc.visibilityState = 'visible'; doc.fire('visibilitychange'); win.fire('online'); expect(engine.sync).toHaveBeenCalledTimes(2);
});
it('retries with growing delays after offline or unavailable runs', async () => {
  engine.sync.mockResolvedValue({ outcome: 'offline' }); start(); await vi.advanceTimersByTimeAsync(0); engine.sync.mockClear();
  await vi.advanceTimersByTimeAsync(2000); expect(engine.sync).toHaveBeenCalledTimes(1); await vi.advanceTimersByTimeAsync(4000); expect(engine.sync).toHaveBeenCalledTimes(2);
});
it('nextRetryDelay doubles from 2000 and caps at 300000', () => { expect([0, 1, 2].map(nextRetryDelay)).toEqual([2000, 4000, 8000]); expect(nextRetryDelay(50)).toBe(300000); });
it('purges once after the first successful sync when purgeOnStart is set, ignoring errors', async () => {
  cloud.purgeExpired.mockRejectedValue(new Error('x')); engine.sync.mockResolvedValue({ outcome: 'ok' }); start({ purgeOnStart: cloud });
  await vi.advanceTimersByTimeAsync(0); expect(cloud.purgeExpired).toHaveBeenCalledTimes(1);
});
it('stop removes every listener', () => { const stop = start(); stop(); expect(win.listeners('online')).toBe(0); });
// tests/data/persist.test.ts
it('returns true without asking when storage is already persisted', async () => expect(await requestPersistentStorage({ persisted: async () => true, persist: fail })).toBe(true));
it('asks for persistence otherwise and returns the answer', async () => expect(await requestPersistentStorage({ persisted: async () => false, persist: async () => false })).toBe(false));
it('returns false when the API throws or is missing', async () => { expect(await requestPersistentStorage({ persisted: async () => { throw 1; }, persist: fail })).toBe(false); expect(await requestPersistentStorage(undefined)).toBe(false); });
```

- [ ] **Step 2: 运行确认失败**：`npx vitest run tests/sync/triggers.test.ts tests/data/persist.test.ts`。
- [ ] **Step 3: 实现两个模块。** 触发：启动时同步一次；`repo.onChange` 防抖（默认 2000 ms）；`visibilitychange` 变为 `visible` 和 `online` 事件各触发一次；一次同步结果为 `offline` 或 `unavailable` 时按 `nextRetryDelay(连续失败次数)` 安排重试，成功后清零；`purgeOnStart` 有值时在首次 `ok` 之后调用一次 `purgeExpired()` 并吞掉错误。
- [ ] **Step 4: 运行确认通过**：同上命令。
- [ ] **Step 5: 提交**

```bash
git add src/sync/triggers.ts src/data/persist.ts tests && git commit -m "feat: sync triggers and persistent storage request"
```

---

### Task 10: Supabase 云端客户端与错误分类

**Files:**
- Create: `src/sync/supabase-cloud.ts`、`src/supabase.ts`
- Test: `tests/sync/supabase-cloud.test.ts`

**Interfaces:**
- Consumes: `CloudClient`、`CloudError`。
- Produces: `mapSupabaseError(e: unknown): CloudError`；`createSupabaseCloud(client: Pick<SupabaseClient, 'rpc'>): CloudClient`；`getSupabase(): SupabaseClient`（读 `VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY`，缺失时抛明确错误）。RPC 名与参数：`push_change({ p_table, p_op })`、`pull_changes({ p_since, p_limit })`、`purge_expired()`、`import_backup({ p_payload, p_restore_purged })`。

- [ ] **Step 1: 写失败的测试**

```ts
it('maps fetch failures to network', () => expect(mapSupabaseError(new TypeError('Failed to fetch')).kind).toBe('network'));
it('maps 401 and PGRST301/303 to auth', () => {
  expect(mapSupabaseError({ status: 401 }).kind).toBe('auth'); expect(mapSupabaseError({ code: 'PGRST301' }).kind).toBe('auth'); expect(mapSupabaseError({ code: 'PGRST303' }).kind).toBe('auth');
});
it('maps 5xx and paused-project responses to unavailable', () => {
  expect(mapSupabaseError({ status: 503 }).kind).toBe('unavailable'); expect(mapSupabaseError({ status: 500 }).kind).toBe('unavailable');
});
it('maps Postgres data errors (23xxx) and other 4xx to rejected', () => {
  expect(mapSupabaseError({ code: '23514' }).kind).toBe('rejected'); expect(mapSupabaseError({ status: 400 }).kind).toBe('rejected');
});
it('push calls the rpc with the table and op and returns the data', async () => {
  const rpc = vi.fn().mockResolvedValue({ data: { status: 'applied', conflict: false, rev: 3, record: {}, message: null }, error: null });
  const r = await createSupabaseCloud({ rpc } as any).push(op);
  expect(rpc).toHaveBeenCalledWith('push_change', { p_table: 'todos', p_op: { op_id: op.op_id, id: op.id, kind: op.kind, base_rev: op.base_rev, fields: op.fields } }); expect(r.rev).toBe(3);
});
it('pull, purgeExpired and importBackup use the agreed rpc names and arguments', async () => {
  const rpc = vi.fn().mockResolvedValue({ data: { rows: [], has_more: false }, error: null }); const c = createSupabaseCloud({ rpc } as any);
  await c.pull(5, 10); expect(rpc).toHaveBeenLastCalledWith('pull_changes', { p_since: 5, p_limit: 10 });
  await c.purgeExpired(); expect(rpc).toHaveBeenLastCalledWith('purge_expired');
  await c.importBackup(backup, true); expect(rpc).toHaveBeenLastCalledWith('import_backup', { p_payload: backup, p_restore_purged: true });
});
it('an rpc error is thrown as a CloudError', async () => {
  const rpc = vi.fn().mockResolvedValue({ data: null, error: { status: 401, message: 'JWT expired' } });
  await expect(createSupabaseCloud({ rpc } as any).pull(0, 10)).rejects.toMatchObject({ kind: 'auth' });
});
```

- [ ] **Step 2: 运行确认失败**：`npx vitest run tests/sync/supabase-cloud.test.ts`。
- [ ] **Step 3: 实现。** `mapSupabaseError` 的判断顺序：`TypeError` 或没有 `status` 且消息含 `fetch`/`network` → `network`；`status === 401` 或 `code` 为 `PGRST301`、`PGRST303` → `auth`；`status >= 500` 或消息含 `paused` → `unavailable`；其余 `rejected`。RPC 返回的 `error` 一律经它转成 `CloudError` 抛出。
- [ ] **Step 4: 运行确认通过**：同上命令。
- [ ] **Step 5: 提交**

```bash
git add src/sync/supabase-cloud.ts src/supabase.ts tests/sync && git commit -m "feat(sync): Supabase cloud client and error classification"
```

---

### Task 11: JSON 完整备份与导出提醒

**Files:**
- Create: `src/backup/export-json.ts`、`src/backup/reminder.ts`
- Test: `tests/backup/export-json.test.ts`、`tests/backup/reminder.test.ts`

**Interfaces:**
- Consumes: `LocalDb`、`BackupFile`、`BACKUP_FORMAT`、`BACKUP_VERSION`、`BACKUP_TABLE_KEYS`。
- Produces: `buildBackup(db: LocalDb, now?: () => Date): Promise<BackupFile>`；`EXPORT_REMINDER_DAYS = 7`；`shouldRemindExport(lastExportAt: string | null, now: Date): boolean`；`recordExport(db: LocalDb, now?: () => Date): Promise<void>`（写入元数据 `last_export_at`）。

- [ ] **Step 1: 写失败的测试**

```ts
it('exports format, version and exported_at', async () => {
  const f = await buildBackup(db, () => new Date('2026-11-05T00:00:00Z'));
  expect(f).toMatchObject({ format: 'productivity-app-export', version: 1, exported_at: '2026-11-05T00:00:00.000Z' });
});
it('includes trashed records, excludes tombstones, and strips server-managed fields', async () => {
  const live = await repo.create('todos', { title: 'a' }); const gone = await repo.create('todos', { title: 'b' }); await repo.remove('todos', gone.id);
  const dead = await repo.create('todos', { title: 'c' }); await makeTombstone(dead.id);
  const f = await buildBackup(db); expect(f.tables.todos.map(r => r.id).sort()).toEqual([live.id, gone.id].sort());
  for (const r of f.tables.todos) { expect(r).not.toHaveProperty('user_id'); expect(r).not.toHaveProperty('rev'); expect(r).not.toHaveProperty('purged_at'); }
  expect(f.tables.todos.find(r => r.id === gone.id)!.deleted_at).not.toBeNull();
});
it('has an empty array for every table that does not exist yet', async () => {
  const f = await buildBackup(db); for (const k of ['events', 'event_overrides', 'notes', 'journal'] as const) expect(f.tables[k]).toEqual([]);
});
// reminder.test.ts
it('reminds when never exported', () => expect(shouldRemindExport(null, NOW)).toBe(true));
it('does not remind at exactly 7 days but does after', () => {
  expect(shouldRemindExport('2026-10-29T00:00:00Z', new Date('2026-11-05T00:00:00Z'))).toBe(false);
  expect(shouldRemindExport('2026-10-29T00:00:00Z', new Date('2026-11-05T00:00:01Z'))).toBe(true);
});
it('recordExport stores last_export_at', async () => { await recordExport(db, () => new Date('2026-11-05T00:00:00Z')); expect(await db.getMeta('last_export_at')).toBe('2026-11-05T00:00:00.000Z'); });
```

- [ ] **Step 2: 运行确认失败**：`npx vitest run tests/backup`。
- [ ] **Step 3: 实现。** `buildBackup` 读本机各表，去掉 `purged_at` 非空的行，再从每条记录里删掉 `user_id`、`rev`、`purged_at`；`BACKUP_TABLE_KEYS` 里没有对应表的键填 `[]`。
- [ ] **Step 4: 运行确认通过**：同上命令。
- [ ] **Step 5: 提交**

```bash
git add src/backup tests/backup && git commit -m "feat(backup): JSON export and export reminder"
```

---

### Task 12: 备份文件整体校验

**Files:**
- Create: `src/backup/validate.ts`
- Test: `tests/backup/validate.test.ts`

**Interfaces:**
- Consumes: `BackupFile`、`isUuid`、`BACKUP_FORMAT`、`BACKUP_VERSION`。
- Produces: `type ValidationResult = { ok: true; backup: BackupFile } | { ok: false; errors: string[] }`；`validateBackup(input: unknown): ValidationResult`；`parseAndValidateBackup(text: string): ValidationResult`；`const MAX_VALIDATION_ERRORS = 20`；`const REFERENCES: Record<string, Record<string, string>> = {}`（子表列到父表的引用，阶段 3 加入 `event_overrides`）。

- [ ] **Step 1: 写失败的测试**

```ts
it('accepts a valid file', () => expect(validateBackup(valid())).toMatchObject({ ok: true }));
it('rejects a wrong format and an unsupported version', () => {
  expect(validateBackup({ ...valid(), format: 'x' })).toMatchObject({ ok: false });
  expect(validateBackup({ ...valid(), version: 2 })).toMatchObject({ ok: false, errors: [expect.stringContaining('version')] });
});
it('rejects ids that are not UUIDs, wrong field types, and missing required fields', () => {
  expect(validateBackup(withTodo({ id: '123' }))).toMatchObject({ ok: false });
  expect(validateBackup(withTodo({ done: 'yes' }))).toMatchObject({ ok: false });
  expect(validateBackup(withTodo({ title: '' }))).toMatchObject({ ok: false });
  expect(validateBackup(withTodo({ due_date: '2026/11/05' }))).toMatchObject({ ok: false });
});
it('rejects duplicate ids inside one file', () => { const t = todo(); expect(validateBackup(withTodos([t, t]))).toMatchObject({ ok: false, errors: [expect.stringContaining('duplicate')] }); });
it('rejects tables that have rows but are not supported yet, and accepts empty ones', () => {
  expect(validateBackup({ ...valid(), tables: { ...valid().tables, events: [{}] } })).toMatchObject({ ok: false });
  expect(validateBackup(valid())).toMatchObject({ ok: true });
});
it('rejects text that is not JSON with a readable message', () => expect(parseAndValidateBackup('<html>')).toMatchObject({ ok: false, errors: [expect.stringContaining('JSON')] }));
it('rejects a non-object top level', () => { for (const x of [null, 5, 'a', []]) expect(validateBackup(x)).toMatchObject({ ok: false }); });
it('caps the error list at 20 for a file full of bad rows', () => {
  const r = validateBackup(withTodos(Array.from({ length: 100 }, () => ({ ...todo(), id: 'bad' })))); expect(r.ok).toBe(false); expect((r as any).errors).toHaveLength(MAX_VALIDATION_ERRORS);
});
it('one bad row rejects the whole file', () => expect(validateBackup(withTodos([todo(), { ...todo(), priority: 'urgent' }]))).toMatchObject({ ok: false }));
```

- [ ] **Step 2: 运行确认失败**：`npx vitest run tests/backup/validate.test.ts`。
- [ ] **Step 3: 实现。** 用 zod 为 `todos` 的一条导出记录写 schema（字段与 Task 2 的 `TodoFields` 加 `id`、`created_at`、`updated_at`、`deleted_at` 对应，日期字段严格校验格式）；顶层先查 `format`、`version`，再逐表校验，有行但不支持的表（`events`、`event_overrides`、`notes`、`journal`）整体报错；用 `REFERENCES` 检查引用（阶段 1 为空表，保留遍历逻辑）；错误累计到 `MAX_VALIDATION_ERRORS` 就截断。
- [ ] **Step 4: 运行确认通过**：同上命令。
- [ ] **Step 5: 提交**

```bash
git add src/backup/validate.ts tests/backup && git commit -m "feat(backup): whole-file backup validation"
```

---

### Task 13: 服务器函数 `import_backup` 与导入服务

**Files:**
- Create: `supabase/migrations/20261106000400_import_backup.sql`、`src/backup/import.ts`
- Test: `tests/db/import-backup.test.ts`、`tests/backup/import.test.ts`

**Interfaces:**
- Consumes: Task 4–6 的 SQL、Task 11–12 的备份与校验、Task 7 的测试替身。
- Produces:
  - SQL：`import_backup(p_payload jsonb, p_restore_purged boolean) returns jsonb`，返回 `{ added, restored, skipped }`（`skipped` 为按原因（`exists`、`purged`）计数的对象）；`security definer`，只授予 `authenticated`。
  - `type ImportResult = { ok: true; summary: ImportSummary } | { ok: false; errors: string[] }`；`importBackup(cloud: CloudClient, text: string, o: { restorePurged: boolean }): Promise<ImportResult>`。

- [ ] **Step 1: 写失败的测试**

```ts
// tests/db/import-backup.test.ts
it('adds new rows keeping created_at, updated_at and trash state, with a new rev', async () => {
  const r = await imp(A, [row({ id: id1, created_at: '2025-01-01T00:00:00Z', updated_at: '2025-02-02T00:00:00Z', deleted_at: '2025-03-03T00:00:00Z' })], false);
  expect(r).toMatchObject({ added: 1, restored: 0 }); expect(await rowOf(id1)).toMatchObject({ updated_at: new Date('2025-02-02T00:00:00Z'), deleted_at: new Date('2025-03-03T00:00:00Z') });
  expect(await revOf(id1)).toBeGreaterThan(0);
});
it('skips ids that already exist with their content', async () => {
  await seedRow(id1, 'keep'); const r = await imp(A, [row({ id: id1, title: 'other' })], false);
  expect(r.skipped).toEqual({ exists: 1 }); expect((await rowOf(id1)).title).toBe('keep');
});
it('skips tombstones by default', async () => { await seedRow(id1, 'x'); await makeTombstone(id1); const r = await imp(A, [row({ id: id1, title: 'old' })], false); expect(r.skipped).toEqual({ purged: 1 }); expect((await rowOf(id1)).purged_at).not.toBeNull(); });
it('restores tombstones when asked: content back, purged_at cleared, rev bumped', async () => {
  await seedRow(id1, 'x'); await makeTombstone(id1); const before = await revOf(id1);
  const r = await imp(A, [row({ id: id1, title: 'old', note: 'n' })], true);
  expect(r).toMatchObject({ restored: 1 }); expect(await rowOf(id1)).toMatchObject({ title: 'old', note: 'n', purged_at: null }); expect(await revOf(id1)).toBeGreaterThan(before);
});
it('a restored record that was in the trash gets a fresh deleted_at so the next purge keeps it', async () => {
  await seedRow(id1, 'x'); await makeTombstone(id1);
  await imp(A, [row({ id: id1, title: 'old', deleted_at: '2025-01-01T00:00:00Z' })], true); await purgeAsCron();
  expect((await rowOf(id1)).purged_at).toBeNull(); expect(Date.now() - (await rowOf(id1)).deleted_at.getTime()).toBeLessThan(60_000);
});
it('one invalid row aborts the whole import', async () => {
  await expect(imp(A, [row({ id: id1 }), row({ id: id2, title: '' })], false)).rejects.toThrow(); expect(await count(A)).toBe(0);
});
it('rows always belong to the caller', async () => { await imp(A, [row({ id: id1, user_id: B })], false); expect(await count(B)).toBe(0); expect(await count(A)).toBe(1); });
it('anon cannot call import_backup', async () => { await t.asRole('anon'); await expect(t.pg.query(`select import_backup('{}', false)`)).rejects.toThrow(/permission denied/); });
// tests/backup/import.test.ts
it('returns validation errors and never calls the cloud for a bad file', async () => {
  const spy = vi.spyOn(cloud, 'importBackup'); expect(await importBackup(cloud, '<html>', { restorePurged: false })).toMatchObject({ ok: false }); expect(spy).not.toHaveBeenCalled();
});
it('round trip: export from one device, import into an empty account, sync another device, get identical data', async () => {
  const a = await device('a', cloudA); await a.repo.create('todos', { title: 'one' }); const t2 = await a.repo.create('todos', { title: 'two', priority: 'high' }); await a.repo.remove('todos', t2.id); await a.engine.sync();
  const text = JSON.stringify(await buildBackup(a.db)); const res = await importBackup(cloudB, text, { restorePurged: false });
  expect(res).toMatchObject({ ok: true, summary: { added: 2 } }); const c = await device('c', cloudB); await c.engine.sync();
  expect(await exportable(c)).toEqual(await exportable(a));
});
it('importing the same file twice skips everything the second time', async () => {
  await importBackup(cloudB, text, { restorePurged: false }); const r = await importBackup(cloudB, text, { restorePurged: false });
  expect(r).toMatchObject({ ok: true, summary: { added: 0, skipped: { exists: 2 } } });
});
```

- [ ] **Step 2: 运行确认失败**：`npx vitest run tests/db/import-backup.test.ts tests/backup/import.test.ts`。
- [ ] **Step 3: 写 migration 与服务。** SQL：开头 `perform set_config('app.keep_updated_at', 'on', true)`（只对本事务有效，让触发器保留文件里的 `updated_at`）；对 `sync_tables` 里的每张表，逐行处理 `p_payload -> 'tables' -> 表名`（测试里的 `imp(uid, rows, restore)` 把行包装成 `{ tables: { todos: rows } }` 再调用函数）：行不存在则只插入文件里出现的列并把 `user_id` 强制成 `auth.uid()`，`deleted_at` 照原样；行存在且 `purged_at` 为空则计入 `skipped.exists`；行存在且是墓碑：`p_restore_purged` 为 false 计入 `skipped.purged`，为 true 则写回内容、`purged_at = null`、`deleted_at` 在文件里非空时置为 `now()`（否则为空），计入 `restored`。任何一行违反约束就让整个函数抛错回滚。`importBackup` 服务：先 `parseAndValidateBackup`，失败返回 `{ ok: false, errors }`；成功调用 `cloud.importBackup(backup, o.restorePurged)`。
- [ ] **Step 4: 运行确认通过**：`npx vitest run tests/db tests/backup`。
- [ ] **Step 5: 提交**

```bash
git add supabase src/backup tests && git commit -m "feat(backup): import_backup function and import service"
```

---

### Task 14: Markdown 压缩包导出

**Files:**
- Create: `src/backup/export-markdown.ts`
- Test: `tests/backup/export-markdown.test.ts`

**Interfaces:**
- Produces: `interface NoteLike { id: string; kind: 'memo' | 'note'; title: string; body: string; created_at: string; labels: string[]; pinned: boolean; color: string | null; deleted_at: string | null }`；`interface JournalLike { date: string; body: string; deleted_at: string | null }`；`buildMarkdownZip(data: { notes: NoteLike[]; journal: JournalLike[] }, scope: 'all' | 'journal'): Uint8Array`（用 fflate 的 `zipSync`）。
- 文件布局：`notes/<id 前 8 位>-<净化后的标题，最多 40 个字符>.md`（标题为空时只用 id 前 8 位；净化指把 `/ \ : * ? " < > |` 和控制字符替换成 `-`），开头是 front matter（`id`、`created_at`、`labels`、`pinned`、`color`）；`journal/YYYY-MM-DD.md`；`memos.md` 里每条备忘一行，换行替换成空格。只含 `deleted_at` 为空的内容。`scope` 为 `journal` 时只有 `journal/`。

- [ ] **Step 1: 写失败的测试**（用 fflate 的 `unzipSync` 读回）

```ts
it('writes notes with front matter, journal by date and memos on one line each', () => {
  const files = unzip(buildMarkdownZip({ notes: [note({ id: 'abcdef12-0000-4000-8000-000000000000', kind: 'note', title: 'Plan', body: 'hello', labels: ['a'], pinned: true })], journal: [{ date: '2026-11-05', body: 'dear diary', deleted_at: null }] }, 'all'));
  expect(Object.keys(files).sort()).toEqual(['journal/2026-11-05.md', 'notes/abcdef12-Plan.md']);
  expect(files['notes/abcdef12-Plan.md']).toMatch(/^---\nid: abcdef12-0000-4000-8000-000000000000\n[\s\S]*pinned: true\n[\s\S]*---\n\nhello/);
});
it('merges memos into memos.md, one line each', () => {
  const files = unzip(buildMarkdownZip({ notes: [note({ kind: 'memo', body: 'a\nb' }), note({ kind: 'memo', body: 'c' })], journal: [] }, 'all'));
  expect(files['memos.md'].trim().split('\n')).toEqual(['- a b', '- c']);
});
it('journal scope contains only journal files', () => expect(Object.keys(unzip(buildMarkdownZip({ notes: [note({ kind: 'note' })], journal: [j('2026-11-05')] }, 'journal')))).toEqual(['journal/2026-11-05.md']));
it('leaves out trashed content', () => expect(Object.keys(unzip(buildMarkdownZip({ notes: [note({ kind: 'note', deleted_at: 'x' })], journal: [j('2026-11-05', 'x')] }, 'all')))).toEqual([]));
it('sanitises titles for file names', () => expect(Object.keys(unzip(buildMarkdownZip({ notes: [note({ id: 'abcdef12-0', kind: 'note', title: 'a/b?c' })], journal: [] }, 'all')))).toEqual(['notes/abcdef12-a-b-c.md']));
```

- [ ] **Step 2: 运行确认失败**：`npx vitest run tests/backup/export-markdown.test.ts`。
- [ ] **Step 3: 按上面的布局实现。**
- [ ] **Step 4: 运行确认通过**：同上命令。
- [ ] **Step 5: 提交**

```bash
git add src/backup/export-markdown.ts tests/backup && git commit -m "feat(backup): Markdown zip export"
```

---

### Task 15: 应用外壳、登录与同步状态

**Files:**
- Create: `src/auth/auth.ts`、`src/app/services.ts`、`src/ui/App.tsx`（替换占位）、`src/ui/LoginPage.tsx`、`src/ui/Shell.tsx`、`src/ui/SyncBanner.tsx`、`src/ui/UpdatePrompt.tsx`、`src/ui/TodosTemp.tsx`、`src/ui/UnavailableScreen.tsx`、`src/ui/styles.css`、`tests/helpers/fake-auth.ts`
- Modify: `src/main.tsx`
- Test: `tests/ui/*.test.tsx`（每个文件首行 `// @vitest-environment jsdom`）

**Interfaces:**
- Consumes: `createRepo`、`createSyncEngine`、`createSupabaseCloud`、`startSyncTriggers`、`requestPersistentStorage`、`openLocalDb`、`LocalDbUnavailableError`。
- Produces:
  - `type SignInResult = { ok: true } | { ok: false; reason: 'invalid_credentials' | 'network' | 'unknown' }`
  - `interface AuthApi { signIn(email: string, password: string): Promise<SignInResult>; signOut(): Promise<void>; getUserId(): string | null; onSessionChange(fn: (s: { userId: string | null; expired: boolean }) => void): () => void }`；`createSupabaseAuth(client: SupabaseClient): AuthApi`
  - `interface Services { db: LocalDb; repo: Repo; cloud: CloudClient; engine: SyncEngine; auth: AuthApi }`；`createServices(env: ImportMetaEnv): Promise<Services>`（`openLocalDb` 抛 `LocalDbUnavailableError` 时原样抛出；`VITE_PURGE_ON_START === 'true'` 时把云端传给 `startSyncTriggers` 的 `purgeOnStart`）
  - 组件属性：`Root()`（`src/ui/App.tsx` 导出，调用 `createServices(import.meta.env)`，成功则渲染 `App`，失败按错误类型显示 `UnavailableScreen` 或通用错误）；`App({ services })`；`LoginPage({ auth, expired })`；`Shell({ services, confirmFn?: (msg: string) => boolean })`；`SyncBanner({ status })`；`TodosTemp({ repo })`（写入失败时显示「保存失败」）；`UnavailableScreen()`；`UpdatePrompt()` 用 `useRegisterSW`（`virtual:pwa-register/react`）。
  - `tests/helpers/fake-auth.ts`：`createFakeAuth(initialUserId?: string | null): AuthApi & { expire(): void; setSignInResult(r: SignInResult): void }`。

- [ ] **Step 1: 写失败的测试**

```tsx
it('shows the login page when there is no session', async () => {
  render(<App services={{ ...services, auth: createFakeAuth(null) }} />);
  expect(await screen.findByLabelText('邮箱')).toBeInTheDocument(); expect(screen.getByLabelText('密码')).toBeInTheDocument();
});
it('shows distinct messages for wrong credentials, network failure and unknown errors', async () => {
  for (const [reason, text] of [['invalid_credentials', '邮箱或密码不对'], ['network', '网络连接失败，请检查网络后重试'], ['unknown', '登录失败，请稍后再试']] as const) {
    auth.setSignInResult({ ok: false, reason }); await submitLogin(); expect(await screen.findByText(text)).toBeInTheDocument();
  }
});
it('session expiry returns to login with a notice and keeps the unsynced queue', async () => {
  await repo.create('todos', { title: 'x' }); auth.expire();
  expect(await screen.findByText(/登录已过期.*未同步的改动已保留/)).toBeInTheDocument(); expect(await repo.pendingCount()).toBe(1);
});
it('sign-out with pending changes asks first and cancelling keeps the session', async () => {
  await repo.create('todos', { title: 'x' }); const confirmFn = vi.fn(() => false); renderShell({ confirmFn }); await userEvent.click(screen.getByText('退出登录'));
  expect(confirmFn).toHaveBeenCalledWith(expect.stringContaining('1')); expect(auth.getUserId()).not.toBeNull();
});
it('sign-out with nothing pending does not ask', async () => { const confirmFn = vi.fn(); renderShell({ confirmFn }); await userEvent.click(screen.getByText('退出登录')); expect(confirmFn).not.toHaveBeenCalled(); expect(auth.getUserId()).toBeNull(); });
it('shows the unavailable screen when IndexedDB is not available', async () => {
  vi.stubGlobal('indexedDB', undefined); render(<Root />); expect(await screen.findByText(/此浏览器无法保存本机数据.*无痕/)).toBeInTheDocument();
});
it('SyncBanner shows pending, offline, unavailable and failed states', () => {
  expect(renderBanner({ state: 'idle', pending: 3, failed: 0 })).toHaveTextContent('未同步 3 项'); expect(renderBanner({ state: 'offline' })).toHaveTextContent('离线');
  expect(renderBanner({ state: 'unavailable' })).toHaveTextContent('云端暂时无法连接'); expect(renderBanner({ failed: 2 })).toHaveTextContent('同步失败 2 项');
});
it('UpdatePrompt offers a reload button when a new version is waiting', async () => {
  mockSW({ needRefresh: true }); render(<UpdatePrompt />); expect(screen.getByRole('button', { name: '更新' })).toBeInTheDocument();
});
it('the temporary todo screen adds, toggles and deletes through the repo', async () => {
  render(<TodosTemp repo={repo} />); await userEvent.type(screen.getByPlaceholderText('新待办'), 'milk{enter}');
  expect(await screen.findByText('milk')).toBeInTheDocument(); expect((await repo.list('todos')).map(t => t.title)).toEqual(['milk']);
  await userEvent.click(screen.getByRole('checkbox')); expect((await repo.list('todos'))[0].done).toBe(true);
  await userEvent.click(screen.getByRole('button', { name: '删除' })); expect(await repo.list('todos')).toHaveLength(0);
});
it('shows 保存失败 when a local write fails', async () => {
  vi.spyOn(repo, 'create').mockRejectedValue(new LocalWriteError('full')); render(<TodosTemp repo={repo} />);
  await userEvent.type(screen.getByPlaceholderText('新待办'), 'milk{enter}'); expect(await screen.findByText(/保存失败/)).toBeInTheDocument();
});
it('styles switch from bottom to side navigation at 768px and enforce a 360px minimum', () => {
  const css = readFileSync('src/ui/styles.css', 'utf8'); expect(css).toMatch(/min-width:\s*360px/); expect(css).toMatch(/@media \(min-width:\s*768px\)/);
});
```

- [ ] **Step 2: 运行确认失败**：`npx vitest run tests/ui`。
- [ ] **Step 3: 实现。** `Root`：`createServices` 失败且是 `LocalDbUnavailableError` 时显示 `UnavailableScreen`（文案含「此浏览器无法保存本机数据」「无痕」）；未登录显示 `LoginPage`（会话过期时多显示「登录已过期，请重新登录，未同步的改动已保留」）；已登录显示 `Shell`。`Shell`：手机底部导航、`min-width: 768px` 起改为侧边导航，导航项为「待办」和「设置」（设置页在 Task 16 加入，这里先放占位），顶部放 `SyncBanner` 和 `UpdatePrompt`，「退出登录」在有未上传操作时先用 `confirmFn` 询问（文案含待推送数量）。`TodosTemp` 是临时的待办列表（输入框、勾选、删除，标注「临时界面，阶段 2 替换」）。`main.tsx` 在启动时调用 `requestPersistentStorage()` 和 `startSyncTriggers`。`styles.css` 满足 360px 最小宽度和 768px 断点。
- [ ] **Step 4: 运行确认通过**：`npx vitest run tests/ui`，再运行 `npm run build`。
- [ ] **Step 5: 提交**

```bash
git add src tests && git commit -m "feat(ui): app shell, login, sync banner and update prompt"
```

---

### Task 16: 设置页：导出、导入、提醒与失败列表

**Files:**
- Create: `src/ui/Settings.tsx`、`src/ui/ExportReminder.tsx`、`src/backup/save-file.ts`
- Modify: `src/ui/Shell.tsx`（把设置页接进导航，在顶部挂上 `ExportReminder`）
- Test: `tests/ui/settings.test.tsx`、`tests/backup/save-file.test.ts`

**Interfaces:**
- Consumes: `buildBackup`、`recordExport`、`shouldRemindExport`、`buildMarkdownZip`、`importBackup`、`Repo.failedOps`、`SyncEngine.sync`。
- Produces: 组件 `Settings({ services })`、`ExportReminder({ services })`；`saveFile(name: string, data: Blob, nav?: Pick<Navigator, 'canShare' | 'share'>): Promise<'shared' | 'downloaded'>`（先试系统分享面板，不可用或失败时改用 `<a download>`）；导出文件名 `productivity-app-backup-YYYY-MM-DD.json` 与 `productivity-app-markdown-YYYY-MM-DD.zip`（日期取 UTC）。

- [ ] **Step 1: 写失败的测试**

```tsx
it('export JSON syncs best-effort, saves the file with the dated name and records the export time', async () => {
  await clickText('导出完整备份');
  expect(engine.sync).toHaveBeenCalled(); expect(saveFile).toHaveBeenCalledWith('productivity-app-backup-2026-11-05.json', expect.any(Blob));
  expect(await db.getMeta('last_export_at')).toBe('2026-11-05T00:00:00.000Z');
});
it('export still works when the sync before it fails', async () => { engine.sync.mockRejectedValue(new Error('x')); await clickText('导出完整备份'); expect(saveFile).toHaveBeenCalled(); });
it('Markdown export offers all or journal only', async () => { await choose('只导出日记'); await clickText('导出 Markdown'); expect(buildMarkdownZip).toHaveBeenCalledWith(expect.anything(), 'journal'); });
it('the restore-purged checkbox is unchecked by default', () => expect(screen.getByLabelText('同时找回已被永久清除的记录')).not.toBeChecked());
it('importing a bad file lists the errors and never calls the cloud', async () => { await pickFile('{"nope":1}'); expect(await screen.findByText(/format/)).toBeInTheDocument(); expect(cloud.importBackup).not.toHaveBeenCalled(); });
it('importing a good file shows the summary with added, restored and skipped counts', async () => {
  cloud.importBackup.mockResolvedValue({ added: 2, restored: 1, skipped: { exists: 3 } }); await pickFile(goodFile()); expect(await screen.findByText(/新增 2 条.*找回 1 条.*跳过 3 条/)).toBeInTheDocument();
});
it('the reminder shows after 7 days without export and disappears after exporting', async () => {
  await db.setMeta('last_export_at', '2026-10-28T00:00:00.000Z'); render(<Shell services={services} />);
  expect(await screen.findByText(/已经 8 天没有导出备份/)).toBeInTheDocument(); await clickText('设置'); await clickText('导出完整备份');
  await waitFor(() => expect(screen.queryByText(/天没有导出备份/)).not.toBeInTheDocument());
});
it('lists failed ops with their reason', async () => {
  vi.spyOn(repo, 'failedOps').mockResolvedValue([{ seq: 1, op_id: id1, table: 'todos', id: id2, kind: 'insert', base_rev: null, fields: {}, failed: { reason: 'title cannot be empty' } }]);
  render(<Settings services={services} />); expect(await screen.findByText(/title cannot be empty/)).toBeInTheDocument();
});
// save-file.test.ts
it('uses the share sheet when files can be shared', async () => { expect(await saveFile('a.json', blob, { canShare: () => true, share: vi.fn().mockResolvedValue(undefined) })).toBe('shared'); });
it('falls back to a download when sharing is unavailable or fails', async () => { expect(await saveFile('a.json', blob, { canShare: () => false, share: vi.fn() })).toBe('downloaded'); });
```

- [ ] **Step 2: 运行确认失败**：`npx vitest run tests/ui/settings.test.tsx tests/backup/save-file.test.ts`。
- [ ] **Step 3: 实现。** 设置页有四块：「导出完整备份」（先尽力 `engine.sync()`，失败也继续；构建 JSON，`saveFile`，`recordExport`）；「导出 Markdown」（范围单选：全部、只导出日记）；「导入备份」（文件选择，勾选框「同时找回已被永久清除的记录」默认不勾，导入后显示「新增 X 条，找回 Y 条，跳过 Z 条」和按原因分组的跳过详情，或校验错误列表）；「同步失败」列表（显示每条 `failed.reason`）。`ExportReminder` 在 `shouldRemindExport` 为真时显示「已经 N 天没有导出备份」并链接到设置页。
- [ ] **Step 4: 运行确认通过**：`npx vitest run`，全部通过。
- [ ] **Step 5: 提交**

```bash
git add src tests && git commit -m "feat(ui): settings screen with export, import and reminder"
```

---

### Task 17: 部署与真机验证

**Files:**
- Create: `docs/superpowers/plans/stage1-verification.md`（把下面的检查结果记在这里并提交）、`public/_redirects`（内容 `/* /index.html 200`）

**Interfaces:**
- Consumes: 前面全部任务。
- Produces: 一个线上可用的网址；确认 Supabase Cron 在免费版是否可用（决定是否保留 `.cron.sql` 或启用 `VITE_PURGE_ON_START`）。

- [ ] **Step 1: 创建 Supabase 项目并推送数据库。** 在 Supabase 控制台新建项目；本机 `npx supabase login`、`npx supabase link --project-ref <ref>`，然后 `npx supabase db push` 应用除 `.cron.sql` 以外的全部 migration（`20261106000100` 到 `20261106000400`，以及加固用的 `20261106000600_harden.sql`；暂时把 `.cron.sql` 文件移出 `migrations/`，Step 2 验证后再放回）。**注意：**如果在 `.cron.sql`（`20261106000500`）移出期间推送了编号更大的 migration（例如 `000600`），之后把它放回时 CLI 会拒绝插入「早于远端最后一个 migration」的文件，这时要用 `npx supabase db push --include-all`。`.env.local` 只填 `VITE_SUPABASE_URL` 和 `VITE_SUPABASE_ANON_KEY`，**绝不填 service_role 密钥**。
- [ ] **Step 2: 验证 Cron。** 在 SQL 编辑器运行 `select name from pg_available_extensions where name = 'pg_cron';`，再运行 `.cron.sql` 的内容，然后 `select jobname, schedule from cron.job;`，预期看到 `purge-expired`、`0 3 * * *`。看得到则把 `.cron.sql` 放回 `migrations/`、用 `npx supabase db push --include-all` 推送（见 Step 1 的注意）并提交；如果扩展不可用或报权限错误，则不用 Cron，改在 Cloudflare 的环境变量里设置 `VITE_PURGE_ON_START=true`，并把 `.cron.sql` 从仓库里删除，在 `stage1-verification.md` 里记录结论。
- [ ] **Step 3: 关闭注册并建立自己的账号。** 控制台 Authentication 里：关闭「Allow new users to sign up」、关闭匿名登录、不启用任何第三方登录；在 Users 里手动创建自己的邮箱账号。验证注册确实被拒绝：

```bash
curl -s -X POST "$VITE_SUPABASE_URL/auth/v1/signup" -H "apikey: $VITE_SUPABASE_ANON_KEY" -H "Content-Type: application/json" -d '{"email":"probe@example.com","password":"Probe-12345!"}'
```

预期返回 4xx 且消息表示不允许注册；再用 `grant_type=anonymous` 的登录请求验证匿名登录也被拒绝。
- [ ] **Step 4: 部署到 Cloudflare Pages。** 连接仓库，构建命令 `npm run build`（它先运行 `tsc --noEmit` 做类型检查，再 `vite build`），输出目录 `dist`，Node 版本至少 20.19（`package.json` 的 `engines`；在 Cloudflare 设置环境变量 `NODE_VERSION=22`），环境变量填 `VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY`（以及上一步决定的 `VITE_PURGE_ON_START`）。部署后打开网址，预期出现登录页。
- [ ] **Step 5: 在真实的 iPhone（Safari 添加到主屏幕后从主屏幕打开）和 Windows 浏览器各过一遍，把结果记进 `stage1-verification.md`：**
  1. 登录成功；用错误密码登录得到「邮箱或密码不对」。
  2. 在一台设备新建待办，另一台打开后出现。
  3. 把一台设备断网，新增和修改几条，界面显示「未同步 N 项」，恢复网络后自动补传，另一台收到。
  4. 两台设备同时改同一条待办的不同字段，两边最终一致且两处改动都在。
  5. 一台删除、另一台离线编辑同一条，恢复后记录保持已删除。
  6. 导出完整备份，文件能存到「文件」里的 iCloud 云盘（iPhone）和 iCloud 文件夹（Windows）；把它导入，结果显示全部「跳过」。
  7. 清除浏览器数据后重新打开并登录，数据完整回来，云端数据没有减少。
  8. 重新部署一个新版本，旧页面出现「更新」按钮，点击后加载新版本。
  9. 在无痕窗口打开（iPhone 无痕模式同样检查）。现在的 Safari（iOS 14 起）和 Chrome 会给无痕窗口一个只存在内存里的 IndexedDB，所以应用多半能正常打开使用，而不是显示「此浏览器无法保存本机数据」。这一项的检查因此是：要么看到该提示，要么应用可用，但关闭无痕窗口后再打开，本机数据没有保留下来（云端数据不受影响）。
  10. 提交 `stage1-verification.md`：

```bash
git add -A && git commit -m "docs: stage 1 verification results"
```
