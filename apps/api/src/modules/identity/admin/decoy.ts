// The deterministic decoy `allowCredentials` list (ARCHITECTURE 26.1, SEC01-F-01; T-1). An unknown, suspended or disabled
// handle, or one with no live credential, gets a list of the same shape as a real one: 1 or 2 entries (the count comes from
// the first byte of the first HMAC), each ID `HMAC-SHA256(decoy_key, handle || i)` truncated to the credential-ID length of
// the approved authenticator models, `transports` the most common real value. The list is stable across calls and instances
// because it depends on nothing but the key and the normalised handle. The key `<env>/app/admin-decoy-key` is separate from
// the rate, session and CSRF keys.
import { createHmac } from 'node:crypto';

export const DECOY_ID_BYTES = 32;
export const DECOY_TRANSPORTS: readonly string[] = ['usb'];

export interface AllowEntry {
  id: Buffer;
  transports: readonly string[];
}

export function decoyAllowCredentials(decoyKey: string, handle: string): AllowEntry[] {
  const mac = (i: number): Buffer =>
    createHmac('sha256', decoyKey)
      .update(handle)
      .update(Buffer.from([0, i]))
      .digest();
  const first = mac(0);
  const count = 1 + ((first[0] ?? 0) & 1);
  const out: AllowEntry[] = [];
  for (let i = 0; i < count; i++)
    out.push({
      id: (i === 0 ? first : mac(i)).subarray(0, DECOY_ID_BYTES),
      transports: DECOY_TRANSPORTS,
    });
  return out;
}
