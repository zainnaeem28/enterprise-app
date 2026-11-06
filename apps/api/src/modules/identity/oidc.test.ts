// The ID-token verifier and the realm checks against the local conformance IdP (ARCHITECTURE 26.1; TC-ID-* automated parts).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { LocalIdp } from './idp.fixture.js';
import type { Defect, Login } from './idp.fixture.js';
import { newPkce, OidcVerificationError, randomUrlToken } from './oidc.js';
import { GoogleRealmAdapter, OidcPatientAdapter, RealmCheckError } from './realms.js';
import type { RealmAdapter } from './realms.js';

const idp = new LocalIdp();
const REDIRECT = 'https://staff.example.test/api/v1/auth/callback';
before(() => idp.start());
after(() => idp.stop());

const google = (over: { domain?: string; now?: () => number } = {}): GoogleRealmAdapter =>
  new GoogleRealmAdapter(
    {
      endpoints: idp.endpoints,
      clientId: idp.clientId,
      clientSecret: 'x'.repeat(24),
      redirectUri: REDIRECT,
      workspaceDomain: over.domain ?? 'example.com',
    },
    over.now,
  );
const patient = (): OidcPatientAdapter =>
  new OidcPatientAdapter({
    endpoints: idp.endpoints,
    clientId: idp.clientId,
    redirectUri: REDIRECT,
  });

/** Runs the browser's part: authorise at the IdP, follow its redirect, hand code and verifier to the adapter. */
async function login(
  adapter: RealmAdapter,
  l: Login,
  opts: { maxAgeSeconds?: number; prompt?: 'login' } = {},
) {
  idp.nextLogin = l;
  const pkce = newPkce();
  const nonce = randomUrlToken();
  const state = randomUrlToken();
  const url = adapter.authorizationUrl({
    state,
    nonce,
    codeChallenge: pkce.challenge,
    ...(opts.prompt === undefined ? {} : { prompt: opts.prompt }),
    ...(opts.maxAgeSeconds === undefined ? {} : { maxAgeSeconds: opts.maxAgeSeconds }),
  });
  const r = await fetch(url, { redirect: 'manual' });
  const back = new URL(r.headers.get('location') ?? '');
  assert.equal(back.searchParams.get('state'), state);
  return adapter.complete({
    code: back.searchParams.get('code') ?? '',
    codeVerifier: pkce.verifier,
    nonce,
    ...(opts.maxAgeSeconds === undefined ? {} : { maxAgeSeconds: opts.maxAgeSeconds }),
  });
}
const good: Login = {
  sub: 'g-1',
  email: 'Dr.Jane@Example.com',
  email_verified: true,
  hd: 'example.com',
  name: 'Dr Jane Smith',
};

describe('authorisation request (code + PKCE, 26.1; BQ-8)', () => {
  test('S256 challenge, response_type code, nonce and state, hd hint only', async () => {
    await login(google(), good);
    const p = idp.lastAuthorize;
    assert.equal(p.get('response_type'), 'code');
    assert.equal(p.get('code_challenge_method'), 'S256');
    assert.ok((p.get('nonce') ?? '').length >= 20 && (p.get('state') ?? '').length >= 20);
    assert.equal(p.get('hd'), 'example.com');
    assert.equal(p.get('prompt'), null);
    assert.equal(p.get('max_age'), null);
  });
  test('re-authentication asks for prompt=login and max_age', async () => {
    await login(
      google(),
      { ...good, auth_time: Math.floor(Date.now() / 1000) },
      { prompt: 'login', maxAgeSeconds: 300 },
    );
    assert.equal(idp.lastAuthorize.get('prompt'), 'login');
    assert.equal(idp.lastAuthorize.get('max_age'), '300');
  });
});

describe('verified identity (google)', () => {
  test('success: subject, lower-cased email, name, auth time', async () => {
    const v = await login(google(), good);
    assert.equal(v.realm, 'google');
    assert.equal(v.subject, 'g-1');
    assert.equal(v.email, 'dr.jane@example.com');
    assert.equal(v.displayName, 'Dr Jane Smith');
    assert.ok(Math.abs(v.authTime.getTime() - Date.now()) < 5000);
  });
  test('a stale auth_time is refused when max_age was asked for; a missing one is accepted (prompt=login forced it)', async () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    await assert.rejects(
      login(google(), { ...good, auth_time: old }, { prompt: 'login', maxAgeSeconds: 300 }),
      (e: unknown) => e instanceof OidcVerificationError && e.reason === 'auth_time_stale',
    );
    const v = await login(google(), good, { prompt: 'login', maxAgeSeconds: 300 });
    assert.ok(Math.abs(v.authTime.getTime() - Date.now()) < 5000);
    const fresh = Math.floor(Date.now() / 1000) - 30;
    assert.equal(
      (
        await login(
          google(),
          { ...good, auth_time: fresh },
          { prompt: 'login', maxAgeSeconds: 300 },
        )
      ).authTime.getTime(),
      fresh * 1000,
    );
  });
  const realmFailures: [string, Login, string][] = [
    ['no hd claim', { sub: 'g', email: 'a@example.com', email_verified: true }, 'hd'],
    [
      'hd of another domain',
      { sub: 'g', email: 'a@example.com', email_verified: true, hd: 'other.com' },
      'hd',
    ],
    [
      'email not verified',
      { sub: 'g', email: 'a@example.com', email_verified: false, hd: 'example.com' },
      'email_not_verified',
    ],
    [
      'email_verified missing',
      { sub: 'g', email: 'a@example.com', hd: 'example.com' },
      'email_not_verified',
    ],
    [
      'email domain is a lookalike (endsWith trap)',
      { sub: 'g', email: 'a@evilexample.com', email_verified: true, hd: 'example.com' },
      'email_domain',
    ],
    [
      'email domain is a subdomain',
      { sub: 'g', email: 'a@mail.example.com', email_verified: true, hd: 'example.com' },
      'email_domain',
    ],
    [
      'email with an extra @ part',
      { sub: 'g', email: 'a@example.com@evil.com', email_verified: true, hd: 'example.com' },
      'email_domain',
    ],
    ['no email', { sub: 'g', email_verified: true, hd: 'example.com' }, 'email'],
  ];
  for (const [name, l, reason] of realmFailures)
    test(`refused: ${name}`, async () => {
      await assert.rejects(
        login(google(), l),
        (e: unknown) => e instanceof RealmCheckError && e.reason === reason,
      );
    });
  test('email_verified as the string "true" (Google sends it so on some paths) is accepted, "false" is not', async () => {
    assert.equal((await login(google(), { ...good, email_verified: 'true' })).subject, 'g-1');
    await assert.rejects(login(google(), { ...good, email_verified: 'false' }));
  });
});

describe('ID token checks (signature, issuer, audience, exp, nonce)', () => {
  const defects: [Defect, string][] = [
    ['wrong_nonce', 'nonce'],
    ['no_nonce', 'nonce'],
    ['wrong_aud', 'aud'],
    ['wrong_iss', 'iss'],
    ['expired', 'exp'],
    ['bad_signature', 'signature'],
    ['alg_none', 'alg'],
    ['alg_hs256', 'alg'],
    ['wrong_azp', 'azp'],
    ['future_iat', 'iat'],
  ];
  for (const [defect, reason] of defects)
    test(`refused: ${defect}`, async () => {
      await assert.rejects(
        login(google(), { ...good, defect }),
        (e: unknown) => e instanceof OidcVerificationError && e.reason === reason,
      );
    });
  test('an unknown signing key is refused (after one JWKS refetch)', async () => {
    await assert.rejects(
      login(google(), { ...good, defect: 'unknown_kid' }),
      (e: unknown) => e instanceof OidcVerificationError && e.reason === 'unknown_key',
    );
  });
  test('the token endpoint failing never leaks the IdP text', async () => {
    await assert.rejects(login(google(), { ...good, defect: 'token_error' }), (e: unknown) => {
      assert.ok(e instanceof OidcVerificationError);
      assert.ok(
        !JSON.stringify(e).includes('SECRET-IDP-TEXT') &&
          !String(e.message).includes('SECRET-IDP-TEXT'),
      );
      return true;
    });
  });
  test('a code is single use and bound to its PKCE verifier', async () => {
    idp.nextLogin = good;
    const pkce = newPkce();
    const a = google();
    const r = await fetch(
      a.authorizationUrl({
        state: 's'.repeat(24),
        nonce: 'n'.repeat(24),
        codeChallenge: pkce.challenge,
      }),
      { redirect: 'manual' },
    );
    const code = new URL(r.headers.get('location') ?? '').searchParams.get('code') ?? '';
    await assert.rejects(
      a.complete({ code, codeVerifier: newPkce().verifier, nonce: 'n'.repeat(24) }),
    ); // wrong verifier burns the code
    await assert.rejects(a.complete({ code, codeVerifier: pkce.verifier, nonce: 'n'.repeat(24) })); // and it cannot be replayed
  });
  test('the JWKS is cached between sign-ins', async () => {
    const a = google();
    await login(a, good);
    const before = idp.jwksCalls;
    await login(a, good);
    assert.equal(idp.jwksCalls, before);
  });
});

describe('patient realm adapter', () => {
  test('a patient needs no hd and no email; the realm is the adapter, not a claim', async () => {
    const v = await login(patient(), {
      sub: 'p-1',
      name: 'Pat Jones',
      extra: { realm: 'google', hd: 'example.com' },
    });
    assert.equal(v.realm, 'patient_pool');
    assert.equal(v.subject, 'p-1');
    assert.equal(v.email, undefined);
  });
  test('an unverified patient email is dropped, a verified one is kept lower-cased', async () => {
    assert.equal(
      (await login(patient(), { sub: 'p-2', email: 'P@X.org', email_verified: false })).email,
      undefined,
    );
    assert.equal(
      (await login(patient(), { sub: 'p-3', email: 'P@X.org', email_verified: true })).email,
      'p@x.org',
    );
  });
  test('a patient token still has to verify', async () => {
    await assert.rejects(login(patient(), { sub: 'p-4', defect: 'bad_signature' }));
  });
});
