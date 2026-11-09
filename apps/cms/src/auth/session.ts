// CMS session. Payload's built-in JWT strategy is not registered when the local (password) strategy is disabled, and
// it refuses collections that disable it, so the CMS authenticates its own signed session cookie with a custom
// strategy. The cookie is named `<prefix>-token` so that Payload's own logout endpoint expires it. Every request
// re-reads the editor and re-checks the marketing allow-list, so removing a person from CMS_ALLOWED_EMAILS ends their
// access without waiting for the cookie to expire.
import type { AuthStrategy } from 'payload';
import { loadCmsEnv } from '../lib/env';
import { SignJWT, jwtVerify } from 'jose';
import { createHmac } from 'node:crypto';
import { SESSION_PURPOSE } from '../lib/signed';

export interface SessionClaim {
  uid: number | string;
}

// A compact HS256 JWT, because Payload's `/me` and admin session timer decode the cookie as a JWT to read `exp`. The
// key is derived from the Payload secret for this purpose only, so a PAYLOAD_SECRET-signed value of another kind
// (for example the OAuth transaction cookie) is never accepted as a session.
const sessionKey = (secret: string): Uint8Array =>
  new Uint8Array(createHmac('sha256', secret).update(SESSION_PURPOSE).digest());

export const sessionCookieName = (cookiePrefix: string): string => `${cookiePrefix}-token`;

export async function issueSession(args: {
  secret: string;
  userId: number | string;
  ttlSeconds: number;
  nowSeconds: number;
}): Promise<string> {
  return new SignJWT({ uid: args.userId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(args.nowSeconds)
    .setExpirationTime(args.nowSeconds + args.ttlSeconds)
    .sign(sessionKey(args.secret));
}

export function sessionSetCookie(name: string, value: string, ttlSeconds: number): string {
  return `${name}=${value}; Max-Age=${ttlSeconds}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export async function readSession(
  secret: string,
  cookieHeader: string | null,
  name: string,
  nowSeconds: number,
): Promise<SessionClaim | null> {
  const raw = cookieHeader
    ?.split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  if (!raw) return null;
  try {
    const { payload } = await jwtVerify(raw, sessionKey(secret), {
      algorithms: ['HS256'],
      currentDate: new Date(nowSeconds * 1000),
    });
    const uid = payload['uid'];
    return typeof uid === 'number' || typeof uid === 'string' ? { uid } : null;
  } catch {
    return null;
  }
}

export const sessionStrategy: AuthStrategy = {
  name: 'cms-session',
  authenticate: async ({ payload, headers }) => {
    const env = loadCmsEnv(process.env);
    const claim = await readSession(
      payload.secret,
      headers.get('cookie'),
      sessionCookieName(payload.config.cookiePrefix),
      Math.floor(Date.now() / 1000),
    );
    if (!claim) return { user: null };
    const user = await payload
      .findByID({ collection: 'users', id: claim.uid, depth: 0, overrideAccess: true })
      .catch(() => null);
    if (!user || !env.allowedEmails.has(String(user.email).toLowerCase())) return { user: null };
    return { user: { ...user, collection: 'users' as const } };
  },
};
