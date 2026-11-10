// Preview link from the CMS editor to the brand site. The link carries a short-lived HMAC-signed token so a draft
// cannot be read by guessing the URL. The site verifies it with `verifyPreviewToken` (shared secret, delivered to both
// deployables by the marketing-account secret store). Site-side verification is outside FE-16's paths (see ticket note).
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface PreviewClaims {
  slug: string;
  exp: number;
}

const sign = (secret: string, body: string): string =>
  createHmac('sha256', secret).update(body).digest('base64url');

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

export function createPreviewToken(
  secret: string,
  slug: string,
  ttlSeconds: number,
  now = new Date(),
): string {
  if (!SLUG_RE.test(slug) && slug !== '') throw new Error('invalid slug');
  const body = Buffer.from(
    JSON.stringify({
      slug,
      exp: Math.floor(now.getTime() / 1000) + ttlSeconds,
    } satisfies PreviewClaims),
  ).toString('base64url');
  return `${body}.${sign(secret, body)}`;
}

export function verifyPreviewToken(
  secret: string,
  token: string,
  now = new Date(),
): PreviewClaims | null {
  const [body, mac, extra] = token.split('.');
  if (!body || !mac || extra !== undefined) return null;
  const expected = Buffer.from(sign(secret, body));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as PreviewClaims;
    if (typeof claims.slug !== 'string' || typeof claims.exp !== 'number') return null;
    return claims.exp > Math.floor(now.getTime() / 1000) ? claims : null;
  } catch {
    return null;
  }
}

export function previewUrl(args: {
  siteOrigin: string;
  secret: string;
  slug: string;
  ttlSeconds: number;
  now?: Date;
}): string {
  const u = new URL('/preview', args.siteOrigin);
  u.searchParams.set('slug', args.slug);
  u.searchParams.set(
    'token',
    createPreviewToken(args.secret, args.slug, args.ttlSeconds, args.now),
  );
  return u.toString();
}
