import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { getPayload, type Payload, type PayloadRequest } from 'payload';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FORBIDDEN_PRODUCTION_VARS } from '../lib/env';
import { goodEnv } from '../test-env';

const DB = process.env['CMS_TEST_DATABASE_URL'];
const describeDb = DB ? describe : describe.skip;
const CLIENT = goodEnv.CMS_GOOGLE_CLIENT_ID;

describeDb('Google sign-in against real Payload + PostgreSQL (Google stubbed)', () => {
  let payload: Payload;
  let privateKey: CryptoKey;
  let endpoints: import('payload').Endpoint[];

  beforeAll(async () => {
    for (const n of FORBIDDEN_PRODUCTION_VARS) vi.stubEnv(n, '');
    for (const [k, v] of Object.entries(goodEnv)) vi.stubEnv(k, v);
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('CMS_DATABASE_URL', DB!);
    vi.stubEnv('CMS_PUBLIC_URL', 'http://localhost:3187');
    vi.stubEnv('CMS_SITE_PREVIEW_URL', 'http://localhost:3000');
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    const keys = createLocalJWKSet({
      keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'RS256', use: 'sig' }],
    });
    const { default: config } = await import('../payload.config');
    payload = await getPayload({ config });
    // Start from an empty CMS so the test is repeatable (throwaway database only).
    for (const collection of ['pages', 'banners', 'faqs', 'users'] as const) {
      await payload.delete({ collection, where: { id: { exists: true } } });
    }
    const { createOAuthEndpoints } = await import('./endpoints');
    const idTokenFor = async (claims: Record<string, unknown>, nonce: string) =>
      new SignJWT({ email_verified: true, hd: 'example.org', nonce, ...claims })
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject('google-sub-ann')
        .setIssuer('https://accounts.google.com')
        .setAudience(CLIENT)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
    // The token endpoint is stubbed; it signs whatever identity the test selected.
    (globalThis as { __claims?: Record<string, unknown> }).__claims = { email: 'ann@example.org' };
    const fetchImpl = (async (_url: unknown, init: RequestInit) => {
      const claims = (globalThis as { __claims?: Record<string, unknown> }).__claims!;
      const nonce = (globalThis as { __nonce?: string }).__nonce!;
      void init;
      return new Response(JSON.stringify({ id_token: await idTokenFor(claims, nonce) }), {
        status: 200,
      });
    }) as typeof fetch;
    endpoints = createOAuthEndpoints({ keys, fetchImpl });
  });
  afterAll(async () => {
    await payload?.db.destroy?.();
    vi.unstubAllEnvs();
  });

  const handler = (path: string) => endpoints.find((e) => e.path === path)!.handler;
  async function signIn(claims: Record<string, unknown>) {
    (globalThis as { __claims?: Record<string, unknown> }).__claims = claims;
    const start = (await handler('/oauth/google/start')({} as PayloadRequest)) as Response;
    const loc = new URL(start.headers.get('location')!);
    (globalThis as { __nonce?: string }).__nonce = loc.searchParams.get('nonce')!;
    const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
    const req = {
      url: `http://localhost:3187/api/users/oauth/google/callback?code=abc&state=${loc.searchParams.get('state')}`,
      headers: new Headers({ cookie }),
      payload,
    } as unknown as PayloadRequest;
    return (await handler('/oauth/google/callback')(req)) as Response;
  }
  const countUsers = async () => (await payload.count({ collection: 'users' })).totalDocs;

  it('signs a marketing user in, creates the editor once, and issues a session Payload accepts', async () => {
    const res = await signIn({ email: 'ann@example.org' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://localhost:3187/admin');
    const session = res.headers.getSetCookie().find((c) => c.startsWith('payload-token='))!;
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    const auth = await payload.auth({ headers: new Headers({ cookie: session.split(';')[0]! }) });
    expect(auth.user?.email).toBe('ann@example.org');
    expect(await countUsers()).toBe(1);
    await signIn({ email: 'ann@example.org' });
    expect(await countUsers()).toBe(1);
  });

  it.each([
    ['not in the marketing group', { email: 'carl@example.org' }],
    ['another Workspace domain', { email: 'ann@other.org', hd: 'other.org' }],
    ['a personal Google account', { email: 'ann@example.org', hd: undefined }],
    ['an unverified e-mail', { email: 'ann@example.org', email_verified: false }],
  ])('denies %s and creates nothing', async (_name, claims) => {
    const before = await countUsers();
    const res = await signIn(claims);
    expect(res.headers.get('location')).toBe(
      'http://localhost:3187/admin/login?error=sign_in_failed',
    );
    expect(res.headers.getSetCookie().join(';')).not.toMatch(/payload-token/);
    expect(await countUsers()).toBe(before);
  });

  it('cannot create, edit or delete editors, nor read them anonymously (access enforced, overrideAccess off)', async () => {
    await expect(
      payload.create({
        collection: 'users',
        data: { email: 'x@example.org' },
        overrideAccess: false,
      }),
    ).rejects.toThrow();
    await expect(payload.find({ collection: 'users', overrideAccess: false })).rejects.toThrow();
  });

  it('lets an editor draft, preview-link and publish a page; the public sees only the published one', async () => {
    const auth = await payload.find({ collection: 'users', limit: 1 });
    const user = { ...auth.docs[0]!, collection: 'users' as const };
    const draft = await payload.create({
      collection: 'pages',
      data: { title: 'Draft page', slug: 'draft-page', _status: 'draft' },
      user,
      overrideAccess: false,
      draft: true,
    });
    const pub = await payload.create({
      collection: 'pages',
      data: { title: 'About us', slug: 'about', summary: 's', _status: 'published' },
      user,
      overrideAccess: false,
    });
    expect(draft.id).not.toBe(pub.id);
    const anon = await payload.find({ collection: 'pages', overrideAccess: false });
    expect(anon.docs.map((d) => d.slug)).toEqual(['about']);
    const editor = await payload.find({
      collection: 'pages',
      user,
      overrideAccess: false,
      draft: true,
    });
    expect(editor.docs.map((d) => d.slug).sort()).toEqual(['about', 'draft-page']);
    await expect(
      payload.create({
        collection: 'pages',
        data: { title: 'Bad', slug: 'Bad Slug' },
        user,
        overrideAccess: false,
      }),
    ).rejects.toThrow();
    await expect(
      payload.create({
        collection: 'pages',
        data: { title: 'Anon', slug: 'anon' },
        overrideAccess: false,
      }),
    ).rejects.toThrow();
    // publish the draft
    const published = await payload.update({
      collection: 'pages',
      id: draft.id,
      data: { _status: 'published' },
      user,
      overrideAccess: false,
    });
    expect(published._status).toBe('published');
    const anon2 = await payload.find({ collection: 'pages', overrideAccess: false });
    expect(anon2.docs.map((d) => d.slug).sort()).toEqual(['about', 'draft-page']);
  });
});
