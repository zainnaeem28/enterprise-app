import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  SignInDenied,
  buildAuthorizationUrl,
  challengeFor,
  exchangeCode,
  newTransaction,
  statesMatch,
  verifyGoogleIdToken,
} from './google';

const CLIENT = 'cms-client.apps.googleusercontent.com';
const HD = 'example.org';
const allowed = new Set(['ann@example.org']);
let privateKey: CryptoKey;
let otherKey: CryptoKey;
let keys: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  otherKey = (await generateKeyPair('RS256')).privateKey;
  keys = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'RS256', use: 'sig' }],
  });
});

const token = (
  claims: Record<string, unknown> = {},
  opts: { key?: CryptoKey; aud?: string; exp?: string | number; iss?: string } = {},
) =>
  new SignJWT({ email: 'ann@example.org', email_verified: true, hd: HD, nonce: 'n1', ...claims })
    .setProtectedHeader({ alg: 'RS256' })
    .setSubject('sub-1')
    .setIssuer(opts.iss ?? 'https://accounts.google.com')
    .setAudience(opts.aud ?? CLIENT)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '5m')
    .sign(opts.key ?? privateKey);

const verify = (idToken: string, nonce = 'n1') =>
  verifyGoogleIdToken({
    idToken,
    clientId: CLIENT,
    hostedDomain: HD,
    nonce,
    allowedEmails: allowed,
    keys,
  });
const denied = async (p: Promise<unknown>) =>
  (await p.then(
    () => null,
    (e: unknown) => e,
  )) as SignInDenied;

describe('verifyGoogleIdToken', () => {
  it('accepts a valid marketing identity', async () => {
    expect(await verify(await token())).toEqual({ sub: 'sub-1', email: 'ann@example.org' });
  });
  it('lower-cases the e-mail before the allow-list check', async () => {
    expect((await verify(await token({ email: 'ANN@example.org' }))).email).toBe('ann@example.org');
  });
  it('rejects a token signed by another key', async () => {
    expect((await denied(verify(await token({}, { key: otherKey })))).reason).toBe('invalid_token');
  });
  it('rejects another OAuth client (audience), e.g. a portal client', async () => {
    expect((await denied(verify(await token({}, { aud: 'portal-client' })))).reason).toBe(
      'invalid_token',
    );
  });
  it('rejects a wrong issuer', async () => {
    expect((await denied(verify(await token({}, { iss: 'https://evil.example' })))).reason).toBe(
      'invalid_token',
    );
  });
  it('rejects an expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    expect((await denied(verify(await token({}, { exp: past })))).reason).toBe('invalid_token');
  });
  it('rejects garbage', async () => {
    expect((await denied(verify('not.a.jwt'))).reason).toBe('invalid_token');
  });
  it('rejects a replayed token with a different nonce', async () => {
    expect((await denied(verify(await token(), 'other'))).reason).toBe('nonce_mismatch');
  });
  it('rejects a missing nonce', async () => {
    expect((await denied(verify(await token({ nonce: undefined })))).reason).toBe('nonce_mismatch');
  });
  it('rejects an unverified e-mail', async () => {
    expect((await denied(verify(await token({ email_verified: false })))).reason).toBe(
      'email_unverified',
    );
  });
  it('rejects a personal Google account (no hd)', async () => {
    expect((await denied(verify(await token({ hd: undefined })))).reason).toBe('wrong_domain');
  });
  it('rejects another Workspace domain', async () => {
    expect(
      (await denied(verify(await token({ hd: 'other.org', email: 'ann@other.org' })))).reason,
    ).toBe('wrong_domain');
  });
  it('rejects a matching hd with a foreign e-mail domain', async () => {
    expect((await denied(verify(await token({ email: 'ann@evil.org' })))).reason).toBe(
      'wrong_domain',
    );
  });
  it('rejects a domain member who is not in the marketing group', async () => {
    expect((await denied(verify(await token({ email: 'carl@example.org' })))).reason).toBe(
      'not_in_marketing_group',
    );
  });
});

describe('authorization request', () => {
  it('uses authorization code + PKCE S256 + state + nonce and restricts the hosted domain', () => {
    const tx = newTransaction();
    const u = new URL(
      buildAuthorizationUrl({
        clientId: CLIENT,
        redirectUri: 'https://cms.example.org/cb',
        hostedDomain: HD,
        tx,
      }),
    );
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toBe(challengeFor(tx.verifier));
    expect(u.searchParams.get('state')).toBe(tx.state);
    expect(u.searchParams.get('nonce')).toBe(tx.nonce);
    expect(u.searchParams.get('hd')).toBe(HD);
    expect(u.searchParams.get('scope')).toBe('openid email');
    expect(u.searchParams.get('client_id')).toBe(CLIENT);
  });
  it('matches the RFC 7636 S256 test vector', () => {
    expect(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
  it('generates unguessable distinct values', () => {
    const a = newTransaction();
    const b = newTransaction();
    expect(a.state).not.toBe(b.state);
    expect(a.verifier.length).toBeGreaterThanOrEqual(43);
  });
  it('compares state in constant time and rejects empty / unequal lengths', () => {
    expect(statesMatch('abc', 'abc')).toBe(true);
    expect(statesMatch('abc', 'abd')).toBe(false);
    expect(statesMatch('abc', 'ab')).toBe(false);
    expect(statesMatch('', '')).toBe(false);
  });
});

describe('exchangeCode', () => {
  const args = {
    code: 'c',
    verifier: 'v',
    clientId: CLIENT,
    clientSecret: 's',
    redirectUri: 'https://cms.example.org/cb',
  };
  it('posts the code with the PKCE verifier and returns the id_token', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ id_token: 'tok' }), { status: 200 }));
    expect(await exchangeCode({ ...args, fetchImpl: f as unknown as typeof fetch })).toBe('tok');
    const call = (f.mock.calls as unknown as [string, RequestInit][])[0]!;
    expect(call[0]).toBe('https://oauth2.googleapis.com/token');
    const body = new URLSearchParams(String(call[1].body));
    expect(body.get('code_verifier')).toBe('v');
    expect(body.get('grant_type')).toBe('authorization_code');
  });
  it('denies on a failed exchange or a response without id_token', async () => {
    const bad = vi.fn(async () => new Response('{}', { status: 400 }));
    expect(
      (await denied(exchangeCode({ ...args, fetchImpl: bad as unknown as typeof fetch }))).reason,
    ).toBe('invalid_token');
    const none = vi.fn(async () => new Response('{}', { status: 200 }));
    expect(
      (await denied(exchangeCode({ ...args, fetchImpl: none as unknown as typeof fetch }))).reason,
    ).toBe('invalid_token');
  });
});
