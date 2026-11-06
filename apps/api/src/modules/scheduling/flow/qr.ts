// The QR check-in token (ARCHITECTURE 22.8 note, TDR-10): no table. For a location and a local day it is
// `base64url(HMAC-SHA256(qr_key, location_id || local_date))` truncated to 128 bits. A new day gives a new token without any job.
import { createHmac, timingSafeEqual } from 'node:crypto';

export function qrToken(key: Buffer, locationId: string, localDate: string): string {
  return createHmac('sha256', key)
    .update(`${locationId.toLowerCase()}${localDate}`)
    .digest()
    .subarray(0, 16)
    .toString('base64url');
}

/** Constant time, and never throws on a malformed presented value. */
export function qrTokenMatches(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string' || presented.length > 64) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
