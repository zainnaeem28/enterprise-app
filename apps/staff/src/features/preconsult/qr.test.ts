import { describe, expect, it } from 'vitest';
import { qrMatrix, reedSolomon } from './qr.js';

describe('qr', () => {
  it('computes the Reed-Solomon codewords of the standard HELLO WORLD example', () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(reedSolomon(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  it('draws a 25 x 25 symbol for the 22-character daily token, with the three finder patterns', () => {
    const m = qrMatrix('A1b2C3d4E5f6G7h8I9j0K_');
    expect(m).toHaveLength(25);
    for (const [x, y] of [
      [0, 0],
      [18, 0],
      [0, 18],
    ] as const) {
      expect(m[y]?.[x]).toBe(true);
      expect(m[y + 3]?.[x + 3]).toBe(true);
      expect(m[y + 1]?.[x + 1]).toBe(false);
    }
    expect(m[17]?.[8]).toBe(true); // the dark module
  });

  it('is deterministic and refuses a payload that does not fit', () => {
    expect(qrMatrix('abc')).toEqual(qrMatrix('abc'));
    expect(() => qrMatrix('x'.repeat(200))).toThrow(RangeError);
  });
});
