import { describe, expect, it } from 'vitest';
import { createPreviewToken, previewUrl, verifyPreviewToken } from './preview';

const S = 's'.repeat(40);
const NOW = new Date('2026-11-08T10:00:00Z');

describe('preview token', () => {
  it('round-trips and expires', () => {
    const t = createPreviewToken(S, 'about', 900, NOW);
    expect(verifyPreviewToken(S, t, new Date(NOW.getTime() + 899_000))).toEqual({
      slug: 'about',
      exp: Math.floor(NOW.getTime() / 1000) + 900,
    });
    expect(verifyPreviewToken(S, t, new Date(NOW.getTime() + 901_000))).toBeNull();
  });
  it('rejects a wrong secret, a tampered body and malformed input', () => {
    const t = createPreviewToken(S, 'about', 900, NOW);
    expect(verifyPreviewToken('x'.repeat(40), t, NOW)).toBeNull();
    const [, mac] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ slug: 'privacy', exp: 9999999999 })).toString(
      'base64url',
    );
    expect(verifyPreviewToken(S, `${forged}.${mac}`, NOW)).toBeNull();
    for (const bad of ['', 'a', 'a.b', 'a.b.c']) expect(verifyPreviewToken(S, bad, NOW)).toBeNull();
  });
  it('refuses a slug that is not a clean path', () => {
    expect(() => createPreviewToken(S, '../etc', 900)).toThrow();
    expect(() => createPreviewToken(S, 'a b', 900)).toThrow();
  });
  it('builds a link on the site origin only', () => {
    const u = new URL(
      previewUrl({
        siteOrigin: 'https://www.example.org',
        secret: S,
        slug: 'services/cardiology',
        ttlSeconds: 900,
        now: NOW,
      }),
    );
    expect(u.origin).toBe('https://www.example.org');
    expect(u.pathname).toBe('/preview');
    expect(u.searchParams.get('slug')).toBe('services/cardiology');
    expect(verifyPreviewToken(S, u.searchParams.get('token')!, NOW)?.slug).toBe(
      'services/cardiology',
    );
  });
});
