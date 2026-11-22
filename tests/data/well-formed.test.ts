import { describe, expect, it } from 'vitest';
import { isWellFormed } from '../../src/data/validate-fields';

const HI = String.fromCharCode(0xd800);
const LO = String.fromCharCode(0xdc00);
const EMOJI = String.fromCodePoint(0x1f600);

const CASES: [string, string, boolean][] = [
  ['plain', 'abc', true],
  ['empty', '', true],
  ['pair', `a${EMOJI}b`, true],
  ['pair at start and end', EMOJI + EMOJI, true],
  ['lone high in the middle', `a${HI}b`, false],
  ['lone high at the end', `a${HI}`, false],
  ['lone low at the start', `${LO}a`, false],
  ['lone low after text', `a${LO}`, false],
  ['reversed pair', LO + HI, false],
  ['high, pair', HI + EMOJI, false],
  ['pair, low', EMOJI + LO, false],
];

describe('isWellFormed', () => {
  it.each(CASES)('native: %s', (_n, s, ok) => expect(isWellFormed(s)).toBe(ok));

  it.each(CASES)('regex fallback (no String.prototype.isWellFormed): %s', (_n, s, ok) => {
    const proto = String.prototype as { isWellFormed?: unknown };
    const saved = proto.isWellFormed;
    proto.isWellFormed = undefined;
    try {
      expect(isWellFormed(s)).toBe(ok);
    } finally {
      proto.isWellFormed = saved;
    }
  });
});
