const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The entries of `next` whose value differs (by value, so arrays and objects compare by content) from `before`. */
export function changedFields<T extends object>(before: T, next: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(next) as (keyof T)[]) {
    if (!same(before[k], next[k])) out[k] = next[k];
  }
  return out;
}
