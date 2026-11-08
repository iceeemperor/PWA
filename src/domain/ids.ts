const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A fresh random (v4) UUID. Needs a secure context in browsers (https or localhost). */
export function newId(): string {
  return crypto.randomUUID();
}

export function isUuid(s: string): boolean {
  return UUID_PATTERN.test(s);
}
