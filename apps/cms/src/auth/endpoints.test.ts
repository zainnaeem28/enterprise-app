import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Endpoint, PayloadRequest } from 'payload';
import { oauthEndpoints } from './endpoints';
import { sealValue } from '../lib/signed';
import { goodEnv } from '../test-env';
import { FORBIDDEN_PRODUCTION_VARS } from '../lib/env';

const find = (path: string): Endpoint => oauthEndpoints.find((e) => e.path === path)!;
const asReq = (r: unknown) => r as PayloadRequest;

beforeEach(() => {
  for (const n of FORBIDDEN_PRODUCTION_VARS) vi.stubEnv(n, ''); // the host shell may carry its own DATABASE_URL
  for (const [k, v] of Object.entries(goodEnv)) vi.stubEnv(k, v);
});
afterEach(() => vi.unstubAllEnvs());

describe('GET /oauth/google/start', () => {
  it('redirects to Google with a sealed, HttpOnly, Secure, short-lived transaction cookie', async () => {
    const res = (await find('/oauth/google/start').handler(asReq({}))) as Response;
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin).toBe('https://accounts.google.com');
    expect(loc.searchParams.get('redirect_uri')).toBe(
      'https://cms.example.org/api/users/oauth/google/callback',
    );
    expect(loc.searchParams.get('hd')).toBe('example.org');
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^cms_oauth_tx=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Max-Age=600/);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('GET /oauth/google/callback', () => {
  const warn = vi.fn();
  const create = vi.fn();
  const mkReq = (url: string, cookie?: string) =>
    asReq({
      url,
      headers: new Headers(cookie ? { cookie } : {}),
      payload: { logger: { warn }, create, find: vi.fn(), update: vi.fn() },
    });
  const handler = find('/oauth/google/callback').handler;
  const tx = { state: 'S', nonce: 'N', verifier: 'V' };
  const cookieFor = (v = tx) =>
    `cms_oauth_tx=${sealValue(goodEnv.PAYLOAD_SECRET, v, Math.floor(Date.now() / 1000) + 300)}`;
  const expectDenied = (res: Response) => {
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://cms.example.org/admin/login?error=sign_in_failed',
    );
    expect(res.headers.getSetCookie().join(';')).not.toMatch(/payload-token/);
    expect(create).not.toHaveBeenCalled();
  };

  it('denies a callback with no transaction cookie (CSRF / forged link)', async () => {
    expectDenied((await handler(mkReq('https://cms.example.org/cb?code=c&state=S'))) as Response);
  });
  it('denies a state that does not match the cookie', async () => {
    expectDenied(
      (await handler(
        mkReq('https://cms.example.org/cb?code=c&state=WRONG', cookieFor()),
      )) as Response,
    );
  });
  it('denies a tampered transaction cookie', async () => {
    const bad = cookieFor().replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    expectDenied(
      (await handler(mkReq('https://cms.example.org/cb?code=c&state=S', bad))) as Response,
    );
  });
  it('denies and creates no user when the Google exchange fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 400 })),
    );
    const res = (await handler(
      mkReq('https://cms.example.org/cb?code=c&state=S', cookieFor()),
    )) as Response;
    vi.unstubAllGlobals();
    expectDenied(res);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ reason: 'invalid_token' }));
  });
  it('clears the transaction cookie on every outcome', async () => {
    const res = (await handler(mkReq('https://cms.example.org/cb'))) as Response;
    expect(res.headers.getSetCookie().join(';')).toMatch(/cms_oauth_tx=; Max-Age=0/);
  });
});
