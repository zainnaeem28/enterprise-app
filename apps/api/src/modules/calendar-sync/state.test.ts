import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  makeState,
  pkceChallenge,
  pkceVerifier,
  signingKey,
  STATE_LIFETIME_SECONDS,
  verifyState,
} from './state.js';
import { discardedMarker, sha256, tokenSecretName } from './ids.js';

const K1 = Buffer.from('state-key-one-0123456789abcdef0123');
const K2 = Buffer.from('state-key-two-0123456789abcdef0123');
const P = randomUUID();
const T0 = new Date('2031-05-01T10:00:00Z');

test('a state names the principal, expires in 10 minutes, and verifies under the current or the previous key', () => {
  const s = makeState(K1, P, T0);
  assert.equal(verifyState([K1], s, P, T0)?.principalId, P);
  assert.equal(verifyState([K2, K1], s, P, T0)?.principalId, P, 'previous key');
  assert.equal(verifyState([K2], s, P, T0), undefined, 'unknown key');
  assert.equal(verifyState([K1], s, randomUUID(), T0), undefined, 'another principal');
  assert.equal(verifyState([K1], s, P.toUpperCase(), T0)?.principalId, P, 'case does not matter');
  assert.ok(verifyState([K1], s, P, new Date(T0.getTime() + (STATE_LIFETIME_SECONDS - 1) * 1000)));
  assert.equal(
    verifyState([K1], s, P, new Date(T0.getTime() + STATE_LIFETIME_SECONDS * 1000)),
    undefined,
    'expired',
  );
});

test('a tampered, truncated, extended or non-string state never verifies', () => {
  const s = makeState(K1, P, T0);
  for (const bad of [
    s.slice(0, -1),
    `${s}x`,
    s.replace(/^v1\./, 'v2.'),
    s.replace(P, randomUUID()),
    '',
    'v1',
    'a'.repeat(300),
    undefined,
    null,
    5,
    {},
    [s],
  ])
    assert.equal(verifyState([K1], bad, P, T0), undefined, String(bad).slice(0, 20));
  const flipped = s.slice(0, -2) + (s.endsWith('AA') ? 'BB' : 'AA');
  assert.equal(verifyState([K1], flipped, P, T0), undefined);
  assert.notEqual(makeState(K1, P, T0), makeState(K1, P, T0), 'a fresh nonce each time');
});

test('PKCE: the derived verifier is stable, state-bound, key-bound, and S256 matches RFC 7636 appendix B', () => {
  const s = makeState(K1, P, T0);
  const v = pkceVerifier(K1, s);
  assert.equal(v, pkceVerifier(K1, s));
  assert.notEqual(v, pkceVerifier(K2, s));
  assert.notEqual(v, pkceVerifier(K1, makeState(K1, P, T0)));
  assert.match(v, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  );
  assert.deepEqual(signingKey([K2, K1], s), K1);
  assert.equal(signingKey([K2], s), undefined);
});

test('names and markers: the secret name is fixed by the principal; a discarded-token marker is UUID-shaped and stable', () => {
  assert.equal(tokenSecretName(P.toUpperCase()), `cal-${P}`);
  const m = discardedMarker(sha256('SYNC-TOKEN-1'));
  assert.match(m, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(m, discardedMarker(sha256('SYNC-TOKEN-1')));
  assert.notEqual(m, discardedMarker(sha256('SYNC-TOKEN-2')));
});
