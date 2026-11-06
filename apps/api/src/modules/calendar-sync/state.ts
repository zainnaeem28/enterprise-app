// The OAuth `state` of the calendar link flow, and its PKCE verifier. Both are STATELESS (ARCHITECTURE 22.9 has no table for them):
//   state    = v1.<principal id>.<expiry epoch>.<random nonce>.<base64url HMAC-SHA256(key, everything before)>
//   verifier = base64url(HMAC-SHA256(key, "pkce|" + state))        challenge = base64url(SHA-256(verifier)), method S256
// The callback is a top-level browser navigation that carries the session cookie, so the state must name the SAME principal as the
// session (a code obtained for another doctor cannot be bound to this one: login CSRF), must not have expired (10 minutes) and must
// carry a valid HMAC under the current or the previous key (rotation). A replay of a state is harmless: the authorisation code it
// travels with is single-use at Google, and a state alone grants nothing.
// No value from this file is ever logged, audited, returned in an error or placed in a job payload.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isUuid } from './ids.js';

export const STATE_LIFETIME_SECONDS = 600;
const STATE = /^v1\.([0-9a-f-]{36})\.(\d{9,12})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

const mac = (key: Buffer, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest();

export function makeState(key: Buffer, principalId: string, now: Date): string {
  const expiry = Math.floor(now.getTime() / 1000) + STATE_LIFETIME_SECONDS;
  const body = `v1.${principalId.toLowerCase()}.${expiry}.${randomBytes(16).toString('base64url')}`;
  return `${body}.${mac(key, body).toString('base64url')}`;
}

export interface VerifiedState {
  principalId: string;
  /** Random part: used only to derive an idempotent secret-store token. */
  nonce: string;
}

export function verifyState(
  keys: readonly Buffer[],
  state: unknown,
  principalId: string,
  now: Date,
): VerifiedState | undefined {
  if (typeof state !== 'string' || state.length > 200) return undefined;
  const m = STATE.exec(state);
  if (m === null) return undefined;
  const [, pid, expiryRaw, nonce, given] = m as unknown as [string, string, string, string, string];
  const body = state.slice(0, state.lastIndexOf('.'));
  const givenMac = Buffer.from(given, 'base64url');
  let ok = false;
  for (const k of keys) {
    const expect = mac(k, body);
    if (expect.length === givenMac.length && timingSafeEqual(expect, givenMac)) ok = true; // every key costs the same
  }
  if (!ok || !isUuid(pid)) return undefined;
  if (pid !== principalId.toLowerCase()) return undefined;
  if (Number(expiryRaw) <= now.getTime() / 1000) return undefined;
  return { principalId: pid, nonce };
}

/** The PKCE verifier for a state: derived, so nothing is stored between the start and the callback. Uses the key that signed the state. */
export function pkceVerifier(key: Buffer, state: string): string {
  return mac(key, `pkce|${state}`).toString('base64url');
}
export const pkceChallenge = (verifier: string): string =>
  createHash('sha256').update(verifier, 'ascii').digest('base64url');

/** The key that signed this state (current first, then the previous one). */
export function signingKey(keys: readonly Buffer[], state: string): Buffer | undefined {
  const given = Buffer.from(state.slice(state.lastIndexOf('.') + 1), 'base64url');
  const body = state.slice(0, state.lastIndexOf('.'));
  return keys.find((k) => {
    const e = mac(k, body);
    return e.length === given.length && timingSafeEqual(e, given);
  });
}
