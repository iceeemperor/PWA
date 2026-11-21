/** Shown when IndexedDB cannot be opened: without it nothing can be saved, so the app does not start. */
export function UnavailableScreen() {
  return (
    <main className="screen-message" role="alert">
      <h1>无法启动</h1>
      <p>此浏览器无法保存本机数据。如果正在使用无痕（隐私）模式，请换成普通模式打开；也请检查浏览器是否禁止了网站存储数据。</p>
    </main>
  );
}
