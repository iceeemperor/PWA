// F8: the deploy build typechecks, and the Node version Vite 8 needs is declared.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  scripts: Record<string, string>;
  engines?: Record<string, string>;
};

it('npm run build typechecks before it bundles', () => {
  expect(pkg.scripts.build).toMatch(/^(tsc --noEmit|npm run typecheck) && vite build$/);
});

it('declares the Node version Vite 8 needs', () => {
  expect(pkg.engines?.node).toBe('>=20.19');
});
