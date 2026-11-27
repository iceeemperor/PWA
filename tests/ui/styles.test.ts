// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('styles switch from bottom to side navigation at 768px and enforce a 360px minimum', () => {
  const css = readFileSync('src/ui/styles.css', 'utf8');
  expect(css).toMatch(/min-width:\s*360px/);
  expect(css).toMatch(/@media \(min-width:\s*768px\)/);
});

it('uses the brand colour', () => {
  expect(readFileSync('src/ui/styles.css', 'utf8')).toMatch(/#2f5bea/i);
});

/** The declarations of the first rule whose selector is exactly `selector`. */
function ruleBody(css: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\n|,\\s*)${esc}\\s*\\{([^}]*)\\}`).exec(css);
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[1];
}

const px = (body: string, prop: string): number => {
  const m = new RegExp(`(?:^|[;\\s])${prop}:\\s*(\\d+)px`).exec(body);
  return m ? Number(m[1]) : 0;
};

it('gives the to-do page 44px touch targets', () => {
  const css = readFileSync('src/ui/styles.css', 'utf8');
  // Every button on the page, and the rules that restyle particular ones, keep 44px.
  for (const sel of ['.todos-page button', '.tab', '.todos-page .agenda-title', '.todos-page .cal-mark', '.todos-page button.small']) {
    const body = ruleBody(css, sel);
    const h = px(body, 'min-height');
    // A rule that does not set min-height inherits the 44px of `.todos-page button`.
    if (sel === '.todos-page button.small' && h === 0) continue;
    expect(h, sel).toBeGreaterThanOrEqual(44);
  }
  // Checkboxes sit in a tappable box of at least 44 × 44; the visible box may be smaller.
  const hit = ruleBody(css, '.todos-page .hit');
  expect(px(hit, 'min-width')).toBeGreaterThanOrEqual(44);
  expect(px(hit, 'min-height')).toBeGreaterThanOrEqual(44);
  // No rule on the page brings a min-height under 44px.
  const page = css.slice(css.indexOf('/* To-do page'), css.indexOf('/* Export reminder'));
  for (const m of page.matchAll(/min-height:\s*(\d+)px/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(44);
});

it('the weather line wraps instead of scrolling, and its credit link is a 44px tap target', () => {
  const css = readFileSync('src/ui/styles.css', 'utf8');
  const line = ruleBody(css, '.weather-line');
  expect(line).toMatch(/color:\s*var\(--muted\)/);
  expect(line).not.toMatch(/white-space:\s*nowrap/);
  expect(line).not.toMatch(/border|box-shadow/);
  const credit = ruleBody(css, '.weather-credit');
  expect(credit).toMatch(/display:\s*inline-block/);
  expect(px(credit, 'min-height')).toBeGreaterThanOrEqual(44);
});

it('long city names wrap in the weather settings instead of widening the card', () => {
  const css = readFileSync('src/ui/styles.css', 'utf8');
  const current = ruleBody(css, '.weather-settings .weather-current span');
  expect(current).toMatch(/overflow-wrap:\s*anywhere/);
  expect(current).toMatch(/min-width:\s*0/);
  const result = ruleBody(css, '.weather-settings .weather-results button');
  expect(result).toMatch(/overflow-wrap:\s*anywhere/);
});
