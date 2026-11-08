import { describe, expect, it } from 'vitest';
import { isUuid, newId } from '../../src/domain/ids';

describe('ids', () => {
  it('newId returns a UUID v4', () =>
    expect(newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));

  it('isUuid accepts well-formed uuids and rejects others', () => {
    expect(isUuid(newId())).toBe(true);
    expect(isUuid('123')).toBe(false);
    expect(isUuid('')).toBe(false);
  });
});
