// Unit tests of the admin-realm pieces that need no database: handle format (B2-6), the decoy list (SEC01-F-01), base64url
// strictness, the shape checks in front of the WebAuthn library, the attestation policy, and the request hash.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { b64urlDecode, b64urlEncode } from './b64.js';
import { decoyAllowCredentials, DECOY_ID_BYTES } from './decoy.js';
import { normaliseHandle } from './handle.js';
import { requestHashOf } from './service.js';
import { SoftKey } from './softkey.js';
import { parseAssertion, parseAttestation, SimpleWebAuthnPort } from './webauthn.js';

describe('handle (B2-6)', () => {
  test('lower-cases ASCII and applies the format', () => {
    assert.equal(normaliseHandle('Alice.Admin-01'), 'alice.admin-01');
    for (const bad of [
      '',
      'ab',
      '-abc',
      '.abc',
      'a b c',
      'ab/c',
      'x'.repeat(65),
      'jürgen',
      'adminK',
      'ａｄｍｉｎ',
      'admin\n',
      undefined,
      7,
      {},
    ])
      assert.equal(normaliseHandle(bad), undefined, String(bad));
    assert.equal(normaliseHandle('x'.repeat(64)), 'x'.repeat(64));
  });
});

describe('decoy allowCredentials (SEC01-F-01)', () => {
  test('is stable, keyed, one or two entries of the credential-ID length, and differs per handle and key', () => {
    const a = decoyAllowCredentials('key-one-key-one-key-one', 'alice.admin');
    assert.deepEqual(a, decoyAllowCredentials('key-one-key-one-key-one', 'alice.admin'));
    assert.ok(a.length === 1 || a.length === 2);
    for (const e of a) {
      assert.equal(e.id.length, DECOY_ID_BYTES);
      assert.deepEqual(e.transports, ['usb']);
    }
    assert.notDeepEqual(a, decoyAllowCredentials('key-two-key-two-key-two', 'alice.admin'));
    assert.notDeepEqual(a, decoyAllowCredentials('key-one-key-one-key-one', 'bob.admin'));
    const counts = new Set(
      Array.from(
        { length: 64 },
        (_, i) => decoyAllowCredentials('k'.repeat(24), `handle-${i}`).length,
      ),
    );
    assert.deepEqual([...counts].sort(), [1, 2], 'both shapes occur, as for real handles');
  });
});

describe('base64url', () => {
  test('rejects padding, other alphabets, non-canonical forms and oversize input', () => {
    const b = Buffer.from('hello world');
    assert.deepEqual(b64urlDecode(b64urlEncode(b), 64), b);
    for (const bad of ['aGVsbG8=', 'aGVsbG8+', 'a b', '', 'aGVsbG9', 'x'.repeat(200), 7, undefined])
      assert.equal(b64urlDecode(bad, 16), undefined, String(bad));
  });
});

describe('shape checks before the library', () => {
  const key = new SoftKey();
  const opts = { challenge: b64urlEncode(Buffer.alloc(32, 7)) };
  test('a well-formed assertion and attestation parse; anything else does not', () => {
    const assertion = key.assert(opts, {
      origin: 'https://staff.example.test',
      rpId: 'staff.example.test',
    });
    assert.ok(parseAssertion(assertion));
    assert.ok(
      parseAttestation(
        key.create(opts, { origin: 'https://staff.example.test', rpId: 'staff.example.test' }),
      ),
    );
    for (const bad of [
      null,
      'x',
      {},
      { ...assertion, id: 'AAAA' },
      { ...assertion, type: 'password' },
      { ...assertion, response: null },
      { ...assertion, response: { ...(assertion['response'] as object), signature: 'a=' } },
    ])
      assert.equal(parseAssertion(bad), undefined);
    const att = key.create(opts, {
      origin: 'https://staff.example.test',
      rpId: 'staff.example.test',
    });
    assert.equal(
      parseAttestation({
        ...att,
        response: { ...(att['response'] as object), transports: ['usb', 7] },
      }),
      undefined,
    );
    assert.equal(
      parseAttestation({
        ...att,
        response: { ...(att['response'] as object), transports: Array(9).fill('usb') },
      }),
      undefined,
    );
    assert.equal(parseAttestation({ ...att, response: { clientDataJSON: 'AAAA' } }), undefined);
  });
});

describe('ceremony configuration fails closed', () => {
  const params = {
    rpId: 'staff.example.test',
    rpName: 'x',
    expectedOrigins: ['https://staff.example.test'],
  };
  test('attestation mode "chain" needs roots; origins must be exact', () => {
    assert.throws(
      () => new SimpleWebAuthnPort(params, { mode: 'chain', rootCertificatesPem: [] }),
      /root certificate/,
    );
    assert.throws(
      () => new SimpleWebAuthnPort({ ...params, expectedOrigins: [] }, { mode: 'self_for_tests' }),
      /expected origin/,
    );
    for (const bad of [
      'staff.example.test',
      'https://*.example.test',
      'https://staff.example.test/',
      'ftp://staff.example.test',
      'http://staff.example.test',
    ])
      assert.throws(
        () =>
          new SimpleWebAuthnPort({ ...params, expectedOrigins: [bad] }, { mode: 'self_for_tests' }),
        /exact origin/,
        bad,
      );
    assert.doesNotThrow(() => new SimpleWebAuthnPort(params, { mode: 'self_for_tests' }));
  });

  test('chain mode refuses a self-attestation and fmt none', async () => {
    const dummyRoot =
      '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUXXXXXXXXXXXXXXXXXXXXXXXXXXswCgYIKoZIzj0EAwIw\n-----END CERTIFICATE-----\n';
    const port = new SimpleWebAuthnPort(params, {
      mode: 'chain',
      rootCertificatesPem: [dummyRoot],
    });
    const key = new SoftKey();
    const challenge = Buffer.alloc(32, 9);
    const att = key.create(
      { challenge: b64urlEncode(challenge) },
      { origin: 'https://staff.example.test', rpId: 'staff.example.test' },
    );
    assert.deepEqual(await port.verifyAttestation({ response: att, challenge }), { ok: false });
    const self = new SimpleWebAuthnPort(params, { mode: 'self_for_tests' });
    const ok = await self.verifyAttestation({ response: att, challenge });
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.key.hasChain, false);
  });
});

describe('request hash', () => {
  test('does not depend on the order the client listed roles, and does depend on every part', () => {
    const subject = '00000000-0000-4000-8000-000000000001';
    const a = [{ roleKey: 'org_admin' }, { roleKey: 'compliance_officer' }];
    const h1 = requestHashOf(subject, a, [], []);
    assert.deepEqual(h1, requestHashOf(subject, [...a].reverse(), [], []));
    assert.notDeepEqual(h1, requestHashOf(subject, a, [], [{ roleKey: 'org_admin' }]));
    assert.notDeepEqual(h1, requestHashOf('00000000-0000-4000-8000-000000000002', a, [], []));
    assert.notDeepEqual(h1, requestHashOf(subject, [], a, []));
    assert.equal(h1.length, 32);
  });
});
