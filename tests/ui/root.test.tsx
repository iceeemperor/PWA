// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Root } from '../../src/ui/App';

afterEach(() => {
  vi.unstubAllGlobals();
});

it('shows the unavailable screen when IndexedDB is not available', async () => {
  vi.stubGlobal('indexedDB', undefined);
  render(<Root />);
  expect(await screen.findByText(/此浏览器无法保存本机数据.*无痕/)).toBeInTheDocument();
});

it('shows a generic start-up error for other failures', async () => {
  render(
    <Root
      create={async () => {
        throw new Error('Missing environment variable VITE_SUPABASE_URL');
      }}
    />,
  );
  expect(await screen.findByText(/启动失败/)).toBeInTheDocument();
  expect(screen.getByText(/VITE_SUPABASE_URL/)).toBeInTheDocument();
});
