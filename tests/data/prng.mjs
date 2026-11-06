// Deterministic helpers for the synthetic data (TEST-CASES 3). No Math.random, no clock, no network: the same seed gives
// the same bytes on every machine, so a result can be reproduced from the candidate commit and the seed alone.
import { createHash } from 'node:crypto';

/** sha256 of the parts, as a Buffer. Parts are joined with NUL so ('a','bc') differs from ('ab','c'). */
export function digest(...parts) {
  return createHash('sha256').update(parts.join('\0')).digest();
}

/** Stable UUID (version-5 layout) from a namespace and a name. Not a secret; an identifier for synthetic rows. */
export function stableUuid(namespace, name) {
  const b = Buffer.from(digest('ehr-qa-uuid', namespace, name).subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** mulberry32 seeded from a string. Returns a function giving floats in [0, 1). */
export function rng(seed) {
  let a = digest('ehr-qa-rng', seed).readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
export const pick = (r, list) => list[Math.floor(r() * list.length)];
