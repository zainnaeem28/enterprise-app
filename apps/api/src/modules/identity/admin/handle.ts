// The admin handle (ARCHITECTURE 26.1, B2-6): `^[a-z0-9][a-z0-9._-]{2,63}$` after lower-casing, no other Unicode. One
// function is used by principal creation, enrolment and sign-in, and the format is checked before the claim setting is set.
const HANDLE = /^[a-z0-9][a-z0-9._-]{2,63}$/;
/** Only ASCII letters, digits and `._-` may be lower-cased: `K` (U+212A) would otherwise fold to `k`. */
const RAW = /^[A-Za-z0-9._-]{3,64}$/;

export function normaliseHandle(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !RAW.test(raw)) return undefined;
  const h = raw.toLowerCase();
  return HANDLE.test(h) ? h : undefined;
}
