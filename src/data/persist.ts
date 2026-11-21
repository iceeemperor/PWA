/**
 * Asks the browser not to evict our storage. True when storage is (now) persistent; false when refused, unsupported
 * or failing. Called with no argument it uses navigator.storage; an explicit `undefined` means "no API".
 */
export async function requestPersistentStorage(s?: Pick<StorageManager, 'persist' | 'persisted'>): Promise<boolean> {
  try {
    const storage = arguments.length === 0 ? (typeof navigator !== 'undefined' ? navigator.storage : undefined) : s;
    if (!storage) return false;
    if (await storage.persisted()) return true;
    return await storage.persist();
  } catch {
    return false;
  }
}
