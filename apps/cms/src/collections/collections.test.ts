import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FORBIDDEN_PRODUCTION_VARS } from '../lib/env';
import { goodEnv } from '../test-env';
import { verifyPreviewToken } from '../admin/preview';
import type { Access, CollectionConfig } from 'payload';
import { Banners } from './banners';
import { Faqs } from './faqs';
import { Pages } from './pages';
import { Users } from './users';

const call = (a: Access | undefined, user: unknown) =>
  (a as (args: { req: { user: unknown } }) => unknown)({ req: { user } });
const content: CollectionConfig[] = [Pages, Banners, Faqs];

describe('content collections', () => {
  it.each(content)(
    '$slug: anonymous visitors read only published documents; editors read everything',
    (c) => {
      expect(call(c.access?.read, null)).toEqual({ _status: { equals: 'published' } });
      expect(call(c.access?.read, { id: 1 })).toBe(true);
    },
  );
  it.each(content)('$slug: only a signed-in editor can write, and drafts + publish are on', (c) => {
    for (const op of ['create', 'update', 'delete'] as const) {
      expect(call(c.access?.[op], null)).toBe(false);
      expect(call(c.access?.[op], { id: 1 })).toBe(true);
    }
    expect(c.versions && typeof c.versions === 'object' && c.versions.drafts).toBeTruthy();
  });
  it('has no field that could hold patient data (public content only)', () => {
    const names = content.flatMap((c) => c.fields.map((f) => ('name' in f ? f.name : '')));
    expect(names.join(' ')).not.toMatch(/patient|mrn|dob|diagnos|phone|ssn|insurance/i);
  });
  it('pages require a validated unique slug', () => {
    const slug = Pages.fields.find((f) => 'name' in f && f.name === 'slug');
    expect(slug).toMatchObject({ required: true, unique: true });
  });
  it('banner links must be https or site-relative', () => {
    const f = Banners.fields.find((x) => 'name' in x && x.name === 'linkUrl') as {
      validate: (v: unknown) => unknown;
    };
    expect(f.validate('https://x.org')).toBe(true);
    expect(f.validate('/about')).toBe(true);
    expect(f.validate('javascript:alert(1)')).not.toBe(true);
    expect(f.validate('http://x.org')).not.toBe(true);
  });
});

describe('users (editors)', () => {
  it('has no local password strategy and no API-created or edited accounts', () => {
    expect(Users.auth).toMatchObject({ disableLocalStrategy: true });
    for (const op of ['create', 'update', 'delete'] as const)
      expect(call(Users.access?.[op], { id: 1 })).toBe(false);
    expect(call(Users.access?.admin, null)).toBe(false);
  });
  it('exposes exactly the two Google endpoints', () => {
    expect(Users.endpoints).toHaveLength(2);
    expect(
      (Users.endpoints as { path: string; method: string }[]).map((e) => `${e.method} ${e.path}`),
    ).toEqual(['get /oauth/google/start', 'get /oauth/google/callback']);
  });
});

describe('pages preview link', () => {
  beforeEach(() => {
    for (const n of FORBIDDEN_PRODUCTION_VARS) vi.stubEnv(n, '');
    for (const [k, v] of Object.entries(goodEnv)) vi.stubEnv(k, v);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('opens the brand site /preview with a signed short-lived token for that slug', async () => {
    const preview = Pages.admin?.preview as (doc: Record<string, unknown>) => string;
    const u = new URL(preview({ slug: 'services/cardiology' }));
    expect(u.origin).toBe('https://www.example.org');
    expect(u.pathname).toBe('/preview');
    expect(u.searchParams.get('slug')).toBe('services/cardiology');
    const claims = verifyPreviewToken(goodEnv.CMS_PREVIEW_SECRET, u.searchParams.get('token')!);
    expect(claims?.slug).toBe('services/cardiology');
    expect(claims!.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(900);
  });
});
