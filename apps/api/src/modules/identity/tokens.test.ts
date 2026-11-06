import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildCookie,
  clearCookie,
  constantTimeEqual,
  hashPresentedToken,
  issueToken,
  parseCookies,
  safeReturnTo,
  sha256,
} from './tokens.js';
import { openOidcState, sealOidcState } from './oidc-state.js';

describe('session tokens (26.2)', () => {
  test('256 random bits, only the SHA-256 is derived, hex form matches the bytes', () => {
    const a = issueToken();
    const b = issueToken();
    assert.notEqual(a.token, b.token);
    assert.equal(Buffer.from(a.token, 'base64url').length, 32);
    assert.equal(a.hash.length, 32);
    assert.equal(a.hashHex, a.hash.toString('hex'));
    assert.deepEqual(a.hash, sha256(a.token));
    assert.ok(!a.hashHex.includes(a.token));
  });
  test('a presented value that is not a token never becomes a lookup key', () => {
    for (const bad of [undefined, '', 'short', 'a'.repeat(44), `${'a'.repeat(42)}!`, "' OR 1=1 --"])
      assert.equal(hashPresentedToken(bad), undefined);
    const t = issueToken();
    assert.equal(hashPresentedToken(t.token), t.hashHex);
  });
  test('constant-time compare', () => {
    assert.ok(constantTimeEqual(sha256('a'), sha256('a')));
    assert.ok(!constantTimeEqual(sha256('a'), sha256('b')));
    assert.ok(!constantTimeEqual(Buffer.from('a'), Buffer.from('ab')));
  });
});

describe('cookies', () => {
  test('__Host- cookie: Secure, HttpOnly, Path=/, no Domain, SameSite as given', () => {
    const c = buildCookie('__Host-sid', 'v', { maxAgeSeconds: 100, sameSite: 'Strict' });
    assert.equal(c, '__Host-sid=v; Max-Age=100; Path=/; Secure; HttpOnly; SameSite=Strict');
    assert.ok(!/domain/i.test(c));
    assert.throws(() => buildCookie('sid', 'v', { maxAgeSeconds: 1, sameSite: 'Lax' }));
    assert.match(clearCookie('__Host-oidc', 'Lax'), /Max-Age=0/);
  });
  test('parse: first occurrence wins', () => {
    const m = parseCookies('a=1; __Host-sid=first; b=2; __Host-sid=second');
    assert.equal(m.get('__Host-sid'), 'first');
    assert.equal(parseCookies(undefined).size, 0);
  });
  test('returnTo is a relative path on the same host', () => {
    assert.equal(safeReturnTo('/patients/123?x=1'), '/patients/123?x=1');
    for (const bad of [
      'https://evil.example/',
      '//evil.example',
      '/\\evil',
      'javascript:alert(1)',
      '/a\nb',
      '',
      undefined,
      5,
      ['/a'],
      `/${'a'.repeat(600)}`,
    ])
      assert.equal(safeReturnTo(bad), '/');
  });
});

describe('pre-authentication cookie (26.1, SEC01-F-11)', () => {
  const keys = { current: 'c'.repeat(40), previous: 'p'.repeat(40) };
  const st = {
    realm: 'google' as const,
    state: 's',
    nonce: 'n',
    verifier: 'v',
    returnTo: '/x',
    expiresAt: Date.now() + 60_000,
  };
  test('round trip, and it is not readable', () => {
    const sealed = sealOidcState(st, keys);
    assert.deepEqual(openOidcState(sealed, keys), st);
    assert.ok(!Buffer.from(sealed, 'base64url').toString('latin1').includes('"nonce"'));
  });
  test('tampering, truncation, wrong key and expiry are all just "no state"', () => {
    const sealed = sealOidcState(st, keys);
    const b = Buffer.from(sealed, 'base64url');
    b[b.length - 1] = (b[b.length - 1] ?? 0) ^ 1;
    assert.equal(openOidcState(b.toString('base64url'), keys), undefined);
    assert.equal(openOidcState(sealed.slice(0, 20), keys), undefined);
    assert.equal(openOidcState(sealed, { current: 'x'.repeat(40) }), undefined);
    assert.equal(openOidcState(sealed, keys, st.expiresAt + 1), undefined);
    assert.equal(openOidcState(undefined, keys), undefined);
    assert.equal(openOidcState('A'.repeat(5000), keys), undefined);
  });
  test('rotation: a cookie sealed under the previous key opens; new ones use the current key', () => {
    const old = sealOidcState(st, { current: keys.previous });
    assert.deepEqual(openOidcState(old, keys), st);
    assert.equal(openOidcState(sealOidcState(st, keys), { current: keys.previous }), undefined);
  });
  test('short keys are refused', () => {
    assert.throws(() => sealOidcState(st, { current: 'short' }));
  });
});
