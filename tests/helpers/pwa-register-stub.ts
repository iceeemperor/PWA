// Stands in for vite-plugin-pwa's virtual module in tests (vitest.config.ts aliases it here).
// A test that needs other values mocks 'virtual:pwa-register/react' with vi.mock.
export function useRegisterSW() {
  return {
    needRefresh: [false, () => {}] as [boolean, (v: boolean) => void],
    offlineReady: [false, () => {}] as [boolean, (v: boolean) => void],
    updateServiceWorker: async () => {},
  };
}
