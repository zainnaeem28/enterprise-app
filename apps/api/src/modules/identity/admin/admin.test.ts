// Unit tests of the admin-realm pieces that need no database: handle format (B2-6), the decoy list (SEC01-F-01), base64url
// strictness, the shape checks in front of the WebAuthn library, the attestation policy, and the request hash.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('attestation chain (BE05-R1-F07)', () => {
  const params = {
    rpId: 'staff.example.test',
    rpName: 'EHR staff',
    expectedOrigins: ['https://staff.example.test'],
  };
  const AAGUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  // Throw-away roots made at run time with the openssl CLI: nothing secret is committed.
  function pki(): {
    dir: string;
    rootPem: string;
    leafDer: Buffer;
    leafKey: ReturnType<typeof createPrivateKey>;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'be05-pki-'));
    const sh = (...args: string[]): void => {
      execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
    };
    sh('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'root.key');
    sh(
      'req',
      '-x509',
      '-new',
      '-key',
      'root.key',
      '-sha256',
      '-days',
      '30',
      '-subj',
      '/C=ZZ/O=Test Root/CN=Test Root',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign',
      '-out',
      'root.pem',
    );
    sh('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'leaf.key');
    sh(
      'req',
      '-new',
      '-key',
      'leaf.key',
      '-subj',
      '/C=ZZ/O=Test Vendor/OU=Authenticator Attestation/CN=Test Authenticator',
      '-out',
      'leaf.csr',
    );
    // An explicit extension file makes the leaf an X.509 v3 certificate on every OpenSSL (3.0 on the CI runner issues v1 without one).
    writeFileSync(
      join(dir, 'leaf.ext'),
      'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n',
    );
    sh(
      'x509',
      '-req',
      '-extfile',
      'leaf.ext',
      '-in',
      'leaf.csr',
      '-CA',
      'root.pem',
      '-CAkey',
      'root.key',
      '-CAcreateserial',
      '-days',
      '30',
      '-sha256',
      '-out',
      'leaf.pem',
    );
    sh('x509', '-in', 'leaf.pem', '-outform', 'DER', '-out', 'leaf.der');
    sh('pkcs8', '-topk8', '-nocrypt', '-in', 'leaf.key', '-out', 'leaf.p8');
    return {
      dir,
      rootPem: readFileSync(join(dir, 'root.pem'), 'utf8'),
      leafDer: readFileSync(join(dir, 'leaf.der')),
      leafKey: createPrivateKey(readFileSync(join(dir, 'leaf.p8'))),
    };
  }

  test('a packed attestation whose chain validates to a configured root is accepted; another root refuses it', async () => {
    const good = pki();
    const other = pki();
    try {
      const key = new SoftKey();
      const challenge = Buffer.alloc(32, 7);
      const att = key.create(
        { challenge: b64urlEncode(challenge) },
        {
          origin: 'https://staff.example.test',
          rpId: 'staff.example.test',
          aaguid: AAGUID,
          attestation: { x5c: [good.leafDer], key: good.leafKey },
        },
      );
      const ok = await new SimpleWebAuthnPort(params, {
        mode: 'chain',
        rootCertificatesPem: [good.rootPem],
      }).verifyAttestation({ response: att, challenge });
      assert.equal(ok.ok, true);
      if (ok.ok) {
        assert.equal(ok.key.hasChain, true);
        assert.equal(ok.key.fmt, 'packed');
        assert.equal(ok.key.aaguid.toLowerCase(), AAGUID);
      }
      const wrongRoot = await new SimpleWebAuthnPort(params, {
        mode: 'chain',
        rootCertificatesPem: [other.rootPem],
      }).verifyAttestation({ response: att, challenge });
      assert.deepEqual(wrongRoot, { ok: false });
    } finally {
      rmSync(good.dir, { recursive: true, force: true });
      rmSync(other.dir, { recursive: true, force: true });
    }
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
