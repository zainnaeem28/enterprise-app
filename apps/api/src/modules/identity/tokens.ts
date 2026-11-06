// Session tokens, cookies and constant-time comparison (ARCHITECTURE 26.2). The token is 256 random bits; only its SHA-256
// is ever stored or put into a database setting. Cookies use the `__Host-` prefix: Secure, Path=/, no Domain.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SID_COOKIE = '__Host-sid';
export const OIDC_COOKIE = '__Host-oidc';
/** Lifetime of the pre-authentication cookie (26.1, SEC01-F-11). */
export const OIDC_COOKIE_SECONDS = 600;

export interface IssuedToken {
  /** Sent to the client once, in the cookie. Never stored, never logged. */
  token: string;
  /** SHA-256 of the token as 64 hex characters (the value of `app.session_token_hash`). */
  hashHex: string;
  /** The same digest as bytes (the `token_hash` column). */
  hash: Buffer;
}

export function sha256(value: string | Buffer): Buffer {
  return createHash('sha256').update(value).digest();
}

export function issueToken(): IssuedToken {
  const token = randomBytes(32).toString('base64url');
  const hash = sha256(token);
  return { token, hash, hashHex: hash.toString('hex') };
}

/** Accepts only what `issueToken` can produce, so a malformed cookie never reaches the database. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
export function hashPresentedToken(presented: string | undefined): IssuedToken['hashHex'] | undefined {
  if (presented === undefined || !TOKEN_SHAPE.test(presented)) return undefined;
  return sha256(presented).toString('hex');
}

export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseCookies(header: string | string[] | undefined): Map<string, string> {
  const out = new Map<string, string>();
  const raw = Array.isArray(header) ? header.join(';') : (header ?? '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    // The first occurrence wins: a duplicate cookie from a sibling-domain script cannot shadow it.
    if (!out.has(name)) out.set(name, value);
  }
  return out;
}

export interface CookieOptions {
  maxAgeSeconds: number;
  sameSite: 'Strict' | 'Lax';
}

export function buildCookie(name: string, value: string, o: CookieOptions): string {
  if (!name.startsWith('__Host-')) throw new Error('cookie names carry the __Host- prefix');
  return `${name}=${value}; Max-Age=${Math.max(0, Math.floor(o.maxAgeSeconds))}; Path=/; Secure; HttpOnly; SameSite=${o.sameSite}`;
}

export function clearCookie(name: string, sameSite: 'Strict' | 'Lax'): string {
  return buildCookie(name, '', { maxAgeSeconds: 0, sameSite });
}

/** `returnTo` must be a relative path on the same host (29.1). Anything else becomes `/`. */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return '/';
  try {
    const u = new URL(value, 'https://placeholder.invalid');
    if (u.origin !== 'https://placeholder.invalid') return '/';
  } catch {
    return '/';
  }
  return value;
}
