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
