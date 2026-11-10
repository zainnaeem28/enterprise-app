import { createHmac, timingSafeEqual } from 'node:crypto';

export const OAUTH_PURPOSE = 'cms-oauth-transaction-v1';
export const SESSION_PURPOSE = 'cms-session-v1';

// Small signed value for the short-lived OAuth transaction cookie (state, nonce, PKCE verifier). The key is derived
// from the Payload secret with a purpose label, so a value sealed for one purpose is never valid for another.
const key = (secret: string, purpose: string): Buffer =>
  createHmac('sha256', secret).update(purpose).digest();

export function sealValue(
  secret: string,
  value: unknown,
  expiresAtSeconds: number,
  purpose = OAUTH_PURPOSE,
): string {
  const body = Buffer.from(JSON.stringify({ v: value, e: expiresAtSeconds })).toString('base64url');
  return `${body}.${createHmac('sha256', key(secret, purpose)).update(body).digest('base64url')}`;
}

export function openValue<T>(
  secret: string,
  sealed: string,
  nowSeconds: number,
  purpose = OAUTH_PURPOSE,
): T | null {
  const [body, mac, extra] = sealed.split('.');
  if (!body || !mac || extra !== undefined) return null;
  const want = Buffer.from(
    createHmac('sha256', key(secret, purpose)).update(body).digest('base64url'),
  );
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
      v: T;
      e: number;
    };
    return parsed.e > nowSeconds ? parsed.v : null;
  } catch {
    return null;
  }
}
