# 阶段 2.5：天气提示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在待办页「近期」顶部每天显示一行未来几天的粗略天气（例如「明天晴，后天起连续两天有雨」），城市在设置里搜索选择，数据来自 Open-Meteo。

**Architecture:** 纯前端功能，不改数据库、不经过 Supabase、不进同步和备份。天气代码分类和一句话摘要写成纯函数（`src/weather/*`）；请求 Open-Meteo 的两个接口（预报、地名搜索）各一个小函数，可注入 `fetch` 以便测试；城市和缓存存在本机 IndexedDB 的 `meta` 仓库里。界面是「近期」顶部的一行和设置里的「天气」一节。

**Tech Stack:** 同阶段 2，不新增依赖。浏览器 `fetch` + `AbortController`。

**Spec:** `docs/superpowers/specs/2026-11-05-productivity-app-design.md` §5.6（以及 §3.5 界面规矩）。

**项目根目录：** `C:\Users\Lenovo\Claude\productivity-app`，从 `main`（`23a639c` 之后最新）新开分支 `stage-2-5-weather`。**绝不在它的上一级运行 git。**

## Open-Meteo 接口事实（2026-11-27 从官网核对）

- 预报：`https://api.open-meteo.com/v1/forecast?latitude=<lat>&longitude=<lon>&daily=weather_code&timezone=auto&forecast_days=3`。返回 JSON 里 `timezone`（如 `Asia/Shanghai`）和 `daily.time`（`YYYY-MM-DD` 数组，城市当地日期，第一项是城市的今天）、`daily.weather_code`（整数数组，与 `time` 一一对应）。变量名是 `weather_code`，不是 `weathercode`。
- 地名搜索：`https://geocoding-api.open-meteo.com/v1/search?name=<名字>&count=5&language=zh&format=json`。结果在 `results` 数组里，每项有 `id`、`name`、`latitude`、`longitude`、`country`、`admin1`（可能缺）、`timezone`；没有结果时 `results` 可能缺失，按空处理。出错时 HTTP 400 和 `{ "error": true, "reason": … }`。
- 非商业使用免费、不需要密钥；上限每天 10000、每小时 5000、每分钟 600 次。
- 许可 CC BY 4.0：显示天气数据的地方旁边要有指向 `https://open-meteo.com/` 的链接；地名数据注明 GeoNames（`https://www.geonames.org`）。
- 官网没写 CORS；浏览器直接调用是普遍做法，Task 5 的真机检查确认。

## Global Constraints

- 「近期」顶部固定一行，**每天都显示**。（5.6）
- 只分几类：晴、多云/阴、雨、雪，必要时加雷雨、雾；连续几天同类合并成一句；不显示温度和逐小时预报。（5.6）
- 浏览器直接请求 Open-Meteo，不经过 Supabase；**城市每台设备各存各的，存在本机，不同步、不进备份**；不使用设备定位。（5.6）
- 没选城市时显示「在设置里选一个城市即可显示天气」。（5.6）
- 缓存约 3 小时；离线或失败时显示上一次结果并注明时间；超过 1 天的不显示；界面不报错。（5.6）
- 天气那一行末尾有小链接「Open-Meteo」指向 `https://open-meteo.com/`；城市搜索旁注明「地点数据来自 GeoNames」。（5.6）
- 最小宽度 360px；触控目标至少 44px；不用 `dangerouslySetInnerHTML`。（3.5，阶段 2 惯例）
- 不做天气提醒、推送。（5.6）

## 本计划替你定下的事（规格没写，请重点看）

1. 显示**今天、明天、后天**三天（`forecast_days=3`）。「今天」按**城市当地**的日期算（取接口返回的 `timezone`），不是设备时区。
2. 分类和文字：
   - 0、1 → 晴；2、3 → 多云；45、48 → 雾
   - 51–57、61–67、80–82 → 雨；71–77、85、86 → 雪；95–99 → 雷雨
   - 不认识的代码 → 跳过那一天
3. 句子格式（例子见 Task 1 的测试）：
   - 三天同类：「未来三天都是晴」，雨、雪、雷雨、雾用「都有雨」「都有雪」「都有雷雨」「都有雾」，多云用「都是多云」。
   - 否则按连续同类分段，用「，」连接，段内写法见 Task 1。
4. 一行的格式是「`<城市名>：<句子>`」，例如「上海：明天晴，后天有雨」。离线显示旧结果时，句子后加「（HH:mm 更新）」，时间是设备时区的取数时间。
5. 刷新时机：「近期」打开时，以及应用回到前台时；缓存不到 3 小时就不请求，所以一天最多约 8 次请求。请求 8 秒超时。
6. 城市和缓存放在本机元数据：`weather_city`、`weather_cache`。换城市或清除城市时清掉缓存。换账号时本机清空，城市也一起清掉（阶段 1 的做法，可以接受）。
7. 设置里「天气」一节：搜索框加「搜索」按钮，最多列 5 个结果（「名字，省/州，国家」），点一个就选定；已选城市旁边有「清除」。

## Review Focus

1. **断网或接口挂掉**：有缓存（不到 1 天）就显示旧结果加更新时间；没有就整行隐藏。任何情况都不抛错、不白屏，也不会一直重试。（Task 2、3）
2. **接口返回怪数据**：缺 `daily`、数组长度不一致、代码不是数字、HTTP 400/500、不是 JSON，都当成失败处理，不显示错句子。（Task 2）
3. **城市和设备不在一个时区**（比如人在东京、城市选上海）：「今天」「明天」按城市当地日期；缓存过了城市的午夜，旧的「今天」要变成过去、被丢掉，文字跟着变。（Task 1、3）
4. **换城市**：旧城市的缓存不能显示在新城市名下。（Task 2、4）
5. **搜索中文城市名**：「上海」「北京」能搜到；没有结果时显示「没有找到这个地方」，不报错。（Task 4）

---

### Task 1: 天气分类与一句话摘要（纯函数）

**Files:**
- Create: `src/weather/summary.ts`
- Test: `tests/weather/summary.test.ts`

**Interfaces:**
- Produces:
  - `type WeatherKind = 'sunny' | 'cloudy' | 'fog' | 'rain' | 'snow' | 'thunder'`
  - `weatherKind(code: number): WeatherKind | null`
  - `interface DayWeather { date: string; code: number }`（`date` 为 `YYYY-MM-DD`，城市当地）
  - `summarize(days: DayWeather[], today: string): string | null`（只用 `date >= today` 的天，按日期排序，最多三天；不认识的代码跳过；一天都没有返回 `null`）

- [ ] **Step 1: 写失败的测试**

```ts
it.each([[0, 'sunny'], [1, 'sunny'], [2, 'cloudy'], [3, 'cloudy'], [45, 'fog'], [48, 'fog'], [51, 'rain'], [57, 'rain'], [61, 'rain'], [67, 'rain'], [80, 'rain'], [82, 'rain'],
  [71, 'snow'], [77, 'snow'], [85, 'snow'], [86, 'snow'], [95, 'thunder'], [96, 'thunder'], [99, 'thunder'], [4, null], [100, null], [-1, null], [1.5, null]])
  ('weatherKind(%s) is %s', (code, kind) => expect(weatherKind(code)).toBe(kind));
const d = (date: string, code: number) => ({ date, code });
it('three days of the same kind', () => {
  expect(summarize([d('2026-11-27', 0), d('2026-11-28', 1), d('2026-11-29', 0)], '2026-11-27')).toBe('未来三天都是晴');
  expect(summarize([d('2026-11-27', 61), d('2026-11-28', 63), d('2026-11-29', 80)], '2026-11-27')).toBe('未来三天都有雨');
  expect(summarize([d('2026-11-27', 3), d('2026-11-28', 2), d('2026-11-29', 3)], '2026-11-27')).toBe('未来三天都是多云');
});
it('runs are joined with a comma', () => {
  expect(summarize([d('2026-11-27', 0), d('2026-11-28', 61), d('2026-11-29', 61)], '2026-11-27')).toBe('今天晴，明天起连续两天有雨');
  expect(summarize([d('2026-11-27', 3), d('2026-11-28', 0), d('2026-11-29', 61)], '2026-11-27')).toBe('今天多云，明天晴，后天有雨');
  expect(summarize([d('2026-11-27', 61), d('2026-11-28', 61), d('2026-11-29', 0)], '2026-11-27')).toBe('今天和明天有雨，后天晴');
  expect(summarize([d('2026-11-27', 95), d('2026-11-28', 71), d('2026-11-29', 45)], '2026-11-27')).toBe('今天有雷雨，明天有雪，后天有雾');
});
it('drops days before today, so a cache from yesterday shifts', () =>
  expect(summarize([d('2026-11-26', 61), d('2026-11-27', 0), d('2026-11-28', 0)], '2026-11-27')).toBe('今天和明天晴'));
it('skips unknown codes and returns null when nothing is left', () => {
  expect(summarize([d('2026-11-27', 4), d('2026-11-28', 0), d('2026-11-29', 0)], '2026-11-27')).toBe('明天和后天晴');
  expect(summarize([d('2026-11-26', 0)], '2026-11-27')).toBeNull(); expect(summarize([], '2026-11-27')).toBeNull();
});
it('ignores input order', () => expect(summarize([d('2026-11-29', 0), d('2026-11-27', 61), d('2026-11-28', 0)], '2026-11-27')).toBe('今天有雨，明天起连续两天晴'));
```

- [ ] **Step 2: 运行确认失败**：`npx vitest run tests/weather/summary.test.ts --testTimeout=10000`。
- [ ] **Step 3: 实现。** 规则（测试的例子都符合）：
  - 天的名字：与 `today` 相差 0 天「今天」、1 天「明天」、2 天「后天」（用 `src/domain/time.ts` 的 `addDays` 比较，不经过时区）。
  - 说法：晴→「晴」、多云→「多云」；雨、雪、雷雨、雾→「有雨」「有雪」「有雷雨」「有雾」。
  - 今天、明天、后天三天都在且同类：「未来三天都是晴」「未来三天都是多云」「未来三天都有雨」（雪、雷雨、雾同理）。
  - 否则把连续的同类天分段，各段用「，」连接：
    - 一天的段：「<天><说法>」，如「后天有雨」。
    - 两天的段，是第一段时：「<天1>和<天2><说法>」，如「今天和明天有雨」「明天和后天晴」。
    - 两天的段，不是第一段时：「<首天>起连续两天<说法>」，如「明天起连续两天有雨」。
- [ ] **Step 4: 运行确认通过**：同上命令。
- [ ] **Step 5: 提交**：`git commit -m "feat(weather): weather kinds and one-line summary"`

---

### Task 2: Open-Meteo 请求与本机存储

**Files:**
- Create: `src/weather/api.ts`、`src/weather/store.ts`
- Test: `tests/weather/api.test.ts`、`tests/weather/store.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `DayWeather`；`LocalDb.getMeta/setMeta`。
- Produces（`api.ts`）：
  - `interface City { name: string; region: string | null; country: string | null; latitude: number; longitude: number }`
  - `interface Forecast { timezone: string; days: DayWeather[] }`
  - `class WeatherError extends Error {}`
  - `fetchForecast(city: City, o?: { fetchFn?: typeof fetch; timeoutMs?: number }): Promise<Forecast>`（URL 见上面「接口事实」；默认超时 8000 ms；任何网络错误、非 2xx、不是 JSON、形状不对（缺 `timezone` 或 `daily.time`/`daily.weather_code` 不是等长数组、日期不是 `YYYY-MM-DD`、代码不是整数）都抛 `WeatherError`）
  - `searchCities(query: string, o?: { fetchFn?: typeof fetch; timeoutMs?: number }): Promise<City[]>`（`query` 先去掉首尾空白，为空直接返回 `[]` 不请求；`count=5&language=zh&format=json`；`results` 缺失当空；坏的结果项跳过；失败抛 `WeatherError`）
- Produces（`store.ts`）：
  - `const WEATHER_TTL_MS = 3 * 60 * 60 * 1000`、`const WEATHER_MAX_AGE_MS = 24 * 60 * 60 * 1000`
  - `interface CachedForecast { city: City; fetchedAt: string; forecast: Forecast }`（`fetchedAt` ISO UTC）
  - `getCity(db): Promise<City | null>`、`setCity(db, city): Promise<void>`（同时删除缓存）、`clearCity(db): Promise<void>`（城市和缓存都删）
  - `getCache(db): Promise<CachedForecast | null>`（存的东西形状不对就当没有）、`saveCache(db, c): Promise<void>`
  - 元数据键：`weather_city`、`weather_cache`

- [ ] **Step 1: 写失败的测试**（`fetchFn` 用 `vi.fn` 返回 `new Response(JSON.stringify(...), { status })`）

```ts
it('fetchForecast requests the daily weather code for 3 days in the city zone', async () => {
  const fetchFn = vi.fn().mockResolvedValue(ok({ timezone: 'Asia/Shanghai', daily: { time: ['2026-11-27', '2026-11-28', '2026-11-29'], weather_code: [0, 61, 3] } }));
  const f = await fetchForecast(SH, { fetchFn });
  const url = new URL(fetchFn.mock.calls[0][0]);
  expect(url.origin + url.pathname).toBe('https://api.open-meteo.com/v1/forecast');
  expect(Object.fromEntries(url.searchParams)).toEqual({ latitude: '31.22', longitude: '121.46', daily: 'weather_code', timezone: 'auto', forecast_days: '3' });
  expect(f).toEqual({ timezone: 'Asia/Shanghai', days: [{ date: '2026-11-27', code: 0 }, { date: '2026-11-28', code: 61 }, { date: '2026-11-29', code: 3 }] });
});
it.each([
  ['HTTP 500', () => new Response('x', { status: 500 })],
  ['HTTP 400 with reason', () => new Response(JSON.stringify({ error: true, reason: 'bad' }), { status: 400 })],
  ['not JSON', () => new Response('<html>', { status: 200 })],
  ['no daily', () => ok({ timezone: 'UTC' })],
  ['length mismatch', () => ok({ timezone: 'UTC', daily: { time: ['2026-11-27'], weather_code: [0, 1] } })],
  ['code not an integer', () => ok({ timezone: 'UTC', daily: { time: ['2026-11-27'], weather_code: ['0'] } })],
  ['bad date', () => ok({ timezone: 'UTC', daily: { time: ['27/11'], weather_code: [0] } })],
])('fetchForecast throws WeatherError on %s', async (_n, res) => {
  await expect(fetchForecast(SH, { fetchFn: vi.fn().mockResolvedValue(res()) })).rejects.toBeInstanceOf(WeatherError);
});
it('fetchForecast throws WeatherError on a network failure and on timeout', async () => { /* fetchFn rejects TypeError; fetchFn never resolves with timeoutMs: 10 → WeatherError */ });
it('searchCities sends name, count 5, language zh and maps results', async () => {
  const fetchFn = vi.fn().mockResolvedValue(ok({ results: [{ id: 1, name: '上海', latitude: 31.22, longitude: 121.46, country: '中国', admin1: '上海市' }, { id: 2, name: 'x' }] }));
  expect(await searchCities(' 上海 ', { fetchFn })).toEqual([{ name: '上海', region: '上海市', country: '中国', latitude: 31.22, longitude: 121.46 }]);
  const url = new URL(fetchFn.mock.calls[0][0]); expect(url.searchParams.get('name')).toBe('上海'); expect(url.searchParams.get('count')).toBe('5'); expect(url.searchParams.get('language')).toBe('zh');
});
it('searchCities: no results is an empty list; a blank query makes no request', async () => {
  expect(await searchCities('xyz', { fetchFn: vi.fn().mockResolvedValue(ok({ generationtime_ms: 1 })) })).toEqual([]);
  const fetchFn = vi.fn(); expect(await searchCities('  ', { fetchFn })).toEqual([]); expect(fetchFn).not.toHaveBeenCalled();
});
// store.test.ts（fake-indexeddb，每个测试独立库名）
it('setCity stores the city and drops the cache', async () => { /* saveCache, setCity(other) → getCache() null, getCity() other */ });
it('clearCity removes both', async () => { /* … */ });
it('a malformed stored cache or city reads as null', async () => { /* db.setMeta('weather_cache', { x: 1 }) → getCache() null */ });
```

- [ ] **Step 2: 运行确认失败**：`npx vitest run tests/weather --testTimeout=10000`。
- [ ] **Step 3: 实现。** 用 `URL` 和 `URLSearchParams` 拼地址（数字原样转字符串）。超时用 `AbortController` + `setTimeout`，结束时清掉计时器。不要把请求或回应的内容拼进错误文字以外的地方。
- [ ] **Step 4: 运行确认通过**：同上命令。
- [ ] **Step 5: 提交**：`git commit -m "feat(weather): Open-Meteo client and local storage"`

---

### Task 3: 「近期」顶部的天气一行

**Files:**
- Create: `src/weather/useWeather.ts`、`src/ui/WeatherLine.tsx`
- Modify: `src/ui/TodosPage.tsx`（`Upcoming` 列表最上面放 `<WeatherLine />`）、`src/ui/styles.css`
- Test: `tests/weather/use-weather.test.tsx`、扩展 `tests/ui/todos-page.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `summarize`；Task 2 的 `fetchForecast`、`getCity`、`getCache`、`saveCache`、常量；`localDateOf`（`src/domain/time.ts`）。
- Produces:
  - `type WeatherView = { kind: 'no_city' } | { kind: 'hidden' } | { kind: 'ready'; text: string; staleAt: string | null }`（`text` 已含城市名；`staleAt` 为显示用的「HH:mm」，只有显示旧结果时才有）
  - `useWeather(db: LocalDb, o?: { fetchFn?: typeof fetch; now?: () => Date; doc?: Document }): WeatherView`
  - `WeatherLine({ db, fetchFn? }: { db: LocalDb; fetchFn?: typeof fetch })`

- [ ] **Step 1: 写失败的测试**（时钟冻结：`vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime('2026-11-27T01:00:00Z')`；`now` 也可注入）

```tsx
it('no city: shows the hint to pick one, makes no request', async () => {
  const fetchFn = vi.fn(); render(<WeatherLine db={db} fetchFn={fetchFn} />);
  expect(await screen.findByText('在设置里选一个城市即可显示天气')).toBeInTheDocument(); expect(fetchFn).not.toHaveBeenCalled();
});
it('a fresh cache is shown without a request', async () => { /* saveCache fetchedAt 1 h ago → text 上海：今天晴，… ; fetchFn not called */ });
it('an old cache (> 3 h) triggers one request and shows the new result', async () => { /* fetchedAt 4 h ago; fetchFn ok → new text; saveCache updated; fetchFn called once */ });
it('when the request fails, a cache under a day is shown with its time; older than a day hides the line', async () => {
  /* fetchFn rejects; fetchedAt 2026-11-26T20:00Z (5 h old; device TZ in vitest is Asia/Shanghai, so 04:00) → text ends with （04:00 更新）; fetchedAt 25 h ago → nothing rendered */
});
it('"today" follows the city zone: past days in the cache are dropped', async () => {
  /* city 东京, forecast.timezone 'Asia/Tokyo', days 11-26..11-28 (codes 61, 0, 0), fresh cache, now 2026-11-27T01:00Z (Tokyo 11-27 10:00) → text is 东京：今天和明天晴 (11-26 dropped) */
});
it('the line links to Open-Meteo', async () => { /* role link name Open-Meteo, href https://open-meteo.com/ , target _blank rel noopener */ });
it('returning to the foreground refreshes only when the cache is older than 3 h', async () => { /* fire visibilitychange visible twice; fetch count as expected */ });
it('never throws: a broken getMeta hides the line', async () => { /* db.getMeta rejects → nothing rendered, no error boundary */ });
// todos-page.test.tsx
it('the upcoming tab shows the weather line above the list', async () => { /* … */ });
```

- [ ] **Step 2: 运行确认失败**：`npx vitest run tests/weather tests/ui/todos-page.test.tsx --testTimeout=10000`。
- [ ] **Step 3: 实现。** 流程：读城市 → 没有就 `no_city`；读缓存 → 缓存城市和当前城市的经纬度不同就当没有；缓存不到 3 小时直接显示；否则请求，成功就存并显示，失败就用不到 1 天的旧缓存加「（HH:mm 更新）」，再不行就 `hidden`。「今天」= `localDateOf(now, forecast.timezone)`，时区不认识时用 `forecast.days` 里最早一天。一次只允许一个请求在路上；组件卸载后不再 setState。`visibilitychange` 变为可见时重新走一遍（受 3 小时限制）。样式：一行、可换行、字号与列表次要文字一致，不加边框阴影；整行不是按钮。
- [ ] **Step 4: 运行确认通过**：同上命令，再跑全部测试。
- [ ] **Step 5: 提交**：`git commit -m "feat(ui): weather line at the top of the upcoming list"`

---

### Task 4: 设置里的「天气」一节

**Files:**
- Create: `src/ui/WeatherSettings.tsx`
- Modify: `src/ui/Settings.tsx`（在「同步」之后、「导出」之前加这一节）、`src/ui/styles.css`
- Test: `tests/ui/weather-settings.test.tsx`

**Interfaces:**
- Consumes: Task 2 的 `searchCities`、`getCity`、`setCity`、`clearCity`、`City`。
- Produces: `WeatherSettings({ db, fetchFn? }: { db: LocalDb; fetchFn?: typeof fetch })`

- [ ] **Step 1: 写失败的测试**

```tsx
it('searches, lists up to 5 results as 名字，省/州，国家 and saves the chosen one', async () => {
  /* type 上海 into 城市, click 搜索 → buttons 上海，上海市，中国 …; click → getCity() is that city; the section now shows 当前城市：上海 */
});
it('no results says 没有找到这个地方; a failed search says 搜索失败，请稍后再试', async () => { /* … */ });
it('清除 removes the city and its cache', async () => { /* … */ });
it('a blank search does nothing', async () => { /* fetchFn not called */ });
it('shows the GeoNames credit with its link', () => { /* text 地点数据来自 GeoNames, link href https://www.geonames.org */ });
it('the search button is disabled while searching and a second click is ignored', async () => { /* fetchFn called once */ });
it('sits after 同步 and before 导出 in Settings', () => { /* heading order */ });
```

- [ ] **Step 2: 运行确认失败**：`npx vitest run tests/ui/weather-settings.test.tsx --testTimeout=10000`。
- [ ] **Step 3: 实现。** 一节标题「天气」；说明文字「天气只保存在这台设备上」；已选城市显示「当前城市：<名字>」和「清除」；输入框（label「城市」，回车等于搜索）和「搜索」按钮；结果是一列按钮，地区或国家缺失时省略那一段。所有按钮至少 44px 高。
- [ ] **Step 4: 运行确认通过**：同上命令，再跑全部测试、`npm run build`。
- [ ] **Step 5: 提交**：`git commit -m "feat(ui): weather city picker in settings"`

---

### Task 5: 部署与真机检查（需要用户本人）

**Files:**
- Modify: `docs/superpowers/plans/verification.md`（加「阶段 2.5」一节）

- [ ] **Step 1: 合并并部署**：把 `stage-2-5-weather` 快进合并到 `main` 并推送，Cloudflare 自动构建。没有数据库改动，不需要 `db push`。
- [ ] **Step 2: iPhone（主屏幕打开）和 Windows 浏览器各过一遍，结果记进 `verification.md`：**
  1. 没选城市时「近期」顶部显示「在设置里选一个城市即可显示天气」。
  2. 设置里搜「上海」（或你常住的城市）能搜到并选定；「近期」顶部出现「城市：…」一行，末尾有「Open-Meteo」链接，点开是 open-meteo.com。（这一步同时确认浏览器能直接请求，CORS 没问题。）
  3. 另一台设备上没有同步这个城市（各存各的）。
  4. 断网后打开应用：仍显示上一次的结果，后面带「（HH:mm 更新）」。
  5. 换一个城市，「近期」里的城市名和天气跟着变。
  6. 360px 宽的手机上这一行不撑出横向滚动。
- [ ] **Step 3: 提交**：`git add docs/superpowers/plans/verification.md && git commit -m "docs: stage 2.5 verification results"`
