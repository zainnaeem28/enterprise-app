import { decodeJwt } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FORBIDDEN_PRODUCTION_VARS } from '../lib/env';
import { goodEnv } from '../test-env';
import {
  issueSession,
  readSession,
  sessionCookieName,
  sessionSetCookie,
  sessionStrategy,
} from './session';

const S = 'p'.repeat(40);
const NOW = 1_800_000_000;

beforeEach(() => {
  for (const n of FORBIDDEN_PRODUCTION_VARS) vi.stubEnv(n, '');
  for (const [k, v] of Object.entries(goodEnv)) vi.stubEnv(k, v);
});
afterEach(() => vi.unstubAllEnvs());

describe('session cookie', () => {
  it('is named so Payload logout expires it, and is HttpOnly Secure SameSite=Lax', () => {
    expect(sessionCookieName('payload')).toBe('payload-token');
    expect(sessionSetCookie('payload-token', 'v', 60)).toBe(
      'payload-token=v; Max-Age=60; Path=/; HttpOnly; Secure; SameSite=Lax',
    );
  });
  it('round-trips, expires, and rejects tampering or the wrong secret', async () => {
    const v = await issueSession({ secret: S, userId: 7, ttlSeconds: 100, nowSeconds: NOW });
    const header = `a=b; payload-token=${v}; c=d`;
    expect(await readSession(S, header, 'payload-token', NOW + 99)).toEqual({ uid: 7 });
    expect(await readSession(S, header, 'payload-token', NOW + 100)).toBeNull();
    expect(await readSession('x'.repeat(40), header, 'payload-token', NOW)).toBeNull();
    expect(await readSession(S, `payload-token=${v}x`, 'payload-token', NOW)).toBeNull();
    expect(await readSession(S, null, 'payload-token', NOW)).toBeNull();
    expect(await readSession(S, 'other=1', 'payload-token', NOW)).toBeNull();
    // a JWT, so Payload's /me can decode `exp`
    expect(decodeJwt(v).exp).toBe(NOW + 100);
  });
});

describe('sessionStrategy', () => {
  const mk = (user: unknown, cookie: string | null) => ({
    payload: {
      secret: S,
      config: { cookiePrefix: 'payload' },
      findByID: vi.fn(async () => {
        if (!user) throw new Error('not found');
        return user;
      }),
    },
    headers: new Headers(cookie ? { cookie } : {}),
  });
  const cookie = async () =>
    `payload-token=${await issueSession({ secret: S, userId: 1, ttlSeconds: 600, nowSeconds: Math.floor(Date.now() / 1000) })}`;
  const run = (a: ReturnType<typeof mk>) =>
    sessionStrategy.authenticate(
      a as unknown as Parameters<typeof sessionStrategy.authenticate>[0],
    );

  it('authenticates an allow-listed editor', async () => {
    const r = await run(mk({ id: 1, email: 'Ann@example.org' }, await cookie()));
    expect(r.user).toMatchObject({ id: 1, collection: 'users' });
  });
  it('ends access immediately when the person leaves the marketing allow-list', async () => {
    expect((await run(mk({ id: 1, email: 'carl@example.org' }, await cookie()))).user).toBeNull();
  });
  it('is anonymous without a valid cookie or when the user row is gone', async () => {
    expect((await run(mk({ id: 1, email: 'ann@example.org' }, null))).user).toBeNull();
    expect((await run(mk(null, await cookie()))).user).toBeNull();
  });
});
